// No Devvit imports, so tests can use it.

import type { Store } from './store';

export type Platform = 'XBOX' | 'PlayStation' | 'PC';
export const PLATFORMS: readonly Platform[] = ['XBOX', 'PlayStation', 'PC'];

export type Gamertag = { platform: Platform; username: string; userId: string };

export type Profile = {
  redditUsername: string;
  /** Karma earned on r/Fallout76Marketplace. */
  karma: number;
  /** Karma carried over from r/Market76. Shown in the total, ignored by the flair tier. */
  m76Karma: number;
  gamertags: Gamertag[];
};

export function emptyProfile(redditUsername: string): Profile {
  return { redditUsername, karma: 0, m76Karma: 0, gamertags: [] };
}

/** Usernames are compared and stored lowercased. */
export function userKey(username: string): string {
  return username.toLowerCase();
}

export type FlairTemplates = {
  modsAndCouriers: string;
  tier0: string;
  tier50: string;
  tier100: string;
  tradeClosed: string;
};

export type Config = {
  enabled: boolean;
  dailyCap: number;
  /** Post flair texts that mark a trading post, compared ignoring case. */
  tradingFlairs: string[];
  templates: FlairTemplates;
  courierPage: string;
  disclaimerUrl: string;
};

export type CommandKind = 'give' | 'take' | 'close';

export type Party = {
  name: string;
  isMod: boolean;
  isCourier: boolean;
};

/** A comment or post as the checks see it. `author` is undefined when deleted. */
type Content = {
  author: Party | undefined;
  /** Removed by a moderator or a filter. */
  removed: boolean;
};

export type KarmaSnapshot = {
  kind: 'give' | 'take';
  giver: Party;
  /** What the command replied to: a comment, or the post when top-level. */
  parent: Content & { isPost: boolean };
  post: Content & { flairText: string };
  /** The comment id of the giver's earlier reward to this receiver in this post, if any. */
  earlierCommentId: string | undefined;
  /** Rewards the giver has made since midnight UTC. */
  givenToday: number;
};

export type CloseSnapshot = {
  author: string;
  authorIsMod: boolean;
  postAuthor: string | undefined;
  flairText: string;
};

export type KarmaRefusal =
  | 'unauthorized' // -karma from a non-moderator
  | 'wrong-post-type'
  | 'self'
  | 'top-level'
  | 'removed'
  | 'too-many-users'
  | 'already-rewarded'
  | 'cap';

export type CloseRefusal = 'not-op' | 'not-trading';

export type KarmaVerdict =
  | {
      kind: 'pass';
      receiver: string;
      sign: 1 | -1;
      /** False for moderators, who skip the once-per-pair rule and the daily cap. */
      enforceLimits: boolean;
    }
  | { kind: 'refuse'; reason: Exclude<KarmaRefusal, 'already-rewarded'> }
  | { kind: 'refuse'; reason: 'already-rewarded'; earlierCommentId: string };

export type CloseVerdict =
  { kind: 'pass' } | { kind: 'refuse'; reason: CloseRefusal };

export type Reward = {
  commentId: string;
  postId: string;
  giver: string;
  receiver: string;
  sign: 1 | -1;
  atMs: number;
};

/** Sign 0 is a reward from the old bot's log, which has no sign. */
export type StoredReward = Omit<Reward, 'sign'> & { sign: 1 | -1 | 0 };

export type CommentInfo = {
  id: string;
  /** Undefined when the author's account is deleted. */
  authorName: string | undefined;
  body: string;
  /** `t1_…` for a reply, `t3_…` for a top-level comment. */
  parentId: string;
  postId: string;
  removed: boolean;
};

export type PostInfo = {
  id: string;
  authorName: string | undefined;
  flairText: string;
  removed: boolean;
};

export type ReplyTarget = { kind: 'comment' | 'post'; id: string };

export interface RedditPort {
  appUsername(): Promise<string>;
  /** The username of the user making this request, if they moderate the subreddit. */
  currentModerator(): Promise<string | undefined>;
  getComment(id: string): Promise<CommentInfo>;
  getPost(id: string): Promise<PostInfo>;
  isModerator(username: string): Promise<boolean>;
  /** The page's markdown, or undefined when it does not exist. Any other failure throws. */
  readWikiPage(page: string): Promise<string | undefined>;
  /** Posts a distinguished, locked reply. */
  replyLocked(target: ReplyTarget, text: string): Promise<void>;
  setUserFlair(
    username: string,
    text: string,
    templateId: string
  ): Promise<void>;
  clearUserFlair(username: string): Promise<void>;
  setPostFlair(postId: string, templateId: string): Promise<void>;
  lockPost(postId: string): Promise<void>;
}

export type Ports = {
  reddit: RedditPort;
  store: Store;
  config: Config;
  subredditName: string;
  now: () => number;
  log: (message: string) => void;
};
