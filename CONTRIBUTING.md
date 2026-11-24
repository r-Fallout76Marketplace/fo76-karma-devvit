# Contributing

A [Devvit Web](https://developers.reddit.com/docs) app. Needs Node 24.

```bash
npm ci
npm run verify
```

The rules for giving karma are in `src/server/checks.ts`, the replies in
`src/server/replies.ts` and the Redis keys at the top of `src/server/store.ts`.
The daily cap, flair ids and other settings are changed in the app's settings
on the subreddit, not in code.

## Trying a change on Reddit

1. Only its owner can playtest an app, so make your own at
   https://developers.reddit.com/new and a subreddit with under 200 members.
   Put `DEVVIT_APP_NAME=<app>` and `DEVVIT_SUBREDDIT=<subreddit>` in `.env`.
   Remove them before releasing: they override `devvit.json`.
2. On the subreddit, turn on user and post flair. Add post flairs `XBOX`,
   `PlayStation`, `PC` and `Trade Closed`, and four user flairs: moderators and
   couriers, 0-49, 50-99, 100+.
3. `npx devvit login`, then `npm run dev`.
4. In the app's settings, paste the five flair ids and tick **Enabled**.

## Releasing

`npm run verify`, then `npm run release` from the account that owns
`vault-tectradingco`. Then update the app on the subreddit.

**Never uninstall it from r/Fallout76Marketplace: that deletes all the karma.**

`npm run logs -- --since 1d` shows the log.
