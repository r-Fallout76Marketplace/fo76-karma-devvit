import { Hono } from 'hono';
import type { Context } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';

import { ports, store } from '../server/devvit/platform';
import { devvitReddit } from '../server/devvit/reddit';
import { isCommentId } from '../server/ids';
import { handleCommand, type CommandResult } from '../server/karma';
import { profileView } from '../server/profile';
import { lookupForm, toast } from '../server/ui';
import { forEveryone, forModerators } from './guard';

export const menu = new Hono();

async function targetOf(c: Context): Promise<string> {
  return (await c.req.json<MenuItemRequest>()).targetId;
}

/** Opens the profile of the author of the post or comment the menu item was used on. */
async function authorProfile(
  c: Context,
  editable: boolean
): Promise<UiResponse> {
  const targetId = await targetOf(c);
  const username = isCommentId(targetId)
    ? (await devvitReddit.getComment(targetId)).authorName
    : (await devvitReddit.getPost(targetId)).authorName;
  return username
    ? profileView(store(), username, editable)
    : toast(
        'The author of this item is deleted. Use Karma lookup with their old name.'
      );
}

menu.post(
  '/profile',
  forEveryone((c) => authorProfile(c, false))
);

menu.post(
  '/profile-edit',
  forModerators((c) => authorProfile(c, true))
);

function rerunToast(result: CommandResult): string {
  switch (result.outcome) {
    case 'not-a-command':
      return 'Re-run: this comment is not a karma or close command.';
    case 'skipped':
      return 'Re-run: skipped. The author is deleted, or the comment is by a bot.';
    case 'ignored':
      return 'Re-run: the comment is removed. Approve it and the command runs.';
    case 'refused':
      return `Re-run: refused (${result.reason}). The bot replied.`;
    case 'rewarded':
      return result.flairError === undefined
        ? 'Re-run: the reward is on record and the flair is rebuilt.'
        : `Re-run: the reward is on record, but the flair could not be set: ${result.flairError}`;
    case 'closed':
      return 'Re-run: the post is closed.';
    case 'failed':
      return `Re-run failed: ${result.message}`;
    // A re-run takes over earlier attempts and ignores Enabled.
    case 'already-handled':
    case 'disabled':
      return 'Re-run: not run.';
  }
}

menu.post(
  '/rerun',
  forModerators(async (c) => {
    const result = await handleCommand(
      { commentId: await targetOf(c), source: 'rerun' },
      await ports()
    );
    return toast(rerunToast(result));
  })
);

menu.post(
  '/lookup',
  forModerators(async () => ({
    showForm: { name: 'lookup', form: lookupForm() },
  }))
);
