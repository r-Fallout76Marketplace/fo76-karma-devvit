// Everything the app keeps in Redis. Keys, with usernames lowercased:
//
// - `karma` (hash): username to karma.
// - `profiles` (hash): username to the Market76 karma and gamertags, as JSON.
// - `rewards` (hash): `<postId>|<giver>|<receiver>` to the comment id of the
//   reward, for the once-per-pair rule. Rewards from the old bot's log are
//   not in `recorded`.
// - `recorded` (hash): comment id to the reward that command recorded.
// - `events` (sorted set): every reward as JSON, scored by its time. Kept as a
//   record: nothing reads it.
// - `history:<username>` (sorted set): the rewards a user gave or received,
//   for deleting a profile.
// - `given:<giver>:<YYYY-MM-DD>`: rewards given that UTC day, for the cap.
// - `answered:<commentId>`: the claim of a command comment.
// - `deleting` (hash): the placeholder of each profile deletion in progress.

import { DAY_MS } from './time';
import {
  emptyProfile,
  type Gamertag,
  type StoredReward,
  type Profile,
  type Reward,
  userKey,
} from './types';

type ZMember = { member: string; score: number };

export interface RedisTxPort {
  multi(): Promise<void>;
  exec(): Promise<unknown[] | null>;
  unwatch(): Promise<unknown>;
  hSet(key: string, fieldValues: { [field: string]: string }): Promise<unknown>;
  hIncrBy(key: string, field: string, value: number): Promise<unknown>;
  incrBy(key: string, value: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  zAdd(key: string, ...members: ZMember[]): Promise<unknown>;
}

/** The subset of the Devvit Redis client the store uses. */
export interface RedisPort {
  watch(...keys: string[]): Promise<RedisTxPort>;
  get(key: string): Promise<string | undefined>;
  set(
    key: string,
    value: string,
    options?: { nx?: boolean; expiration?: Date }
  ): Promise<string>;
  del(...keys: string[]): Promise<void>;
  zAdd(key: string, ...members: ZMember[]): Promise<number>;
  zRem(key: string, members: string[]): Promise<number>;
  zRange(
    key: string,
    start: number,
    stop: number,
    options: { by: 'rank' }
  ): Promise<ZMember[]>;
  hGet(key: string, field: string): Promise<string | undefined>;
  hSet(key: string, fieldValues: { [field: string]: string }): Promise<number>;
  hSetNX(key: string, field: string, value: string): Promise<number>;
  hDel(key: string, fields: string[]): Promise<number>;
  hIncrBy(key: string, field: string, value: number): Promise<number>;
}

/**
 * - `claimed`: this request is the first to handle the comment.
 * - `resumed`: an earlier attempt did not finish, and this request took it over.
 * - `busy`: another request is handling the comment right now.
 * - `done`: the comment was answered before.
 */
type ClaimResult = 'claimed' | 'resumed' | 'busy' | 'done';

type RecordResult =
  | { kind: 'recorded' }
  /** This very comment's reward is already on record. */
  | { kind: 'already-recorded' }
  | { kind: 'already-rewarded'; earlierCommentId: string }
  | { kind: 'cap' };

/** One line of a user's history: a reward they gave or received. */
type HistoryEntry = StoredReward & { kind: 'reward' };

const KARMA = 'karma';
const PROFILES = 'profiles';
const REWARDS = 'rewards';
const RECORDED = 'recorded';
const EVENTS = 'events';
const DELETING = 'deleting';

const ANSWERED_TTL_MS = 365 * DAY_MS;
const GIVEN_TTL_SECONDS = 2 * 24 * 60 * 60;
const PENDING = 'pending';
const DONE = 'done';
/** A request is killed after 30 seconds, so a pending claim older than this belongs to a dead attempt. */
export const IN_FLIGHT_MS = 45 * 1000;
/** Attempts at a transaction before giving up: each is lost only to another reward landing at the same moment. */
const TX_ATTEMPTS = 4;
/** Sorted sets written at once in a deletion. */
const PARALLEL = 25;
/** Fields or members per call when a deletion changes many. */
const CHUNK = 500;
const PLACEHOLDER_PREFIX = '[deleted-';

function isPlaceholder(name: string): boolean {
  return name.startsWith(PLACEHOLDER_PREFIX);
}

async function inGroups<T>(
  items: T[],
  size: number,
  run: (item: T) => Promise<unknown>
): Promise<void> {
  for (let i = 0; i < items.length; i += size)
    await Promise.all(items.slice(i, i + size).map(run));
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

const answeredKey = (commentId: string) => `answered:${commentId}`;
const givenKey = (giver: string, dayKey: string) =>
  `given:${userKey(giver)}:${dayKey}`;
const historyKey = (username: string) => `history:${userKey(username)}`;
const rewardField = (postId: string, giver: string, receiver: string) =>
  `${postId}|${userKey(giver)}|${userKey(receiver)}`;

/** Builds the JSON with a fixed key order, so the same reward is always the same sorted-set member. */
function rewardJson(reward: StoredReward): string {
  return JSON.stringify({
    commentId: reward.commentId,
    postId: reward.postId,
    giver: reward.giver,
    receiver: reward.receiver,
    sign: reward.sign,
    atMs: reward.atMs,
  });
}

function historyMember(reward: StoredReward): ZMember {
  const entry: HistoryEntry = {
    kind: 'reward',
    atMs: reward.atMs,
    commentId: reward.commentId,
    postId: reward.postId,
    giver: reward.giver,
    receiver: reward.receiver,
    sign: reward.sign,
  };
  return { member: JSON.stringify(entry), score: reward.atMs };
}

function parseReward(json: string): StoredReward {
  return JSON.parse(json) as StoredReward;
}

function parseInteger(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '0', 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function profileJson(profile: Profile): string {
  return JSON.stringify({
    redditUsername: profile.redditUsername,
    m76Karma: profile.m76Karma,
    gamertags: profile.gamertags,
  });
}

export class Store {
  constructor(
    private readonly redis: RedisPort,
    private readonly now: () => number = Date.now
  ) {}

  async loadProfile(username: string): Promise<Profile> {
    const key = userKey(username);
    const [karma, stored] = await Promise.all([
      this.redis.hGet(KARMA, key),
      this.redis.hGet(PROFILES, key),
    ]);
    if (karma === undefined && stored === undefined)
      return emptyProfile(username);
    const extra =
      stored === undefined
        ? undefined
        : (JSON.parse(stored) as {
            redditUsername: string;
            m76Karma: number;
            gamertags: Gamertag[];
          });
    return {
      redditUsername: extra?.redditUsername ?? username,
      karma: parseInteger(karma),
      m76Karma: extra?.m76Karma ?? 0,
      gamertags: extra?.gamertags ?? [],
    };
  }

  /** Writes the gamertags and Market76 karma, leaving the karma alone. */
  async saveDetails(profile: Profile): Promise<void> {
    await this.redis.hSet(PROFILES, {
      [userKey(profile.redditUsername)]: profileJson(profile),
    });
  }

  async addKarma(username: string, delta: number): Promise<number> {
    return this.redis.hIncrBy(KARMA, userKey(username), delta);
  }

  /**
   * Removes a profile and replaces its name with a placeholder in the partners'
   * histories and `events`. Returns the placeholder. Safe to run again after a
   * failure: the placeholder is kept until the end, new entries are added
   * before old ones go, and the user's history, which lists everything to
   * change, goes last.
   */
  async deleteProfile(username: string): Promise<string> {
    const key = userKey(username);
    await this.redis.hSetNX(
      DELETING,
      key,
      `${PLACEHOLDER_PREFIX}${crypto.randomUUID().slice(0, 8)}]`
    );
    // Undefined only when another deletion of the same user finished just now.
    const placeholder = await this.redis.hGet(DELETING, key);
    if (placeholder === undefined)
      throw new Error(`No placeholder could be kept for ${username}`);
    const rename = (name: string) =>
      userKey(name) === key ? placeholder : name;

    const rows = await this.redis.zRange(historyKey(key), 0, -1, {
      by: 'rank',
    });
    const pairFields = new Set<string>();
    const commentIds = new Set<string>();
    const oldEvents: string[] = [];
    const newEvents: ZMember[] = [];
    const partners = new Map<string, { old: string[]; renamed: ZMember[] }>();
    for (const row of rows) {
      // A history can hold entries of other kinds, such as moderator edits:
      // only rewards name a partner.
      const entry = JSON.parse(row.member) as { kind: string };
      if (entry.kind !== 'reward') continue;
      const reward = entry as HistoryEntry;
      const renamed = {
        ...reward,
        giver: rename(reward.giver),
        receiver: rename(reward.receiver),
      };
      pairFields.add(rewardField(reward.postId, reward.giver, reward.receiver));
      commentIds.add(reward.commentId);
      oldEvents.push(rewardJson(reward));
      newEvents.push({ member: rewardJson(renamed), score: reward.atMs });

      // The partner's history holds the same member as the user's own.
      const partner =
        userKey(reward.giver) === key ? reward.receiver : reward.giver;
      if (userKey(partner) === key || isPlaceholder(partner)) continue;
      const partnerKey = historyKey(partner);
      const changes = partners.get(partnerKey) ?? { old: [], renamed: [] };
      changes.old.push(row.member);
      changes.renamed.push(historyMember(renamed));
      partners.set(partnerKey, changes);
    }

    await inGroups([...partners], PARALLEL, async ([partnerKey, changes]) => {
      await this.redis.zAdd(partnerKey, ...changes.renamed);
      await this.redis.zRem(partnerKey, changes.old);
    });
    for (const group of chunks(newEvents, CHUNK))
      await this.redis.zAdd(EVENTS, ...group);
    for (const group of chunks(oldEvents, CHUNK))
      await this.redis.zRem(EVENTS, group);
    for (const group of chunks([...pairFields], CHUNK))
      await this.redis.hDel(REWARDS, group);
    for (const group of chunks([...commentIds], CHUNK))
      await this.redis.hDel(RECORDED, group);

    await this.redis.hDel(PROFILES, [key]);
    await this.redis.hDel(KARMA, [key]);
    await this.redis.del(historyKey(key));
    await this.redis.hDel(DELETING, [key]);
    return placeholder;
  }

  /**
   * Claims a comment for handling. With `takeOver`, an attempt that is still
   * in flight is taken over too (a moderator's re-run).
   *
   * Writes a unique pending token with nx and reads it back, since the result
   * of `set` with nx is undocumented. The token carries its start time, which
   * tells an attempt that is still running from one that died.
   */
  async claim(
    commentId: string,
    options: { takeOver?: boolean } = {}
  ): Promise<ClaimResult> {
    const key = answeredKey(commentId);
    const expiration = new Date(this.now() + ANSWERED_TTL_MS);
    const mine = `${PENDING}:${this.now()}:${crypto.randomUUID()}`;
    await this.redis.set(key, mine, { nx: true, expiration });
    const value = await this.redis.get(key);
    if (value === mine) return 'claimed';
    if (value === DONE) return 'done';

    const startedMs = Number(value?.split(':')[1]);
    const inFlight =
      Number.isFinite(startedMs) && this.now() - startedMs < IN_FLIGHT_MS;
    if (inFlight && !options.takeOver) return 'busy';
    await this.redis.set(key, mine, { expiration });
    return 'resumed';
  }

  async finish(commentId: string): Promise<void> {
    await this.redis.set(answeredKey(commentId), DONE, {
      expiration: new Date(this.now() + ANSWERED_TTL_MS),
    });
  }

  /** The comment id of the giver's earlier reward to the receiver in the post. */
  async earlierReward(
    postId: string,
    giver: string,
    receiver: string
  ): Promise<string | undefined> {
    return this.redis.hGet(REWARDS, rewardField(postId, giver, receiver));
  }

  async givenToday(giver: string, dayKey: string): Promise<number> {
    return parseInteger(await this.redis.get(givenKey(giver, dayKey)));
  }

  /** The reward a command comment recorded, if it recorded one in this app. */
  async recordedReward(commentId: string): Promise<Reward | undefined> {
    const stored = await this.redis.hGet(RECORDED, commentId);
    return stored === undefined ? undefined : (parseReward(stored) as Reward);
  }

  /**
   * Records a reward in one transaction, at most once per comment. With
   * `enforceLimits`, also once per pair and within the daily cap. A discarded
   * transaction means a watched key changed, so the checks run again.
   */
  async recordReward(
    reward: Reward,
    options: { enforceLimits: boolean; dayKey: string; dailyCap: number }
  ): Promise<RecordResult> {
    const field = rewardField(reward.postId, reward.giver, reward.receiver);
    const given = givenKey(reward.giver, options.dayKey);
    const json = rewardJson(reward);

    for (let attempt = 0; attempt < TX_ATTEMPTS; attempt++) {
      const tx = await this.redis.watch(REWARDS, RECORDED, given);
      let refusal: RecordResult | undefined;
      try {
        refusal = await this.refusalFor(reward, field, given, options);
      } catch (error) {
        await tx.unwatch().catch(() => undefined);
        throw error;
      }
      if (refusal) {
        await tx.unwatch();
        return refusal;
      }

      await tx.multi();
      await tx.hSet(REWARDS, { [field]: reward.commentId });
      await tx.hSet(RECORDED, { [reward.commentId]: json });
      await tx.hIncrBy(KARMA, userKey(reward.receiver), reward.sign);
      await tx.incrBy(given, 1);
      await tx.expire(given, GIVEN_TTL_SECONDS);
      await tx.zAdd(EVENTS, { member: json, score: reward.atMs });
      await tx.zAdd(historyKey(reward.giver), historyMember(reward));
      if (userKey(reward.giver) !== userKey(reward.receiver)) {
        await tx.zAdd(historyKey(reward.receiver), historyMember(reward));
      }
      // A transaction discarded because a watched key changed returns no replies:
      // an empty list, or null.
      const replies = await tx.exec();
      if (replies && replies.length > 0) return { kind: 'recorded' };
    }
    throw new Error(
      `The reward transaction for ${field} was discarded ${TX_ATTEMPTS} times`
    );
  }

  /** Why this reward must not be written, if anything says so. Read while the keys are watched. */
  private async refusalFor(
    reward: Reward,
    field: string,
    given: string,
    options: { enforceLimits: boolean; dailyCap: number }
  ): Promise<RecordResult | undefined> {
    const [recorded, pair] = await Promise.all([
      this.redis.hGet(RECORDED, reward.commentId),
      this.redis.hGet(REWARDS, field),
    ]);
    // A reward from the old bot's log is not in `recorded`.
    if (recorded !== undefined || pair === reward.commentId)
      return { kind: 'already-recorded' };
    if (!options.enforceLimits) return undefined;
    if (pair !== undefined)
      return { kind: 'already-rewarded', earlierCommentId: pair };
    const count = parseInteger(await this.redis.get(given));
    return count >= options.dailyCap ? { kind: 'cap' } : undefined;
  }
}
