import { judgeClose, judgeKarma } from './checks';
import { parseCommand, type CommandInput } from './commands';
import { refreshFlair } from './flair';
import { isCommentId } from './ids';
import {
  closeRefusalText,
  closeSuccessText,
  karmaRefusalText,
  karmaSuccessText,
  permalinkFor,
  withFooter,
} from './replies';
import { Roles } from './roles';
import { utcDayKey } from './time';
import type {
  CloseRefusal,
  CommentInfo,
  KarmaRefusal,
  Ports,
  PostInfo,
  ReplyTarget,
} from './types';

export type Outcome =
  | 'not-a-command'
  | 'disabled'
  | 'skipped'
  | 'already-handled'
  | 'ignored'
  | 'refused'
  | 'rewarded'
  | 'closed'
  | 'failed';

export type CommandResult =
  | { outcome: Exclude<Outcome, 'rewarded' | 'refused' | 'failed'> }
  | { outcome: 'rewarded'; flairError?: string }
  | { outcome: 'refused'; reason: KarmaRefusal | CloseRefusal }
  | { outcome: 'failed'; message: string };

type Run = {
  comment: CommentInfo;
  author: string;
  post: PostInfo;
  roles: Roles;
  ports: Ports;
  /** The comment was answered before, and a moderator is running it again. */
  answeredBefore: boolean;
};

export async function handleCommand(
  input: CommandInput,
  ports: Ports
): Promise<CommandResult> {
  if (!ports.config.enabled && input.source !== 'rerun')
    return { outcome: 'disabled' };

  try {
    return await runCommand(input, ports);
  } catch (error) {
    // The claim stays pending, so a moderator's re-run picks the command up again.
    const message = `${input.commentId} (${input.source}) failed: ${String(error)}`;
    ports.log(message);
    return { outcome: 'failed', message };
  }
}

async function runCommand(
  input: CommandInput,
  ports: Ports
): Promise<CommandResult> {
  const { reddit, store, config, log } = ports;
  const rerun = input.source === 'rerun';

  const comment = await reddit.getComment(input.commentId);
  const kind = parseCommand(comment.body);
  if (kind === undefined) return { outcome: 'not-a-command' };

  const author = comment.authorName;
  if (author === undefined) return { outcome: 'skipped' };
  const appUsername = await reddit.appUsername();
  if (
    [appUsername.toLowerCase(), 'automoderator'].includes(author.toLowerCase())
  )
    return { outcome: 'skipped' };

  // A removed command waits, unclaimed, for a moderator's approval to bring it back.
  if (comment.removed) {
    log(`${comment.id} ignored: the command comment is removed`);
    return { outcome: 'ignored' };
  }

  const claim = await store.claim(comment.id, { takeOver: rerun });
  if (claim === 'busy' || (claim === 'done' && !rerun))
    return { outcome: 'already-handled' };
  log(
    `${kind} by u/${author} on ${comment.id} (${input.source}${claim === 'resumed' ? ', resuming' : ''})`
  );

  const run: Run = {
    comment,
    author,
    post: await reddit.getPost(comment.postId),
    roles: new Roles(reddit, config.courierPage),
    ports,
    answeredBefore: claim === 'done',
  };
  return kind === 'close' ? closePost(run) : giveKarma(kind, run);
}

/** Runs one Reddit call, naming it in the error, so the log says which call failed. */
async function step(name: string, call: () => Promise<void>): Promise<void> {
  try {
    await call();
  } catch (error) {
    throw new Error(`${name}: ${String(error)}`, { cause: error });
  }
}

async function closePost(run: Run): Promise<CommandResult> {
  const { comment, author, post, roles, ports } = run;
  const { reddit, store, config } = ports;
  const verdict = judgeClose(
    {
      author,
      authorIsMod: await roles.isMod(author),
      postAuthor: post.authorName,
      flairText: post.flairText,
    },
    config
  );
  if (verdict.kind === 'refuse') {
    ports.log(`${comment.id} refused: ${verdict.reason}`);
    await reply(
      ports,
      { kind: 'comment', id: comment.id },
      post.id,
      closeRefusalText(verdict.reason)
    );
    await store.finish(comment.id);
    return { outcome: 'refused', reason: verdict.reason };
  }

  await step('setting the Trade Closed flair', () =>
    reddit.setPostFlair(post.id, config.templates.tradeClosed)
  );
  await step('locking the post', () => reddit.lockPost(post.id));
  if (!run.answeredBefore) {
    await reply(
      ports,
      { kind: 'post', id: post.id },
      post.id,
      closeSuccessText()
    );
  }
  await store.finish(comment.id);
  return { outcome: 'closed' };
}

