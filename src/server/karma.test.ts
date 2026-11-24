import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CommandSource } from './commands';
import { handleCommand, type Outcome } from './karma';
import { IN_FLIGHT_MS } from './store';
import { DAY, T0, TEST_CONFIG, testPorts } from './testing/ports';
import { seedGivenToday, seedOldReward, seedProfile } from './testing/seed';
import type { CommentInfo, Config, PostInfo } from './types';

const CAP = TEST_CONFIG.dailyCap;

function post(id: string, overrides: Partial<PostInfo> = {}): PostInfo {
  return {
    id,
    authorName: 'OP',
    flairText: 'PC',
    removed: false,
    ...overrides,
  };
}

function comment(
  id: string,
  authorName: string | undefined,
  body: string,
  overrides: Partial<CommentInfo> = {}
): CommentInfo {
  return {
    id,
    authorName,
    body,
    parentId: 't3_p1',
    postId: 't3_p1',
    removed: false,
    ...overrides,
  };
}

/**
 * A trading post t3_p1 by OP, flaired PC, with a top-level comment t1_c1 by
 * Trader. Commands are added with `command` and run with `run`.
 */
function setup(configOverrides: Partial<Config> = {}) {
  const t = testPorts(configOverrides);
  t.reddit.addPost(post('t3_p1'));
  t.reddit.addComment(comment('t1_c1', 'Trader', 'I have it'));

  /** Adds a command comment and returns its id. */
  function command(
    id: string,
    author: string | undefined,
    body: string,
    overrides: Partial<CommentInfo> = {}
  ): string {
    t.reddit.addComment(comment(id, author, body, overrides));
    return id;
  }

  function result(commentId: string, source: CommandSource = 'create') {
    return handleCommand({ commentId, source }, t.ports);
  }

  async function run(
    commentId: string,
    source: CommandSource = 'create'
  ): Promise<Outcome> {
    return (await result(commentId, source)).outcome;
  }

  return {
    ...t,
    /** The log lines that report a failure. */
    problems: () =>
      t.log.filter((line) => / failed: |could not be set/.test(line)),
    karmaOf: async (name: string) => (await t.store.loadProfile(name)).karma,
    command,
    result,
    run,
  };
}

type Setup = ReturnType<typeof setup>;

function assertFooter(text: string | undefined): void {
  assert.ok(text?.includes('performed by a bot'), text);
  assert.ok(text?.endsWith(`[See disclaimer](${TEST_CONFIG.disclaimerUrl}))`));
}

/** OP replies "+karma" to Trader's comment. */
function opRewards(s: Setup, id = 't1_cmd'): string {
  return s.command(id, 'OP', '+karma', { parentId: 't1_c1' });
}

/** A moderator, Mod, replies with `body` to Trader's comment. */
function modCommands(s: Setup, id = 't1_cmd', body = '+karma'): string {
  s.reddit.moderators = new Set(['mod']);
  return s.command(id, 'Mod', body, { parentId: 't1_c1' });
}

test('OP rewarding Trader gives a point, a flair, a reply and records it', async () => {
  const s = setup();
  const id = opRewards(s);

  assert.equal(await s.run(id), 'rewarded');

  assert.equal(await s.karmaOf('Trader'), 1);
  assert.deepEqual(s.reddit.flairs, [
    { username: 'Trader', text: 'Karma: 1', templateId: 't0' },
  ]);
  assert.equal(s.reddit.replies.length, 1);
  const [sent] = s.reddit.replies;
  assert.deepEqual(sent?.target, { kind: 'comment', id });
  assert.ok(sent?.text.includes('u/OP'));
  assert.ok(sent?.text.includes('u/Trader'));
  assertFooter(sent?.text);
  assert.equal(await s.store.earlierReward('t3_p1', 'OP', 'Trader'), id);
  assert.equal(await s.store.givenToday('OP', DAY), 1);
  assert.equal(await s.run(id), 'already-handled');
});

test('a comment that is not a command', async () => {
  const s = setup();
  assert.equal(await s.run('t1_c1'), 'not-a-command');
  assert.equal(s.reddit.replies.length, 0);
});

