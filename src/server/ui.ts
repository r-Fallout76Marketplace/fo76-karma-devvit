// What the menu items and forms show, and the reading of what the forms
// submit. Form builders take data and return a Devvit form. Values are
// pre-filled through each field's defaultValue, since a form's `data` does not
// pre-fill on this platform version.

import type { Form, FormField, UiResponse } from '@devvit/web/shared';

import { PLATFORMS, type Profile, type RedditPort } from './types';

/** The largest karma a moderator can type, so a slip of the keyboard is refused. */
export const KARMA_LIMIT = 1_000_000;
const GAMERTAG_MAX = 64;
const TOAST_MAX = 250;

export const BAD_USERNAME = 'That is not a Reddit username.';

export function toast(text: string): UiResponse {
  return { showToast: text.slice(0, TOAST_MAX) };
}

/**
 * Runs a moderator-only action. `forUserType` in devvit.json only hides a menu
 * item, so every moderator endpoint checks the user here, on the server.
 */
export async function moderatorOnly(
  reddit: Pick<RedditPort, 'currentModerator'>,
  run: (moderator: string) => Promise<UiResponse>
): Promise<UiResponse> {
  const moderator = await reddit.currentModerator();
  return moderator ? run(moderator) : toast('Only moderators can use this.');
}

/** A Reddit username from what a moderator typed, without `u/`, or undefined when it cannot be one. */
export function cleanUsername(raw: string): string | undefined {
  const name = raw.trim().replace(/^\/?u\//i, '');
  return /^[A-Za-z0-9_-]{3,20}$/.test(name) ? name : undefined;
}

/** Reads a text field, trimmed; anything that is not a string reads as empty. */
export function textField(
  values: Record<string, unknown>,
  name: string
): string {
  const value = values[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** Reads a select value, which arrives as a one-element array. */
export function selected(
  values: Record<string, unknown>,
  name: string
): string {
  const value = values[name];
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

function gamertag(
  profile: Profile,
  platform: string
): { username: string; userId: string } {
  const found = profile.gamertags.find((tag) => tag.platform === platform);
  return { username: found?.username ?? '', userId: found?.userId ?? '' };
}

/** The read-only profile as lines of text, for the form's description. */
function profileText(profile: Profile): string {
  return [
    `r/Fallout76Marketplace karma: ${profile.karma}`,
    `r/Market76 karma: ${profile.m76Karma}`,
    ...PLATFORMS.map(
      (platform) =>
        `${platform} gamertag: ${gamertag(profile, platform).username || 'none'}`
    ),
  ].join('\n');
}

/** The read-only profile card everyone can open, or the moderators' editable version. */
export function profileForm(profile: Profile, editable: boolean): Form {
  if (!editable) {
    return {
      title: `Karma profile of u/${profile.redditUsername}`,
      description: profileText(profile),
      acceptLabel: 'Close',
      fields: [],
    };
  }
  const fields: FormField[] = [
    {
      type: 'string',
      name: 'username',
      label: 'Username',
      defaultValue: profile.redditUsername,
      disabled: true,
    },
    {
      type: 'number',
      name: 'karma',
      label: 'r/Fallout76Marketplace karma',
      defaultValue: profile.karma,
      required: true,
    },
    {
      type: 'number',
      name: 'm76Karma',
      label: 'r/Market76 karma',
      defaultValue: profile.m76Karma,
      required: true,
    },
    ...PLATFORMS.flatMap((platform): FormField[] => {
      const tag = gamertag(profile, platform);
      return [
        {
          type: 'string',
          name: platform,
          label: `${platform} gamertag`,
          defaultValue: tag.username,
          disabled: false,
        },
        {
          type: 'string',
          name: `${platform}Id`,
          label: `${platform} gamertag id`,
          defaultValue: tag.userId,
        },
      ];
    }),
    {
      type: 'string',
      name: 'openedKarma',
      label: 'Karma when this form was opened',
      helpText:
        'A change to the karma above is applied as the difference from this, so a reward given in the meantime is kept.',
      defaultValue: String(profile.karma),
      disabled: true,
    },
    {
      type: 'boolean',
      name: 'deleteProfile',
      label: "Delete this user's karma data (on their request)",
      defaultValue: false,
    },
  ];
  return {
    title: `Edit karma profile of u/${profile.redditUsername}`,
    acceptLabel: 'Save',
    fields,
  };
}

export type ProfileEdit =
  /** `openedKarma` is what the form showed when it was opened, when it says. */
  | { kind: 'save'; profile: Profile; openedKarma: number | undefined }
  | { kind: 'delete' }
  | { kind: 'invalid'; problem: string };

function wholeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isInteger(number) && Math.abs(number) <= KARMA_LIMIT
    ? number
    : undefined;
}

/** Reads the submitted edit form: a profile to save, a deletion, or what is wrong with it. */
export function profileFromForm(
  values: Record<string, unknown>,
  username: string
): ProfileEdit {
  if (values.deleteProfile === true) return { kind: 'delete' };

  const text = (name: string) => textField(values, name);
  const karma = wholeNumber(values.karma);
  const m76Karma = wholeNumber(values.m76Karma);
  if (karma === undefined || m76Karma === undefined) {
    return {
      kind: 'invalid',
      problem: `Karma must be a whole number between -${KARMA_LIMIT} and ${KARMA_LIMIT}.`,
    };
  }
  const tooLong = PLATFORMS.find(
    (platform) =>
      text(platform).length > GAMERTAG_MAX ||
      text(`${platform}Id`).length > GAMERTAG_MAX
  );
  if (tooLong) {
    return {
      kind: 'invalid',
      problem: `The ${tooLong} gamertag or id is longer than ${GAMERTAG_MAX} characters.`,
    };
  }
  return {
    kind: 'save',
    profile: {
      redditUsername: username,
      karma,
      m76Karma,
      gamertags: PLATFORMS.filter((platform) => text(platform) !== '').map(
        (platform) => ({
          platform,
          username: text(platform),
          // No id is stored as "0".
          userId: text(`${platform}Id`) || '0',
        })
      ),
    },
    openedKarma: wholeNumber(values.openedKarma),
  };
}

export function lookupForm(): Form {
  return {
    title: 'Karma lookup',
    acceptLabel: 'Open',
    fields: [
      { type: 'string', name: 'username', label: 'Username', required: true },
      {
        type: 'select',
        name: 'action',
        label: 'Open',
        defaultValue: ['profile'],
        options: [
          { label: 'Karma profile', value: 'profile' },
          { label: 'Edit karma profile', value: 'edit' },
        ],
      },
    ],
  };
}
