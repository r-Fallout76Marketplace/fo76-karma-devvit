// An in-memory stand-in for the Devvit Redis client: what the store uses, and
// readers for tests.

import type { RedisPort, RedisTxPort } from '../store';
import type { StoredReward } from '../types';

type ZMember = { member: string; score: number };
export class FakeRedis implements RedisPort {
  private readonly strings = new Map<string, string>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly zsets = new Map<string, Map<string, number>>();
  private readonly expiries = new Map<string, number>();
  private readonly versions = new Map<string, number>();

  /** Runs once at the start of the next `exec()`, to simulate another request writing in between. */
  beforeExec: (() => Promise<void>) | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  version(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  /** What `exec()` returns for a discarded transaction: the store accepts either. */
  discardedAs: [] | null = [];

  /** Marks a key as written, so transactions watching it are discarded. */
  private touch(key: string): void {
    this.versions.set(key, this.version(key) + 1);
  }

  /** Drops the key if its expiry has passed. */
  private live(key: string): void {
    const expiresAt = this.expiries.get(key);
    if (expiresAt !== undefined && expiresAt <= this.now()) this.drop(key);
  }

  private drop(key: string): void {
    this.strings.delete(key);
    this.hashes.delete(key);
    this.zsets.delete(key);
    this.expiries.delete(key);
    this.touch(key);
  }

  private hash(key: string): Map<string, string> {
    this.live(key);
    let hash = this.hashes.get(key);
    if (hash === undefined) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    return hash;
  }

  private zset(key: string): Map<string, number> {
    this.live(key);
    let zset = this.zsets.get(key);
    if (zset === undefined) {
      zset = new Map();
      this.zsets.set(key, zset);
    }
    return zset;
  }

  async watch(...keys: string[]): Promise<RedisTxPort> {
    return new FakeTx(
      this,
      new Map(keys.map((key) => [key, this.version(key)]))
    );
  }

  async get(key: string): Promise<string | undefined> {
    this.live(key);
    return this.strings.get(key);
  }

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean; expiration?: Date }
  ): Promise<string> {
    this.live(key);
    const exists = this.strings.has(key);
    if (options?.nx && exists) return '';
    this.strings.set(key, value);
    if (options?.expiration)
      this.expiries.set(key, options.expiration.getTime());
    else this.expiries.delete(key);
    this.touch(key);
    return 'OK';
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) this.drop(key);
  }

  async incrBy(key: string, value: number): Promise<number> {
    this.live(key);
    const next = Number.parseInt(this.strings.get(key) ?? '0', 10) + value;
    this.strings.set(key, String(next));
    this.touch(key);
    return next;
  }

  async expire(key: string, seconds: number): Promise<void> {
    this.live(key);
    if (this.strings.has(key) || this.hashes.has(key) || this.zsets.has(key)) {
      this.expiries.set(key, this.now() + seconds * 1000);
    }
  }

  async zAdd(key: string, ...members: ZMember[]): Promise<number> {
    if (members.length === 0) throw new Error('zAdd with no members');
    const zset = this.zset(key);
    let added = 0;
    for (const { member, score } of members) {
      if (!zset.has(member)) added++;
      zset.set(member, score);
    }
    this.touch(key);
    return added;
  }

  async zRange(key: string, start: number, stop: number): Promise<ZMember[]> {
    const sorted = [...this.zset(key)]
      .map(([member, score]) => ({ member, score }))
      .sort(
        (a, b) =>
          a.score - b.score ||
          (a.member < b.member ? -1 : a.member > b.member ? 1 : 0)
      );
    const from = start < 0 ? sorted.length + start : start;
    const to = stop < 0 ? sorted.length + stop : stop;
    return sorted.slice(Math.max(from, 0), to + 1);
  }

  async zRem(key: string, members: string[]): Promise<number> {
    this.live(key);
    const zset = this.zsets.get(key);
    if (zset === undefined) return 0;
    let removed = 0;
    for (const member of members) if (zset.delete(member)) removed++;
    this.touch(key);
    return removed;
  }

  async hGet(key: string, field: string): Promise<string | undefined> {
    this.live(key);
    return this.hashes.get(key)?.get(field);
  }

  async hSet(
    key: string,
    fieldValues: { [field: string]: string }
  ): Promise<number> {
    if (Object.keys(fieldValues).length === 0)
      throw new Error('hSet with no fields');
    const hash = this.hash(key);
    let added = 0;
    for (const [field, value] of Object.entries(fieldValues)) {
      if (!hash.has(field)) added++;
      hash.set(field, value);
    }
    this.touch(key);
    return added;
  }

  async hSetNX(key: string, field: string, value: string): Promise<number> {
    const hash = this.hash(key);
    if (hash.has(field)) return 0;
    hash.set(field, value);
    this.touch(key);
    return 1;
  }

  async hDel(key: string, fields: string[]): Promise<number> {
    this.live(key);
    const hash = this.hashes.get(key);
    if (hash === undefined) return 0;
    let removed = 0;
    for (const field of fields) if (hash.delete(field)) removed++;
    if (hash.size === 0) this.hashes.delete(key);
    this.touch(key);
    return removed;
  }

  async hIncrBy(key: string, field: string, value: number): Promise<number> {
    const hash = this.hash(key);
    const next = Number.parseInt(hash.get(field) ?? '0', 10) + value;
    hash.set(field, String(next));
    this.touch(key);
    return next;
  }
}

