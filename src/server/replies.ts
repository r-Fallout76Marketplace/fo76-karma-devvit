import type { CloseRefusal, KarmaRefusal } from './types';

export function karmaSuccessText(
  giver: string,
  receiver: string,
  sign: 1 | -1
): string {
  if (sign === -1) {
    return `${receiver}'s karma has been decremented by one. Please note that karma may take some time to update.`;
  }
  return (
    `Hi u/${giver}! You have successfully rewarded u/${receiver} with one karma point! Please note that karma may take ` +
    `some time to update.`
  );
}

export function karmaRefusalText(
  reason: KarmaRefusal,
  context: {
    giver: string;
    receiver?: string | undefined;
    earlierLink?: string | undefined;
  }
): string {
  const hi = `Hi u/${context.giver}!`;
  switch (reason) {
    case 'unauthorized':
      return 'Karma can only be subtracted by moderators. Please contact mods if you have been scammed.';
    case 'wrong-post-type':
      return (
        `${hi} You can only give karma to others under a trading post, i.e., a submission with PlayStation, XBOX, or PC ` +
        `flair. Please refer to the wiki page for more information.`
      );
    case 'self':
      return `${hi} You cannot reward yourself with karma. Sorry.`;
    case 'top-level':
      return (
        `${hi} You cannot award karma to a submission, you need to reply to a comment. Also, please negotiate and exchange ` +
        `gamertags in comments rather than in chats/messages. If you are not sure, you can look at an example of a ` +
        `[good karma exchange](https://www.reddit.com/r/Fallout76Marketplace/wiki/index/trading_karma). ` +
        `This is the minimum conversation we expect from users before they can give karma.`
      );
    case 'removed':
      return (
        `${hi} It seems that the OP has deleted their submission or it has been removed by a Moderator, or the comment ` +
        `you replied to is gone. We don't allow users to trade karma on deleted/removed content. ` +
        `Thank you for your understanding.`
      );
    case 'too-many-users':
      return (
        `${hi} It seems that you are trading under someone else's submission. Karma can only be given by the ` +
        `Original Poster (OP) to a user and vice versa. This restriction is in place to deter other people from hijacking someone else's post. ` +
        `If you want to give karma, one of you needs to create a new submission. Once done, close the submission with the !close command ` +
        `rather than deleting it.`
      );
    case 'already-rewarded':
      return `${hi} You have already rewarded ${context.receiver ?? 'this user'} in this submission. See [here](${context.earlierLink ?? ''})`;
    case 'cap':
      return (
        `${hi} You have reached the karma reward limit. You will not be able to reward karma until the next ` +
        `midnight UTC. You can contact mods, and they can give karma on your behalf. Thank you for your patience!`
      );
  }
}

export function closeSuccessText(): string {
  return 'The submission has been closed, and comments have been locked. Please contact mods if you want to open the submission.';
}

export function closeRefusalText(reason: CloseRefusal): string {
  if (reason === 'not-op') {
    return 'The submission can only be closed by the OP or the mods. Please report the post if it is breaking rules.';
  }
  return 'This type of submission cannot be closed. Please refer to the wiki page for more information.';
}

export function withFooter(body: string, disclaimerUrl: string): string {
  return (
    `${body}\n\n^(This action was performed by a bot. Please contact the mods for any questions. ` +
    `[See disclaimer](${disclaimerUrl}))`
  );
}

/** The link to a comment, from fullnames such as `t3_abc` and `t1_def`. */
export function permalinkFor(
  subredditName: string,
  postId: string,
  commentId: string
): string {
  const post = postId.replace(/^t3_/, '');
  const comment = commentId.replace(/^t1_/, '');
  return `https://www.reddit.com/r/${subredditName}/comments/${post}/_/${comment}/`;
}
