import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isTradingFlair, judgeClose, judgeKarma } from './checks';
import type { CloseSnapshot, KarmaSnapshot, Party } from './types';

const config = { tradingFlairs: ['XBOX', 'PlayStation', 'PC'], dailyCap: 10 };

const party = (name: string, role: Partial<Party> = {}): Party => ({
  name,
  isMod: false,
  isCourier: false,
  ...role,
});

/** Alice (OP) and Bob trade under Alice's post; Bob gives karma to Alice. */
function snapshot(overrides: Partial<KarmaSnapshot> = {}): KarmaSnapshot {
  return {
    kind: 'give',
    giver: party('Bob'),
    parent: { author: party('Alice'), removed: false, isPost: false },
    post: { author: party('Alice'), removed: false, flairText: 'PC' },
    earlierCommentId: undefined,
    givenToday: 0,
    ...overrides,
  };
}

test('isTradingFlair ignores case and surrounding spaces', () => {
  assert.equal(isTradingFlair(' xbox ', config.tradingFlairs), true);
  assert.equal(isTradingFlair('playstation', config.tradingFlairs), true);
  assert.equal(isTradingFlair('Discussion', config.tradingFlairs), false);
  assert.equal(isTradingFlair('', config.tradingFlairs), false);
});

test('a plain exchange passes', () => {
  assert.deepEqual(judgeKarma(snapshot(), config), {
    kind: 'pass',
    receiver: 'Alice',
    sign: 1,
    enforceLimits: true,
  });
});

test('moderators skip every check', () => {
  const mod = party('Mod', { isMod: true });
  const odd = snapshot({
    giver: mod,
    parent: { author: party('Alice'), removed: true, isPost: true },
    post: { author: undefined, removed: true, flairText: 'Discussion' },
    earlierCommentId: 't1_old',
    givenToday: 99,
  });
  assert.deepEqual(judgeKarma(odd, config), {
    kind: 'pass',
    receiver: 'Alice',
    sign: 1,
    enforceLimits: false,
  });
  assert.deepEqual(judgeKarma({ ...odd, kind: 'take' }, config), {
    kind: 'pass',
    receiver: 'Alice',
    sign: -1,
    enforceLimits: false,
  });
  const self = snapshot({
    giver: mod,
    parent: { author: mod, removed: false, isPost: false },
  });
  assert.equal(judgeKarma(self, config).kind, 'pass', 'rewarding themselves');
});

test('a moderator with a deleted parent is refused as removed', () => {
  const verdict = judgeKarma(
    snapshot({
      giver: party('Mod', { isMod: true }),
      parent: { author: undefined, removed: false, isPost: false },
    }),
    config
  );
  assert.deepEqual(verdict, { kind: 'refuse', reason: 'removed' });
});

test('take from a non-moderator is unauthorized', () => {
  assert.deepEqual(judgeKarma(snapshot({ kind: 'take' }), config), {
    kind: 'refuse',
    reason: 'unauthorized',
  });
});

test('a non-trading post is refused', () => {
  const s = snapshot({
    post: { author: party('Alice'), removed: false, flairText: 'Discussion' },
  });
  assert.deepEqual(judgeKarma(s, config), {
    kind: 'refuse',
    reason: 'wrong-post-type',
  });
});

test('rewarding yourself is refused, comparing names ignoring case', () => {
  const s = snapshot({ giver: party('ALICE') });
  assert.deepEqual(judgeKarma(s, config), { kind: 'refuse', reason: 'self' });
});

test('self wins over top-level when the OP commands on their own post, removed or not', () => {
  for (const removed of [false, true]) {
    const s = snapshot({
      giver: party('Alice'),
      parent: { author: party('Alice'), removed, isPost: true },
    });
    assert.deepEqual(judgeKarma(s, config), { kind: 'refuse', reason: 'self' });
  }
});

test('the wrong post type wins over self', () => {
  const s = snapshot({
    giver: party('Alice'),
    post: { author: party('Alice'), removed: false, flairText: 'Discussion' },
  });
  assert.deepEqual(judgeKarma(s, config), {
    kind: 'refuse',
    reason: 'wrong-post-type',
  });
});

test('a top-level command is refused', () => {
  const s = snapshot({
    parent: { author: party('Alice'), removed: false, isPost: true },
  });
  assert.deepEqual(judgeKarma(s, config), {
    kind: 'refuse',
    reason: 'top-level',
  });
});

