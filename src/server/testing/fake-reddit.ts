// An in-memory stand-in for the Reddit calls, with recorders for what the app did.

import type { CommentInfo, PostInfo, RedditPort, ReplyTarget } from '../types';

export class FakeReddit implements RedditPort {
  readonly comments = new Map<string, CommentInfo>();
  readonly posts = new Map<string, PostInfo>();
  /** Lowercased usernames. */
  moderators = new Set<string>();
  readonly wiki = new Map<string, string>();
  /** The app's own account name, in whatever case a test wants to return it. */
  appName = 'Vault-TecTradingCo';
  /** The user making the request, for `currentModerator`. */
  currentUser: string | undefined;

  readonly replies: { target: ReplyTarget; text: string }[] = [];
  readonly flairs: { username: string; text: string; templateId: string }[] =
    [];
  readonly postFlairs: { postId: string; templateId: string }[] = [];
  readonly locked: string[] = [];
  readonly clearedFlairs: string[] = [];
  /** Port methods that throw, with whether they throw only once. */
  private readonly failures = new Map<
    string,
    { error: Error; once: boolean }
  >();

  private readonly callsByName = new Map<string, number>();

  private readonly failingReplyTargets = new Set<string>();

  addComment(info: CommentInfo): void {
    this.comments.set(info.id, info);
  }

  addPost(info: PostInfo): void {
    this.posts.set(info.id, info);
  }

  /** Makes the next reply to this comment or post id throw, once. */
  failNextReplyTo(id: string): void {
    this.failingReplyTargets.add(id);
  }

  /** Makes the next call to a port method throw, once. */
  failNext(method: string, error: Error = new Error(`${method} failed`)): void {
    this.failures.set(method, { error, once: true });
  }

  /** Makes every call to a port method throw until the returned function is called. */
  failUntilRestored(
    method: string,
    error: Error = new Error(`${method} failed`)
  ): () => void {
    this.failures.set(method, { error, once: false });
    return () => this.failures.delete(method);
  }

  callCount(name: string): number {
    return this.callsByName.get(name) ?? 0;
  }

  private called(name: string): void {
    this.callsByName.set(name, this.callCount(name) + 1);
    const failure = this.failures.get(name);
    if (failure) {
      if (failure.once) this.failures.delete(name);
      throw failure.error;
    }
  }

  async appUsername(): Promise<string> {
    this.called('appUsername');
    return this.appName;
  }

  async currentModerator(): Promise<string | undefined> {
    this.called('currentModerator');
    const user = this.currentUser;
    return user && this.moderators.has(user.toLowerCase()) ? user : undefined;
  }

  async getComment(id: string): Promise<CommentInfo> {
    this.called('getComment');
    const comment = this.comments.get(id);
    if (!comment) throw new Error(`No comment ${id}`);
    return comment;
  }

  async getPost(id: string): Promise<PostInfo> {
    this.called('getPost');
    const post = this.posts.get(id);
    if (!post) throw new Error(`No post ${id}`);
    return post;
  }

  async isModerator(username: string): Promise<boolean> {
    this.called('isModerator');
    return this.moderators.has(username.toLowerCase());
  }

  async readWikiPage(page: string): Promise<string | undefined> {
    this.called('readWikiPage');
    return this.wiki.get(page);
  }

  async replyLocked(target: ReplyTarget, text: string): Promise<void> {
    this.called('replyLocked');
    if (this.failingReplyTargets.delete(target.id))
      throw new Error(`Cannot reply to ${target.id}`);
    this.replies.push({ target, text });
  }

  async setUserFlair(
    username: string,
    text: string,
    templateId: string
  ): Promise<void> {
    this.called('setUserFlair');
    this.flairs.push({ username, text, templateId });
  }

  async clearUserFlair(username: string): Promise<void> {
    this.called('clearUserFlair');
    this.clearedFlairs.push(username);
  }

  async setPostFlair(postId: string, templateId: string): Promise<void> {
    this.called('setPostFlair');
    this.postFlairs.push({ postId, templateId });
  }

  async lockPost(postId: string): Promise<void> {
    this.called('lockPost');
    this.locked.push(postId);
  }
}