test('while disabled, a create or approve event does nothing but a rerun still runs', async () => {
  const s = setup({ enabled: false });
  const id = opRewards(s);
  assert.equal(await s.run(id, 'create'), 'disabled');
  assert.equal(await s.run(id, 'approve'), 'disabled');
  assert.equal(s.reddit.replies.length, 0);

  assert.equal(await s.run(id, 'rerun'), 'rewarded');
  assert.equal(await s.karmaOf('Trader'), 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.equal(s.reddit.flairs.length, 1);
});

test('commands by the app, AutoModerator or a deleted account are skipped', async () => {
  for (const [author, appName] of [
    ['Vault-TecTradingCo', 'Vault-TecTradingCo'],
    ['Vault-TecTradingCo', 'vault-tectradingco'],
    ['Vault-TecTradingCo', 'VAULT-TECTRADINGCO'],
    ['AutoModerator', 'Vault-TecTradingCo'],
    [undefined, 'Vault-TecTradingCo'],
  ] as const) {
    const s = setup();
    s.reddit.appName = appName;
    const id = s.command('t1_bot', author, '+karma', { parentId: 't1_c1' });
    assert.equal(await s.run(id), 'skipped', `${author} as ${appName}`);
    assert.equal(s.reddit.replies.length, 0);
    assert.equal(await s.karmaOf('Trader'), 0);
  }
});

test('a second run of the same command gives no second point or reply', async () => {
  const s = setup();
  const id = opRewards(s);
  assert.equal(await s.run(id), 'rewarded');
  assert.equal(await s.run(id), 'already-handled');
  assert.equal(await s.karmaOf('Trader'), 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.equal(s.reddit.flairs.length, 1);
});

test('rewarding the same person again in the same post is refused with a link to the first', async () => {
  const s = setup();
  const first = opRewards(s, 't1_cmd1');
  const second = opRewards(s, 't1_cmd2');
  assert.equal(await s.run(first), 'rewarded');

  assert.deepEqual(await s.result(second), {
    outcome: 'refused',
    reason: 'already-rewarded',
  });

  assert.equal(await s.karmaOf('Trader'), 1);
  assert.equal(s.reddit.replies.length, 2);
  const refusal = s.reddit.replies[1];
  assert.deepEqual(refusal?.target, { kind: 'comment', id: second });
  assert.ok(refusal?.text.includes('already rewarded Trader'));
  assert.ok(
    refusal?.text.includes('https://www.reddit.com/r/fo76/comments/p1/_/cmd1/')
  );
  assertFooter(refusal?.text);
  assert.equal(await s.store.earlierReward('t3_p1', 'OP', 'Trader'), first);
});

type RefusalCase = {
  name: string;
  reason: string;
  expectText: string;
  arrange: (s: Setup) => string | Promise<string>;
};

const refusals: RefusalCase[] = [
  {
    name: '-karma by a non-moderator',
    reason: 'unauthorized',
    expectText: 'only be subtracted by moderators',
    arrange: (s) => s.command('t1_cmd', 'OP', '-karma', { parentId: 't1_c1' }),
  },
  {
    name: 'a post without a trading flair',
    reason: 'wrong-post-type',
    expectText: 'under a trading post',
    arrange: (s) => {
      s.reddit.addPost(post('t3_p2', { flairText: 'Discussion' }));
      s.command('t1_d1', 'Trader', 'hi', {
        parentId: 't3_p2',
        postId: 't3_p2',
      });
      return s.command('t1_cmd', 'OP', '+karma', {
        parentId: 't1_d1',
        postId: 't3_p2',
      });
    },
  },
  {
    name: 'rewarding yourself',
    reason: 'self',
    expectText: 'cannot reward yourself',
    arrange: (s) => {
      s.command('t1_own', 'OP', 'mine');
      return s.command('t1_cmd', 'OP', '+karma', { parentId: 't1_own' });
    },
  },
  {
    name: 'a top-level command',
    reason: 'top-level',
    expectText: 'you need to reply to a comment',
    arrange: (s) =>
      s.command('t1_cmd', 'Trader', '+karma', { parentId: 't3_p1' }),
  },
  {
    name: 'a removed parent comment',
    reason: 'removed',
    expectText: 'is gone',
    arrange: (s) => {
      s.command('t1_rm', 'Trader', 'gone', { removed: true });
      return s.command('t1_cmd', 'OP', '+karma', { parentId: 't1_rm' });
    },
  },
  {
    name: 'a deleted parent author',
    reason: 'removed',
    expectText: 'is gone',
    arrange: (s) => {
      s.command('t1_del', undefined, 'gone');
      return s.command('t1_cmd', 'OP', '+karma', { parentId: 't1_del' });
    },
  },
  {
    name: 'a deleted parent author, for a moderator',
    reason: 'removed',
    expectText: 'is gone',
    arrange: (s) => {
      s.reddit.moderators = new Set(['mod']);
      s.command('t1_del', undefined, 'gone');
      return s.command('t1_cmd', 'Mod', '+karma', { parentId: 't1_del' });
    },
  },
  {
    name: 'a removed post',
    reason: 'removed',
    expectText: 'deleted their submission',
    arrange: (s) => {
      s.reddit.addPost(post('t3_p3', { removed: true }));
      s.command('t1_r1', 'Trader', 'hi', {
        parentId: 't3_p3',
        postId: 't3_p3',
      });
      return s.command('t1_cmd', 'OP', '+karma', {
        parentId: 't1_r1',
        postId: 't3_p3',
      });
    },
  },
  {
    name: 'a third user under the post',
    reason: 'too-many-users',
    expectText: "someone else's submission",
    arrange: (s) =>
      s.command('t1_cmd', 'Other', '+karma', { parentId: 't1_c1' }),
  },
  {
    name: 'the daily cap reached',
    reason: 'cap',
    expectText: 'karma reward limit',
    arrange: async (s) => {
      await seedGivenToday(s.redis, 'OP', DAY, CAP);
      return opRewards(s);
    },
  },
];

for (const { name, reason, expectText, arrange } of refusals) {
  test(`refusal: ${name}`, async () => {
    const s = setup();
    const id = await arrange(s);

    assert.deepEqual(await s.result(id), { outcome: 'refused', reason });

    assert.equal(s.reddit.replies.length, 1);
    const [sent] = s.reddit.replies;
    assert.deepEqual(sent?.target, { kind: 'comment', id });
    assert.ok(sent?.text.includes(expectText), sent?.text);
    assertFooter(sent?.text);
    assert.equal(s.reddit.flairs.length, 0);
    assert.equal(await s.karmaOf('Trader'), 0);
    assert.equal(await s.run(id), 'already-handled');
  });
}

test('a removed command comment is ignored without a claim, and runs once approved', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'OP', '+karma', {
    parentId: 't1_c1',
    removed: true,
  });

  assert.equal(await s.run(id), 'ignored');
  assert.equal(await s.run(id, 'rerun'), 'ignored');
  assert.equal(s.reddit.replies.length, 0);
  assert.equal(await s.karmaOf('Trader'), 0);

  s.reddit.addComment(
    comment(id, 'OP', '+karma', { parentId: 't1_c1', removed: false })
  );
  assert.equal(await s.run(id, 'approve'), 'rewarded');
  assert.equal(await s.karmaOf('Trader'), 1);
  assert.equal(s.reddit.replies.length, 1);
});