/** The reward entries of a user's history, oldest first, read from the store's `history:` key. */
export async function historyOf(
  redis: FakeRedis,
  username: string
): Promise<StoredReward[]> {
  const rows = await redis.zRange(`history:${username.toLowerCase()}`, 0, -1);
  return rows.map((row) => JSON.parse(row.member) as StoredReward);
}

/** Every reward in the store's `events` key, oldest first. */
export async function eventsOf(redis: FakeRedis): Promise<StoredReward[]> {
  const rows = await redis.zRange('events', 0, -1);
  return rows.map((row) => JSON.parse(row.member) as StoredReward);
}

class FakeTx implements RedisTxPort {
  private queue: (() => Promise<unknown>)[] | undefined;

  constructor(
    private readonly redis: FakeRedis,
    private readonly watched: Map<string, number>
  ) {}

  private enqueue(command: () => Promise<unknown>): Promise<unknown> {
    if (this.queue === undefined)
      throw new Error('Command queued before multi()');
    this.queue.push(command);
    return Promise.resolve(this);
  }

  async multi(): Promise<void> {
    this.queue = [];
  }

  async unwatch(): Promise<unknown> {
    this.watched.clear();
    return this;
  }

  /** Applies the queue unless a watched key changed since `watch`, in which case it returns no replies. */
  async exec(): Promise<unknown[] | null> {
    const hook = this.redis.beforeExec;
    this.redis.beforeExec = undefined;
    if (hook) await hook();
    const queue = this.queue ?? [];
    this.queue = undefined;
    for (const [key, version] of this.watched) {
      if (this.redis.version(key) !== version) return this.redis.discardedAs;
    }
    const results: unknown[] = [];
    for (const command of queue) results.push(await command());
    return results;
  }

  hSet(key: string, fieldValues: { [field: string]: string }) {
    return this.enqueue(() => this.redis.hSet(key, fieldValues));
  }
  hIncrBy(key: string, field: string, value: number) {
    return this.enqueue(() => this.redis.hIncrBy(key, field, value));
  }
  incrBy(key: string, value: number) {
    return this.enqueue(() => this.redis.incrBy(key, value));
  }
  expire(key: string, seconds: number) {
    return this.enqueue(() => this.redis.expire(key, seconds));
  }
  zAdd(key: string, ...members: ZMember[]) {
    return this.enqueue(() => this.redis.zAdd(key, ...members));
  }
}
