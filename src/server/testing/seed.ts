// Writes data straight into the fake Redis in the formats the store keeps,
// for tests that start from data the app did not write itself: profiles and
// rewards from the old bot, and day counts.

import { userKey, type StoredReward, type Profile } from '../types';
import type { FakeRedis } from './fake-redis';

export async function seedProfile(
  redis: FakeRedis,
  profile: Profile
): Promise<void> {
  const key = userKey(profile.redditUsername);
  await redis.hSet('karma', { [key]: String(profile.karma) });
  await redis.hSet('profiles', {
    [key]: JSON.stringify({
      redditUsername: profile.redditUsername,
      m76Karma: profile.m76Karma,
      gamertags: profile.gamertags,
    }),
  });
}

/**
 * A reward from the old bot's log: in the pair index, the events and both
 * histories, but not in `recorded`.
 */
export async function seedOldReward(
  redis: FakeRedis,
  reward: StoredReward
): Promise<void> {
  const { commentId, postId, giver, receiver, sign, atMs } = reward;
  await redis.hSet('rewards', {
    [`${postId}|${userKey(giver)}|${userKey(receiver)}`]: commentId,
  });
  await redis.zAdd('events', {
    member: JSON.stringify({ commentId, postId, giver, receiver, sign, atMs }),
    score: atMs,
  });
  const history = {
    member: JSON.stringify({
      kind: 'reward',
      atMs,
      commentId,
      postId,
      giver,
      receiver,
      sign,
    }),
    score: atMs,
  };
  await redis.zAdd(`history:${userKey(giver)}`, history);
  if (userKey(giver) !== userKey(receiver))
    await redis.zAdd(`history:${userKey(receiver)}`, history);
}

/** Sets the number of rewards a giver has made on a UTC day. */
export async function seedGivenToday(
  redis: FakeRedis,
  giver: string,
  dayKey: string,
  count: number
): Promise<void> {
  await redis.set(`given:${userKey(giver)}:${dayKey}`, String(count));
}