test('deleted or removed content is refused', () => {
  const cases: Partial<KarmaSnapshot>[] = [
    { parent: { author: undefined, removed: false, isPost: false } },
    { parent: { author: party('Alice'), removed: true, isPost: false } },
    { post: { author: undefined, removed: false, flairText: 'PC' } },
    { post: { author: party('Alice'), removed: true, flairText: 'PC' } },
  ];
  for (const overrides of cases) {
    assert.deepEqual(judgeKarma(snapshot(overrides), config), {
      kind: 'refuse',
      reason: 'removed',
    });
  }
});

test('three distinct people are too many', () => {
  const s = snapshot({
    post: { author: party('Carol'), removed: false, flairText: 'PC' },
  });
  assert.deepEqual(judgeKarma(s, config), {
    kind: 'refuse',
    reason: 'too-many-users',
  });
});

test('names are compared ignoring case when counting users', () => {
  const s = snapshot({
    post: { author: party('alice'), removed: false, flairText: 'PC' },
  });
  assert.equal(judgeKarma(s, config).kind, 'pass');
});

test('the receiver rewarding the post author under a stranger post is too many', () => {
  const s = snapshot({
    giver: party('Bob'),
    parent: { author: party('Dave'), removed: false, isPost: false },
    post: { author: party('Carol'), removed: false, flairText: 'PC' },
  });
  assert.deepEqual(judgeKarma(s, config), {
    kind: 'refuse',
    reason: 'too-many-users',
  });
});

test('a courier giver under a stranger post passes the user count', () => {
  const s = snapshot({
    giver: party('Bob', { isCourier: true }),
    post: { author: party('Carol'), removed: false, flairText: 'PC' },
  });
  assert.equal(judgeKarma(s, config).kind, 'pass');
});

test('a non-moderator rewarding a courier under someone else post passes the user count', () => {
  const s = snapshot({
    parent: {
      author: party('Courier', { isCourier: true }),
      removed: false,
      isPost: false,
    },
    post: { author: party('Carol'), removed: false, flairText: 'PC' },
  });
  assert.deepEqual(judgeKarma(s, config), {
    kind: 'pass',
    receiver: 'Courier',
    sign: 1,
    enforceLimits: true,
  });
});

test('a moderator post author is not counted', () => {
  const s = snapshot({
    giver: party('Bob'),
    parent: { author: party('Dave'), removed: false, isPost: false },
    post: {
      author: party('Mod', { isMod: true }),
      removed: false,
      flairText: 'PC',
    },
  });
  assert.equal(judgeKarma(s, config).kind, 'pass');
});

test('an earlier reward is refused with its comment id', () => {
  assert.deepEqual(
    judgeKarma(snapshot({ earlierCommentId: 't1_old' }), config),
    {
      kind: 'refuse',
      reason: 'already-rewarded',
      earlierCommentId: 't1_old',
    }
  );
});

test('the daily cap is refused at the cap, not below it', () => {
  assert.equal(judgeKarma(snapshot({ givenToday: 9 }), config).kind, 'pass');
  assert.deepEqual(judgeKarma(snapshot({ givenToday: 10 }), config), {
    kind: 'refuse',
    reason: 'cap',
  });
});

test('already-rewarded comes before the cap', () => {
  const s = snapshot({ earlierCommentId: 't1_old', givenToday: 50 });
  assert.deepEqual(judgeKarma(s, config), {
    kind: 'refuse',
    reason: 'already-rewarded',
    earlierCommentId: 't1_old',
  });
});

function closing(overrides: Partial<CloseSnapshot> = {}): CloseSnapshot {
  return {
    author: 'Alice',
    authorIsMod: false,
    postAuthor: 'Alice',
    flairText: 'PC',
    ...overrides,
  };
}

test('the OP can close a trading post', () => {
  assert.deepEqual(judgeClose(closing(), config), { kind: 'pass' });
  assert.deepEqual(judgeClose(closing({ author: 'ALICE' }), config), {
    kind: 'pass',
  });
});

test('a moderator can close any post', () => {
  const s = closing({
    author: 'Mod',
    authorIsMod: true,
    flairText: 'Discussion',
  });
  assert.deepEqual(judgeClose(s, config), { kind: 'pass' });
});

test('someone else cannot close the post', () => {
  const notOp = { kind: 'refuse', reason: 'not-op' };
  assert.deepEqual(judgeClose(closing({ author: 'Bob' }), config), notOp);
  assert.deepEqual(
    judgeClose(closing({ postAuthor: undefined }), config),
    notOp
  );
  assert.deepEqual(
    judgeClose(closing({ author: 'Bob', flairText: 'Discussion' }), config),
    notOp,
    'not-op comes before not-trading'
  );
});

test('the OP cannot close a non-trading post', () => {
  const s = closing({ flairText: 'Discussion' });
  assert.deepEqual(judgeClose(s, config), {
    kind: 'refuse',
    reason: 'not-trading',
  });
});
