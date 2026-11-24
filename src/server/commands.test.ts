import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commandOnCreate, commandOnModAction, parseCommand } from './commands';
import type { CommandKind } from './types';

const CASES: Record<CommandKind | 'none', string[]> = {
  give: [
    '+karma',
    '++KARMA',
    '+++karma',
    'karma+',
    'karma++',
    'KARMA+',
    '+KaRmA',
    '+karma thanks',
    '  +Karma\n',
    '\n\t +karma',
    '\\+karma',
    '  \\+\\+karma',
  ],
  take: [
    '-karma',
    '--karma',
    'karma-',
    'karma--',
    'karma---',
    '-KARMA bad trader',
    '\\-karma',
  ],
  close: [
    '!close',
    'close!',
    'CLOSE!',
    '!CLOSE',
    'Close! thanks',
    '!ClOsE',
    '\\!close',
  ],
  // Only the start of the comment counts, and the sign must touch the word.
  none: [
    '',
    'karma',
    'close',
    '!clos',
    '+',
    '-',
    '!',
    '+ karma',
    '++ karma',
    '! close',
    'I gave +karma',
    'thanks! +karma',
    'no -karma',
    "don't !close",
    'please close!',
    'x\n+karma',
  ],
};

for (const [kind, bodies] of Object.entries(CASES)) {
  test(`${kind === 'none' ? 'not a command' : `${kind} commands`}`, () => {
    for (const body of bodies) {
      assert.equal(
        parseCommand(body),
        kind === 'none' ? undefined : kind,
        JSON.stringify(body)
      );
    }
  });
}

test('a new comment is a command when its body is one, decided from the payload', () => {
  assert.deepEqual(commandOnCreate({ id: 't1_a', body: '+karma' }), {
    commentId: 't1_a',
    source: 'create',
  });
  assert.equal(commandOnCreate({ id: 't1_a', body: 'hello' }), undefined);
  assert.equal(commandOnCreate({ id: 't1_a' }), undefined);
  assert.equal(commandOnCreate(undefined), undefined);
});

test('an approved comment is a command when its body is one; other actions are not', () => {
  const comment = { id: 't1_a', body: '!close' };
  assert.deepEqual(commandOnModAction('approvecomment', comment), {
    commentId: 't1_a',
    source: 'approve',
  });
  assert.equal(commandOnModAction('removecomment', comment), undefined);
  assert.equal(commandOnModAction(undefined, comment), undefined);
  assert.equal(
    commandOnModAction('approvecomment', { id: 't1_a', body: 'hi' }),
    undefined
  );
  assert.equal(commandOnModAction('approvecomment', undefined), undefined);
});