test('a moderator skips the checks: a top-level +karma goes to the post author', async () => {
  const s = setup();
  s.reddit.moderators = new Set(['mod']);
  const id = s.command('t1_cmd', 'Mod', '+karma', { parentId: 't3_p1' });

  assert.equal(await s.run(id), 'rewarded');

  assert.equal(await s.karmaOf('OP'), 1);
  assert.deepEqual(s.reddit.replies[0]?.target, { kind: 'comment', id });
  assert.equal(s.reddit.flairs[0]?.username, 'OP');
});

test('-karma by a moderator takes a point', async () => {
  const s = setup();
  const id = modCommands(s, 't1_cmd', '-karma');

  assert.equal(await s.run(id), 'rewarded');

  assert.equal(await s.karmaOf('Trader'), -1);
  assert.equal(s.reddit.flairs[0]?.text, 'Karma: -1');
  assert.equal(s.reddit.flairs[0]?.templateId, 't0');
  assert.ok(s.reddit.replies[0]?.text.includes('decremented'));
  assertFooter(s.reddit.replies[0]?.text);
});

test('a moderator is not held to the daily cap', async () => {
  for (const count of [CAP, CAP + 5]) {
    const s = setup();
    await seedGivenToday(s.redis, 'Mod', DAY, count);
    assert.equal(await s.run(modCommands(s)), 'rewarded', String(count));
    assert.equal(s.problems().length, 0);
    assert.equal(await s.store.givenToday('Mod', DAY), count + 1);
  }
});

