/**
 * Settings shape and defaults, with no database dependency.
 *
 * Split from `settings.ts` so that pure logic (and its tests) can depend on
 * the types and defaults without importing the db client, which opens a SQLite
 * file as an import side effect.
 */

export interface AppSettings {
  /**
   * Name of this hub, shown in the UI and used as the alert subject prefix.
   * Operator-owned so nothing identifying has to live in the source tree.
   */
  hubTitle: string;

  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  smtpFrom: string;
  /** Comma-separated in storage; always exposed as a trimmed array. */
  alertRecipients: string[];

  /** Ink cartridges alert at or below this. */
  inkThresholdPercent: number;
  /**
   * Waste receptacles alert at or above this. Separate from the ink threshold
   * because the number counts the other way — see
   * docs/canon-tz32000-field-notes.md §4.
   */
  wasteThresholdPercent: number;
  /**
   * How far a supply must recover past its threshold before the alert clears.
   * Without it, a level hovering on the boundary re-sends on every poll.
   */
  hysteresisPercent: number;

  /** Background poll cadence, which is also the alert evaluation cadence. */
  backgroundPollMinutes: number;
  alertsEnabled: boolean;
}

export const DEFAULT_HUB_TITLE = 'KremboNet';

export const DEFAULT_SETTINGS: AppSettings = {
  hubTitle: DEFAULT_HUB_TITLE,

  smtpHost: '',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: '',
  smtpPassword: '',
  smtpFrom: '',
  alertRecipients: [],

  inkThresholdPercent: 15,
  wasteThresholdPercent: 85,
  hysteresisPercent: 5,

  backgroundPollMinutes: 60,
  alertsEnabled: true,
};

/** Never leaves the server in an API response. */
export const SECRET_KEYS = new Set<keyof AppSettings>(['smtpPassword']);

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];

/** Settings safe to send to the browser, with secrets reduced to a flag. */
export interface PublicSettings extends Omit<AppSettings, 'smtpPassword'> {
  smtpPasswordSet: boolean;
}
