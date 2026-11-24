// The subreddit settings as a Config, with defaults for anything unset.

import type { Config } from './types';

/** The raw values a settings reader returns: strings, numbers, booleans, or arrays for selects. */
type RawSettings = Record<string, unknown>;

const DEFAULTS: Config = {
  enabled: false,
  dailyCap: 10,
  tradingFlairs: ['XBOX', 'PlayStation', 'PC'],
  // Flair templates of r/Fallout76Marketplace.
  templates: {
    modsAndCouriers: '51524056-4a4d-11eb-814b-0e7b734c1fd5',
    tier0: '3c680234-4a4d-11eb-8124-0edd2b620987',
    tier50: '2624bc6a-4a4d-11eb-8b7c-0e6968d78889',
    tier100: '0467e0de-4a4d-11eb-9453-0e4e6fcf2865',
    tradeClosed: '1e0c3870-a456-11ea-aa7a-0ee73ab9d31f',
  },
  courierPage: 'custom_bot_config/courier_list',
  disclaimerUrl:
    'https://www.reddit.com/user/Vault-TecTradingCo/comments/lkllre/disclaimer_for_rfallout76marketplace/',
};

function text(raw: RawSettings, key: string, fallback: string): string {
  const value = raw[key];
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : fallback;
}

function number(raw: RawSettings, key: string, fallback: number): number {
  const value = raw[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function flag(raw: RawSettings, key: string, fallback: boolean): boolean {
  const value = raw[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** A cleared number field can come back as 0, which would refuse every reward: fall back to the default. */
function dailyCap(raw: RawSettings): number {
  const value = Math.trunc(number(raw, 'dailyCap', DEFAULTS.dailyCap));
  return value >= 1 ? value : DEFAULTS.dailyCap;
}

export function configFrom(raw: RawSettings): Config {
  return {
    enabled: flag(raw, 'enabled', DEFAULTS.enabled),
    dailyCap: dailyCap(raw),
    tradingFlairs: text(raw, 'tradingFlairs', DEFAULTS.tradingFlairs.join(', '))
      .split(',')
      .map((flair) => flair.trim())
      .filter((flair) => flair !== ''),
    templates: {
      modsAndCouriers: text(
        raw,
        'templateModsAndCouriers',
        DEFAULTS.templates.modsAndCouriers
      ),
      tier0: text(raw, 'templateTier0', DEFAULTS.templates.tier0),
      tier50: text(raw, 'templateTier50', DEFAULTS.templates.tier50),
      tier100: text(raw, 'templateTier100', DEFAULTS.templates.tier100),
      tradeClosed: text(
        raw,
        'templateTradeClosed',
        DEFAULTS.templates.tradeClosed
      ),
    },
    courierPage: text(raw, 'courierPage', DEFAULTS.courierPage),
    disclaimerUrl: text(raw, 'disclaimerUrl', DEFAULTS.disclaimerUrl),
  };
}