test('a moderator rewarding the same pair twice gives two points, and reruns of either add none', async () => {
  const s = setup();
  const older = modCommands(s, 't1_cmd1');
  const newer = modCommands(s, 't1_cmd2');
  assert.equal(await s.run(older), 'rewarded');
  assert.equal(await s.run(newer), 'rewarded');
  assert.equal(await s.karmaOf('Trader'), 2);

  assert.equal(await s.run(older, 'rerun'), 'rewarded');
  assert.equal(await s.run(newer, 'rerun'), 'rewarded');

  assert.equal(await s.karmaOf('Trader'), 2);
  assert.equal(s.reddit.replies.length, 2);
});

test('a courier as a third party passes the two-party check', async () => {
  const s = setup();
  s.reddit.wiki.set(TEST_CONFIG.courierPage, 'couriers:\n  - Courier\n');
  const id = s.command('t1_cmd', 'Courier', '+karma', { parentId: 't1_c1' });

  assert.equal(await s.run(id), 'rewarded');

  assert.equal(await s.karmaOf('Trader'), 1);
  assert.equal(s.reddit.flairs[0]?.templateId, 't0');
});

test('a moderator receiver gets the mods and couriers template', async () => {
  const s = setup();
  s.reddit.moderators = new Set(['trader']);
  assert.equal(await s.run(opRewards(s)), 'rewarded');
  assert.deepEqual(s.reddit.flairs, [
    { username: 'Trader', text: 'Karma: 1', templateId: 'mods' },
  ]);
});

test('a courier receiver gets the mods and couriers template and the courier label', async () => {
  const s = setup();
  s.reddit.wiki.set(TEST_CONFIG.courierPage, 'couriers:\n  - trader\n');
  assert.equal(await s.run(opRewards(s)), 'rewarded');
  assert.deepEqual(s.reddit.flairs, [
    { username: 'Trader', text: 'Verified Courier: 1', templateId: 'mods' },
  ]);
});

test('a reply that fails on the comment falls back to the post', async () => {
  const s = setup();
  const id = opRewards(s);
  s.reddit.failNextReplyTo(id);

  assert.equal(await s.run(id), 'rewarded');

  assert.equal(s.reddit.replies.length, 1);
  assert.deepEqual(s.reddit.replies[0]?.target, { kind: 'post', id: 't3_p1' });
  assertFooter(s.reddit.replies[0]?.text);
  assert.equal(await s.karmaOf('Trader'), 1);
});

