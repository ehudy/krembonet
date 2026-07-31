/**
 * Mirrors the server's API payloads.
 *
 * Kept as a hand-written copy rather than imported from the server workspace:
 * the server compiles with NodeNext and the SPA with a bundler resolver, and
 * wiring a shared build for a handful of interfaces costs more than it saves.
 */

export type DeviceState = 'idle' | 'processing' | 'stopped' | 'unknown';

export type JobState =
  | 'pending'
  | 'pending-held'
  | 'processing'
  | 'processing-stopped'
  | 'canceled'
  | 'aborted'
  | 'completed'
  | 'unknown';

export type SupplyUnit =
  | 'percent'
  | 'impressions'
  | 'sheets'
  | 'millilitres'
  | 'hours'
  | 'other';

/**
 * How much of a supply is left.
 *
 * Not a plain number, because devices routinely decline to give one. See the
 * server's devices/types.ts for the reasoning; the short version is that an
 * invented percentage is worse than an honest "unknown".
 */
export type SupplyLevel =
  | { kind: 'percent'; percent: number }
  | { kind: 'absolute'; value: number; max: number; unit: SupplyUnit }
  | { kind: 'binary'; state: 'ok' | 'attention' }
  | { kind: 'unknown' };

export type SupplyKind = 'consumable' | 'receptacle';

export interface Supply {
  index: number;
  name: string;
  label: string;
  /** `consumable` counts down toward empty; `receptacle` counts up toward full. */
  kind: SupplyKind;
  type: string;
  level: SupplyLevel;
  /**
   * The comparable 0-100 value, computed server-side so the browser never
   * re-derives it. Null when the device reported no number.
   */
  percent: number | null;
  /**
   * True when this supply is past its alert threshold, decided server-side by
   * the same rules that send the mail. The UI must not re-derive this: the two
   * copies drifting is exactly the bug this replaced.
   */
  breached: boolean;
  /** Null when the device reports no colour; the UI picks its own. */
  colorHex: string | null;
}

export type MediaSourceType = 'roll' | 'sheet-tray' | 'manual' | 'unknown';

export interface MediaSource {
  key: string;
  label: string;
  type: MediaSourceType;
  isLoaded: boolean;
  mediaTypeCode: string | null;
  /** Null when the code is not in the lookup table — show the code instead. */
  mediaTypeName: string | null;
  widthMm: number | null;
  widthInches: number | null;
  lengthRemainingMm: number | null;
  level: SupplyLevel;
}

export interface Job {
  jobId: number;
  name: string;
  user: string;
  state: JobState;
  stateReasons: string | null;
  impressions: number | null;
  timeAtCreation: number | null;
}

export interface DeviceStatus {
  slug: string;
  displayName: string;
  location: string | null;
  model: string | null;
  host: string;
  adapter: string;
  state: DeviceState;
  stateReasons: string[];
  supplies: Supply[];
  media: MediaSource[];
  jobs: Job[];
  /** What this device reports, e.g. `["supplies","media","jobs"]`. */
  capabilities: string[];
  isOnline: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  suppliesUpdatedAt: string | null;
  jobsUpdatedAt: string | null;
  suppliesAgeSeconds: number;
  jobsAgeSeconds: number;
  servedAt: string;
  ttl: { suppliesSeconds: number; jobsSeconds: number };
}

export interface DeviceSummary {
  slug: string;
  displayName: string;
  location: string | null;
  model: string | null;
  host: string;
  adapter: string;
  state: DeviceState;
  capabilities: string[];
  isOnline: boolean;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  /** Supplies currently past their alert threshold, counted by the alert rules. */
  lowSupplies: number;
  activeJobs: number;
}

export interface DeviceListResponse {
  backgroundPollMinutes: number;
  devices: DeviceSummary[];
}

export interface AdminSettings {
  hubTitle: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpFrom: string;
  /** The password itself is never sent to the browser. */
  smtpPasswordSet: boolean;
  alertRecipients: string[];
  inkThresholdPercent: number;
  wasteThresholdPercent: number;
  hysteresisPercent: number;
  backgroundPollMinutes: number;
  alertsEnabled: boolean;
}

export interface MediaType {
  code: string;
  friendlyName: string;
  vendor: string | null;
  isSeeded: boolean;
  updatedAt: string | number;
}

export interface AlertStateRow {
  ruleKey: string;
  isActive: boolean;
  triggeredAt: string | number | null;
  clearedAt: string | number | null;
  lastNotifiedAt: string | number | null;
  notifyCount: number;
}

export interface AlertLogRow {
  id: number;
  ruleKey: string;
  subject: string;
  recipients: string;
  status: string;
  error: string | null;
  createdAt: string | number;
}

export interface SessionInfo {
  enabled: boolean;
  authenticated: boolean;
}
