import type { CommandKind } from './types';

const GIVE = /^(\++karma|karma\++)/i;
const TAKE = /^(-+karma|karma-+)/i;
const CLOSE = /^(!close|close!)/i;

/** Reads a command from the start of a comment body, or undefined when there is none. */
export function parseCommand(body: string): CommandKind | undefined {
  const text = body.trim().replaceAll('\\', '');
  if (GIVE.test(text)) return 'give';
  if (TAKE.test(text)) return 'take';
  if (CLOSE.test(text)) return 'close';
  return undefined;
}

export type CommandSource = 'create' | 'approve' | 'rerun';

export type CommandInput = {
  commentId: string;
  source: CommandSource;
};

type PayloadComment = { id: string; body?: string } | undefined;

// Most comments are not commands. The triggers decide that from the payload,
// before any call to Reddit.

export function commandOnCreate(
  comment: PayloadComment
): CommandInput | undefined {
  return comment && parseCommand(comment.body ?? '') !== undefined
    ? { commentId: comment.id, source: 'create' }
    : undefined;
}

/** A command that a filter removed runs when a moderator approves it. */
export function commandOnModAction(
  action: string | undefined,
  comment: PayloadComment
): CommandInput | undefined {
  return action === 'approvecomment' &&
    comment &&
    parseCommand(comment.body ?? '') !== undefined
    ? { commentId: comment.id, source: 'approve' }
    : undefined;
}