test('a command resumed after the transaction sends the reply and gives no second point', async () => {
  const s = setup();
  const id = opRewards(s);
  assert.equal(await s.store.claim(id), 'claimed');
  await s.store.recordReward(
    {
      commentId: id,
      postId: 't3_p1',
      giver: 'OP',
      receiver: 'Trader',
      sign: 1,
      atMs: T0,
    },
    { enforceLimits: true, dayKey: DAY, dailyCap: CAP }
  );
  assert.equal(await s.run(id), 'already-handled', 'the attempt is in flight');

  s.clock.now += IN_FLIGHT_MS + 1;
  assert.equal(await s.run(id), 'rewarded');

  assert.equal(await s.karmaOf('Trader'), 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.equal(s.reddit.flairs.length, 1);
  assert.equal(await s.run(id), 'already-handled');
});

test('a flair failure after the point is logged and the reply and finish still happen', async () => {
  const s = setup();
  const id = opRewards(s);
  s.reddit.failNext('setUserFlair');

  assert.equal(await s.run(id), 'rewarded');

  assert.equal(await s.karmaOf('Trader'), 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.equal(s.reddit.flairs.length, 0);
  assert.equal(s.problems().length, 1);
  assert.ok(s.problems()[0]?.startsWith(id));
  assert.ok(s.problems()[0]?.includes('setUserFlair failed'));
  assert.equal(await s.run(id), 'already-handled');
});

test('a rerun after a flair failure repairs the flair without a second point or reply', async () => {
  const s = setup();
  const id = opRewards(s);
  s.reddit.failNext('setUserFlair');
  assert.equal(await s.run(id), 'rewarded');
  assert.equal(s.reddit.flairs.length, 0);

  assert.equal(await s.run(id, 'rerun'), 'rewarded');

  assert.equal(await s.karmaOf('Trader'), 1);
  assert.deepEqual(s.reddit.flairs, [
    { username: 'Trader', text: 'Karma: 1', templateId: 't0' },
  ]);
  assert.equal(s.reddit.replies.length, 1);
});

test('a failed reply leaves the claim pending, and the command resumes later with one point and a reply', async () => {
  const s = setup();
  const id = opRewards(s);
  const restore = s.reddit.failUntilRestored(
    'replyLocked',
    new Error('reddit down')
  );

  const failed = await s.result(id);
  assert.equal(failed.outcome, 'failed');
  assert.match(
    failed.outcome === 'failed' ? failed.message : '',
    /^t1_cmd \(create\) failed: .*reddit down/
  );

  assert.equal(await s.karmaOf('Trader'), 1);
  assert.equal(s.reddit.replies.length, 0);
  assert.equal(s.problems().length, 1);
  assert.equal(await s.run(id), 'already-handled', 'still in flight');

  restore();
  s.clock.now += IN_FLIGHT_MS + 1;
  assert.equal(await s.run(id), 'rewarded');

  assert.equal(await s.karmaOf('Trader'), 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.ok(s.reddit.replies[0]?.text.includes('successfully rewarded'));
  assert.equal(await s.run(id), 'already-handled');
});

test('a moderator rerun picks up a failed command at once, and a second rerun adds nothing', async () => {
  const s = setup();
  const id = modCommands(s);
  const restore = s.reddit.failUntilRestored('replyLocked');
  assert.equal(await s.run(id), 'failed');
  restore();

  assert.equal(await s.run(id, 'rerun'), 'rewarded');
  assert.equal(await s.run(id, 'rerun'), 'rewarded');

  assert.equal(await s.karmaOf('Trader'), 1);
  assert.equal(s.reddit.replies.length, 1);
});

test('the resumed reward that reached the cap replies with success, not the cap refusal', async () => {
  const s = setup();
  await seedGivenToday(s.redis, 'OP', DAY, CAP - 1);
  const id = opRewards(s);
  const restore = s.reddit.failUntilRestored('replyLocked');
  assert.equal(await s.run(id), 'failed');
  assert.equal(await s.store.givenToday('OP', DAY), CAP);

  restore();
  s.clock.now += IN_FLIGHT_MS + 1;
  assert.equal(await s.run(id), 'rewarded');

  assert.equal(await s.karmaOf('Trader'), 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.ok(s.reddit.replies[0]?.text.includes('successfully rewarded'));
  assert.ok(!s.reddit.replies[0]?.text.includes('limit'));
  assert.equal(s.problems().length, 1, 'only the failed first attempt');
});

test('the reward that reaches the cap is given, and a rerun of it is still rewarded', async () => {
  const s = setup();
  await seedGivenToday(s.redis, 'OP', DAY, CAP - 1);
  const id = opRewards(s);

  assert.equal(await s.run(id), 'rewarded');
  assert.equal(await s.store.givenToday('OP', DAY), CAP);
  assert.equal(s.problems().length, 0);

  assert.equal(await s.run(id, 'rerun'), 'rewarded');
  assert.equal(s.reddit.replies.length, 1);
  assert.equal(await s.karmaOf('Trader'), 1);
});

test('two deliveries of one command at once give one point and one reply', async () => {
  const s = setup();
  const id = opRewards(s);

  const outcomes = await Promise.all([s.run(id), s.run(id, 'approve')]);

  assert.deepEqual([...outcomes].sort(), ['already-handled', 'rewarded']);
  assert.equal(await s.karmaOf('Trader'), 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.equal(s.reddit.flairs.length, 1);
});

test('two commands for the same pair at once give one point and one refusal', async () => {
  const s = setup();
  const first = opRewards(s, 't1_cmd1');
  const second = opRewards(s, 't1_cmd2');

  const outcomes = await Promise.all([s.run(first), s.run(second)]);

  assert.deepEqual([...outcomes].sort(), ['refused', 'rewarded']);
  assert.equal(await s.karmaOf('Trader'), 1);
  assert.equal(s.reddit.replies.length, 2);
  assert.equal(
    s.reddit.replies.filter((r) => r.text.includes('already rewarded')).length,
    1
  );
});

test('two commands at once from a giver one below the cap give one point and one cap refusal', async () => {
  const s = setup();
  s.reddit.addPost(post('t3_p2'));
  s.command('t1_c2', 'Trader', 'also here', {
    parentId: 't3_p2',
    postId: 't3_p2',
  });
  await seedGivenToday(s.redis, 'OP', DAY, CAP - 1);
  const first = opRewards(s, 't1_cmd1');
  const second = s.command('t1_cmd2', 'OP', '+karma', {
    parentId: 't1_c2',
    postId: 't3_p2',
  });

  const outcomes = await Promise.all([s.run(first), s.run(second)]);

  assert.deepEqual([...outcomes].sort(), ['refused', 'rewarded']);
  assert.equal(await s.karmaOf('Trader'), 1);
  assert.equal(await s.store.givenToday('OP', DAY), CAP);
  assert.equal(
    s.reddit.replies.filter((r) => r.text.includes('karma reward limit'))
      .length,
    1
  );
  assert.equal(s.problems().length, 0);
});

test('a rerun of a finished rewarded command sets the flair again and sends no second reply', async () => {
  const s = setup();
  const id = opRewards(s);
  assert.equal(await s.run(id), 'rewarded');

  assert.equal(await s.run(id, 'rerun'), 'rewarded');

  assert.equal(await s.karmaOf('Trader'), 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.equal(s.reddit.flairs.length, 2);
  assert.equal(s.problems().length, 0);
});

test('a rerun of a finished refusal is judged and replied to again', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'Trader', '+karma', { parentId: 't3_p1' });
  assert.equal(await s.run(id), 'refused');
  assert.equal(s.reddit.replies.length, 1);

  assert.equal(await s.run(id, 'rerun'), 'refused');

  assert.equal(s.reddit.replies.length, 2);
  assert.equal(await s.karmaOf('OP'), 0);
});

test('a rerun of a command the old bot already rewarded gives no point and no reply', async () => {
  const s = setup();
  const id = opRewards(s, 't1_old');
  await seedProfile(s.redis, {
    redditUsername: 'Trader',
    karma: 7,
    m76Karma: 0,
    gamertags: [],
  });
  await seedOldReward(s.redis, {
    commentId: id,
    postId: 't3_p1',
    giver: 'OP',
    receiver: 'Trader',
    sign: 0,
    atMs: T0 - 1000,
  });

  assert.equal(await s.run(id, 'rerun'), 'rewarded');
  assert.equal(await s.karmaOf('Trader'), 7);
  assert.equal(s.reddit.replies.length, 0);
  assert.deepEqual(
    s.reddit.flairs.map((flair) => flair.text),
    ['Karma: 7']
  );
});

test('a failed comment fetch is logged and claims nothing', async () => {
  const s = setup();
  const id = opRewards(s);
  s.reddit.failNext('getComment');

  assert.equal(await s.run(id), 'failed');

  assert.equal(s.problems().length, 1);
  assert.ok(s.problems()[0]?.includes(id));
  assert.equal(s.reddit.replies.length, 0);
  assert.equal(await s.run(id), 'rewarded', 'nothing was claimed');
});

test('a failed post fetch is logged and the command resumes later', async () => {
  const s = setup();
  const id = opRewards(s);
  s.reddit.failNext('getPost');
  assert.equal(await s.run(id), 'failed');
  assert.equal(s.problems().length, 1);
  s.clock.now += IN_FLIGHT_MS + 1;
  assert.equal(await s.run(id), 'rewarded');
  assert.equal(await s.karmaOf('Trader'), 1);
});

test('OP closing a trading post flairs, locks and announces it', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'OP', '!close');

  assert.equal(await s.run(id), 'closed');

  assert.deepEqual(s.reddit.postFlairs, [
    { postId: 't3_p1', templateId: 'closed' },
  ]);
  assert.deepEqual(s.reddit.locked, ['t3_p1']);
  assert.equal(s.reddit.replies.length, 1);
  assert.deepEqual(s.reddit.replies[0]?.target, { kind: 'post', id: 't3_p1' });
  assert.ok(s.reddit.replies[0]?.text.includes('has been closed'));
  assertFooter(s.reddit.replies[0]?.text);
  assert.equal(s.problems().length, 0);
  assert.equal(await s.run(id), 'already-handled');
});

test('someone other than OP cannot close the post', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'Trader', '!close');

  assert.deepEqual(await s.result(id), {
    outcome: 'refused',
    reason: 'not-op',
  });

  assert.equal(s.reddit.postFlairs.length, 0);
  assert.equal(s.reddit.locked.length, 0);
  assert.equal(s.reddit.replies.length, 1);
  assert.deepEqual(s.reddit.replies[0]?.target, { kind: 'comment', id });
  assert.ok(s.reddit.replies[0]?.text.includes('only be closed by the OP'));
  assertFooter(s.reddit.replies[0]?.text);
});

