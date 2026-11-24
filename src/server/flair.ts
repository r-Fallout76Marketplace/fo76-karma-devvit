import { Roles } from './roles';
import type { FlairTemplates, Platform, Ports, Profile } from './types';

const EMOJIS: [Platform, string][] = [
  ['XBOX', ':xbox:'],
  ['PlayStation', ':playstation:'],
  ['PC', ':pc:'],
];

export function flairFor(
  profile: Profile,
  role: { isMod: boolean; isCourier: boolean },
  templates: FlairTemplates
): { text: string; templateId: string } {
  const present = new Set(profile.gamertags.map((tag) => tag.platform));
  const emojis = EMOJIS.filter(([platform]) => present.has(platform)).map(
    ([, emoji]) => emoji
  );
  const total = profile.karma + profile.m76Karma;
  const label = role.isCourier
    ? `Verified Courier: ${total}`
    : `Karma: ${total}`;
  return {
    text: [...emojis, label].join(' '),
    templateId: templateFor(profile.karma, role, templates),
  };
}

function templateFor(
  karma: number,
  role: { isMod: boolean; isCourier: boolean },
  templates: FlairTemplates
): string {
  if (role.isMod || role.isCourier) return templates.modsAndCouriers;
  if (karma >= 100) return templates.tier100;
  if (karma >= 50) return templates.tier50;
  return templates.tier0;
}

export async function refreshFlair(
  ports: Pick<Ports, 'reddit' | 'store' | 'config'>,
  username: string,
  roles = new Roles(ports.reddit, ports.config.courierPage)
): Promise<void> {
  const flair = flairFor(
    await ports.store.loadProfile(username),
    await roles.party(username),
    ports.config.templates
  );
  await ports.reddit.setUserFlair(username, flair.text, flair.templateId);
}
