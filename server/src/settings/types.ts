/**
 * Settings shape and defaults, with no database dependency.
 *
 * Split from `settings.ts` so that pure logic (and its tests) can depend on
 * the types and defaults without importing the db client, which opens a SQLite
 * file as an import side effect.
 */

/**
 * Who may see the dashboard.
 *
 * `public` is the historical behaviour and stays the default: changing it on
 * upgrade would lock every existing viewer out of a hub they could read
 * yesterday. `passcode` gates the same pages behind a shared PIN, and
 * `admin_only` restricts them to a signed-in admin.
 */
export type AccessMode = 'public' | 'passcode' | 'admin_only';

export const ACCESS_MODES: readonly AccessMode[] = ['public', 'passcode', 'admin_only'];

export function isAccessMode(value: unknown): value is AccessMode {
  return ACCESS_MODES.includes(value as AccessMode);
}

/**
 * `system` follows the browser's own light/dark preference. `kiosk` is dark
 * with the navigation chrome stripped back, for a screen bolted to a wall that
 * nobody is going to click.
 */
export type ThemeName = 'system' | 'dark' | 'light' | 'kiosk';

export const THEMES: readonly ThemeName[] = ['system', 'dark', 'light', 'kiosk'];

export function isThemeName(value: unknown): value is ThemeName {
  return THEMES.includes(value as ThemeName);
}

export interface AppSettings {
  /**
   * Name of this hub, shown in the UI and used as the alert subject prefix.
   * Operator-owned so nothing identifying has to live in the source tree.
   */
  hubTitle: string;

  /** See `AccessMode`. The viewer passcode itself is hashed outside this record. */
  accessMode: AccessMode;

  theme: ThemeName;
  /**
   * Operator CSS appended to the SPA's own stylesheet.
   *
   * Stored verbatim but sanitised on write (see settings/branding.ts): it is
   * injected into a `<style>` element, so a stray closing tag would end the
   * element early and turn the rest into markup.
   */
  customCss: string;

  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  smtpFrom: string;
  /** Comma-separated in storage; always exposed as a trimmed array. */
  alertRecipients: string[];

  /**
   * Background poll cadence, which is also the alert evaluation cadence.
   *
   * Alert *thresholds* deliberately do not live here. They are rows in
   * `alert_rules`, so a per-device override is possible and so the number the
   * portal shows cannot drift from the number alerting uses.
   */
  backgroundPollMinutes: number;
  alertsEnabled: boolean;
}

export const DEFAULT_HUB_TITLE = 'KremboNet';

export const DEFAULT_SETTINGS: AppSettings = {
  hubTitle: DEFAULT_HUB_TITLE,

  // Matches how every pre-M4 hub behaved. An upgrade must not lock people out.
  accessMode: 'public',

  theme: 'system',
  customCss: '',

  smtpHost: '',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: '',
  smtpPassword: '',
  smtpFrom: '',
  alertRecipients: [],

  backgroundPollMinutes: 60,
  alertsEnabled: true,
};

/** Never leaves the server in an API response. */
export const SECRET_KEYS = new Set<keyof AppSettings>(['smtpPassword']);

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];

/**
 * Guards for the keys whose type is a union rather than a primitive.
 *
 * `parseValue` can only coerce by the shape of the default, so a hand-edited
 * `theme = purple` would otherwise reach the browser as a data attribute that
 * matches no stylesheet. Anything unrecognised falls back to the default, which
 * is the same promise the rest of the table makes.
 */
export const UNION_GUARDS: {
  [K in keyof AppSettings]?: (value: unknown) => boolean;
} = {
  accessMode: isAccessMode,
  theme: isThemeName,
};

/** Settings safe to send to the browser, with secrets reduced to a flag. */
export interface PublicSettings extends Omit<AppSettings, 'smtpPassword'> {
  smtpPasswordSet: boolean;
  /** True once a viewer passcode exists; the passcode itself never leaves. */
  viewerPasscodeSet: boolean;
}