test('OP cannot close a post that is not a trading post', async () => {
  const s = setup();
  s.reddit.addPost(post('t3_p2', { flairText: 'Discussion' }));
  const id = s.command('t1_cmd', 'OP', '!close', {
    parentId: 't3_p2',
    postId: 't3_p2',
  });

  assert.deepEqual(await s.result(id), {
    outcome: 'refused',
    reason: 'not-trading',
  });

  assert.equal(s.reddit.locked.length, 0);
  assert.ok(s.reddit.replies[0]?.text.includes('cannot be closed'));
});

test('a moderator can close any post', async () => {
  const s = setup();
  s.reddit.moderators = new Set(['mod']);
  s.reddit.addPost(post('t3_p2', { flairText: 'Discussion' }));
  const id = s.command('t1_cmd', 'Mod', '!close', {
    parentId: 't3_p2',
    postId: 't3_p2',
  });

  assert.equal(await s.run(id), 'closed');

  assert.deepEqual(s.reddit.locked, ['t3_p2']);
  assert.deepEqual(s.reddit.postFlairs, [
    { postId: 't3_p2', templateId: 'closed' },
  ]);
});

test('a removed !close is ignored without a claim and closes once approved', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'OP', '!close', { removed: true });

  assert.equal(await s.run(id), 'ignored');

  assert.equal(s.reddit.replies.length, 0);
  assert.equal(s.reddit.locked.length, 0);
  assert.equal(s.reddit.postFlairs.length, 0);

  s.reddit.addComment(comment(id, 'OP', '!close', { removed: false }));
  assert.equal(await s.run(id, 'approve'), 'closed');
  assert.deepEqual(s.reddit.locked, ['t3_p1']);
});