async function giveKarma(
  kind: 'give' | 'take',
  run: Run
): Promise<CommandResult> {
  const { comment, author, post, roles, ports } = run;
  const { reddit, store, config, now } = ports;

  const parentIsPost = !isCommentId(comment.parentId);
  const parentComment = parentIsPost
    ? undefined
    : await reddit.getComment(comment.parentId);
  const parentAuthorName = parentIsPost
    ? post.authorName
    : parentComment?.authorName;

  // A command that already recorded its reward is not judged again: the answer
  // could differ now (the cap counts this very reward), and the point stands.
  const recorded = await recordedBy(run, parentAuthorName);
  if (recorded) {
    const { receiver, sign } = recorded;
    const answered = run.answeredBefore || sign === undefined;
    return afterReward(
      run,
      receiver,
      answered ? undefined : karmaSuccessText(author, receiver, sign)
    );
  }

  const giver = await roles.party(author);
  const parentAuthor = parentAuthorName
    ? await roles.party(parentAuthorName)
    : undefined;
  const postAuthor = post.authorName
    ? await roles.party(post.authorName)
    : undefined;
  const dayKey = utcDayKey(now());

  const verdict = judgeKarma(
    {
      kind,
      giver,
      parent: {
        author: parentAuthor,
        removed: parentIsPost
          ? post.removed
          : (parentComment?.removed ?? false),
        isPost: parentIsPost,
      },
      post: {
        author: postAuthor,
        removed: post.removed,
        flairText: post.flairText,
      },
      earlierCommentId:
        giver.isMod || !parentAuthorName
          ? undefined
          : await store.earlierReward(post.id, author, parentAuthorName),
      givenToday: await store.givenToday(author, dayKey),
    },
    config
  );

  if (verdict.kind === 'refuse') {
    return refuse(
      run,
      verdict.reason,
      parentAuthorName,
      verdict.reason === 'already-rewarded'
        ? verdict.earlierCommentId
        : undefined
    );
  }

  const { receiver, sign, enforceLimits } = verdict;
  const result = await store.recordReward(
    {
      commentId: comment.id,
      postId: post.id,
      giver: author,
      receiver,
      sign,
      atMs: now(),
    },
    { enforceLimits, dayKey, dailyCap: config.dailyCap }
  );
  // Another command got there between the checks and the write.
  if (result.kind === 'already-rewarded')
    return refuse(run, 'already-rewarded', receiver, result.earlierCommentId);
  if (result.kind === 'cap') return refuse(run, 'cap', receiver);

  // 'already-recorded': a concurrent run wrote it, so finish as if this one had.
  return afterReward(run, receiver, karmaSuccessText(author, receiver, sign));
}

/**
 * The reward this command already recorded, if any. Without a sign, it is from
 * the old bot's log, and the old bot answered it.
 */
async function recordedBy(
  run: Run,
  parentAuthorName: string | undefined
): Promise<{ receiver: string; sign?: 1 | -1 } | undefined> {
  const { comment, author, post, ports } = run;
  const recorded = await ports.store.recordedReward(comment.id);
  if (recorded) return recorded;
  if (!parentAuthorName) return undefined;
  const earlier = await ports.store.earlierReward(
    post.id,
    author,
    parentAuthorName
  );
  return earlier === comment.id ? { receiver: parentAuthorName } : undefined;
}

async function refuse(
  run: Run,
  reason: KarmaRefusal,
  receiver: string | undefined,
  earlierCommentId?: string
): Promise<CommandResult> {
  const { comment, author, post, ports } = run;
  ports.log(`${comment.id} refused: ${reason}`);
  const text = karmaRefusalText(reason, {
    giver: author,
    receiver,
    earlierLink:
      earlierCommentId &&
      permalinkFor(ports.subredditName, post.id, earlierCommentId),
  });
  await reply(ports, { kind: 'comment', id: comment.id }, post.id, text);
  await ports.store.finish(comment.id);
  return { outcome: 'refused', reason };
}

/** The point is recorded by now, so a flair failure must not stop the reply. */
async function afterReward(
  run: Run,
  receiver: string,
  replyText: string | undefined
): Promise<CommandResult> {
  const { comment, post, roles, ports } = run;
  let flairError: string | undefined;
  try {
    await refreshFlair(ports, receiver, roles);
  } catch (error) {
    flairError = String(error);
    ports.log(
      `${comment.id}: the point is recorded, but the flair of u/${receiver} could not be set: ${flairError}. Re-run the command to set it.`
    );
  }

  if (replyText !== undefined) {
    await reply(ports, { kind: 'comment', id: comment.id }, post.id, replyText);
  }

  await ports.store.finish(comment.id);
  return flairError === undefined
    ? { outcome: 'rewarded' }
    : { outcome: 'rewarded', flairError };
}

/** Replies under the post instead when the comment can't take a reply. */
async function reply(
  ports: Ports,
  target: ReplyTarget,
  postId: string,
  body: string
): Promise<void> {
  const text = withFooter(body, ports.config.disclaimerUrl);
  try {
    await ports.reddit.replyLocked(target, text);
  } catch (error) {
    if (target.kind === 'post') throw error;
    ports.log(
      `Replying to ${target.id} failed (${String(error)}); replying on the post instead`
    );
    await ports.reddit.replyLocked({ kind: 'post', id: postId }, text);
  }
}
