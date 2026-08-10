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

/**
 * UI language. `system` follows each visitor's browser.
 *
 * A hub setting rather than a per-browser one, for the same reason the theme
 * is: a shared appliance on a wall or a shop floor should read the same to
 * everyone who walks up to it. `system` is the escape hatch for a mixed office.
 */
export type LanguageName = 'system' | 'en' | 'es';

export const LANGUAGES: readonly LanguageName[] = ['system', 'en', 'es'];

export function isLanguageName(value: unknown): value is LanguageName {
  return LANGUAGES.includes(value as LanguageName);
}

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

  /**
   * The line under the hub name in the sidebar.
   *
   * Empty is a real choice, not a missing value: a blank subtitle hides the
   * element entirely rather than falling back to a default, so an operator who
   * wants just a name can have just a name. `DEFAULT_HUB_SUBTITLE` is only the
   * value a fresh install starts with.
   */
  hubSubtitle: string;

  /**
   * Optional logo, shown in place of the hub name.
   *
   * A URL rather than an upload: this hub has no asset store, and adding one to
   * hold a single image would be a lot of moving parts. An inline `data:` URI
   * works and is the usual answer on a LAN with no web server to host from.
   */
  logoUrl: string;

  /**
   * Optional favicon, shown as the browser tab icon.
   *
   * Stored the same way as `logoUrl` — a URL or an inline `data:` URI — but a
   * separate field because a wordmark logo and a tab-sized icon are rarely the
   * same image. Blank is a real choice: it means "reuse the logo", and the
   * client resolves `faviconUrl -> logoUrl -> /favicon.ico` so a hub that only
   * sets a logo still gets a matching tab icon for free.
   */
  faviconUrl: string;

  /** See `AccessMode`. The viewer passcode itself is hashed outside this record. */
  accessMode: AccessMode;

  theme: ThemeName;
  language: LanguageName;
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

  /**
   * Whether to ask GitHub, once a day, whether a newer release exists.
   *
   * The only outbound connection this hub makes on its own initiative. It
   * sends nothing about the install — no identifier, no device list, no
   * telemetry — but it is still a request to a third party from a tool whose
   * whole premise is staying on the local network, so it is a documented,
   * visible switch rather than something buried.
   *
   * On by default: an out-of-date self-hosted service is a security problem,
   * and an update nobody hears about does not get applied.
   */
  updateCheckEnabled: boolean;
}

export const DEFAULT_HUB_TITLE = 'KremboNet';
export const DEFAULT_HUB_SUBTITLE = 'Local device telemetry';

export const DEFAULT_SETTINGS: AppSettings = {
  hubTitle: DEFAULT_HUB_TITLE,
  hubSubtitle: DEFAULT_HUB_SUBTITLE,
  logoUrl: '',
  faviconUrl: '',

  // Matches how every pre-M4 hub behaved. An upgrade must not lock people out.
  accessMode: 'public',

  theme: 'system',
  language: 'system',
  customCss: '',

  smtpHost: '',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: '',
  smtpPassword: '',
  smtpFrom: '',
  alertRecipients: [],

  backgroundPollMinutes: 60,
  updateCheckEnabled: true,
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
  language: isLanguageName,
};

/** Settings safe to send to the browser, with secrets reduced to a flag. */
export interface PublicSettings extends Omit<AppSettings, 'smtpPassword'> {
  smtpPasswordSet: boolean;
  /** True once a viewer passcode exists; the passcode itself never leaves. */
  viewerPasscodeSet: boolean;
}