test('a rerun of a finished !close flairs and locks again without a second reply', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'OP', '!close');
  assert.equal(await s.run(id), 'closed');

  assert.equal(await s.run(id, 'rerun'), 'closed');

  assert.equal(s.reddit.replies.length, 1);
  assert.equal(s.reddit.postFlairs.length, 2);
  assert.equal(s.reddit.locked.length, 2);
});

test('two deliveries of a !close at once reply once', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'OP', '!close');
  const outcomes = await Promise.all([s.run(id), s.run(id)]);
  assert.deepEqual([...outcomes].sort(), ['already-handled', 'closed']);
  assert.equal(s.reddit.replies.length, 1);
});

test('a re-run says when the flair could not be set', async () => {
  const s = setup();
  const id = opRewards(s);
  s.reddit.failUntilRestored('setUserFlair', new Error('403'));
  await s.run(id);
  assert.deepEqual(await s.result(id, 'rerun'), {
    outcome: 'rewarded',
    flairError: 'Error: 403',
  });
});

test('a resumed -karma replies that a point was taken', async () => {
  const s = setup();
  const id = modCommands(s, 't1_cmd', '-karma');
  const restore = s.reddit.failUntilRestored('replyLocked');
  assert.equal(await s.run(id), 'failed');
  restore();
  s.clock.now += IN_FLIGHT_MS + 1;
  assert.equal(await s.run(id), 'rewarded');
  assert.equal(await s.karmaOf('Trader'), -1);
  assert.ok(s.reddit.replies[0]?.text.includes('decremented'));
});

test('!close works while the courier page cannot be read', async () => {
  const s = setup();
  s.reddit.failUntilRestored('readWikiPage');
  assert.equal(await s.run(s.command('t1_cmd', 'OP', '!close')), 'closed');
});
