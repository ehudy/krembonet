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
  'percent' | 'impressions' | 'sheets' | 'millilitres' | 'hours' | 'other';

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

export type AccessMode = 'public' | 'passcode' | 'admin_only';

export type ThemeName = 'system' | 'dark' | 'light' | 'kiosk';

/**
 * What the hub knows about its own version.
 *
 * Every field except `currentVersion` is null when the update check is off,
 * has never succeeded, or could not reach GitHub — which are indistinguishable
 * on purpose. `updateAvailable` false is the only safe default.
 */
export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
}

/** Chrome the shell needs before anything else, from the open `/api/hub`. */
export interface HubBranding extends UpdateStatus {
  title: string;
  /** Blank means "show nothing", not "show a default". */
  subtitle: string;
  /** Blank means no logo; the text title is shown instead. */
  logoUrl: string;
  theme: ThemeName;
  customCss: string;
}

/** Whether this browser may read the dashboard, and what to do if not. */
export interface AccessStatus {
  mode: AccessMode;
  allowed: boolean;
  reason: 'passcode-required' | 'admin-required' | null;
  passcodeSet: boolean;
  isAdmin: boolean;
  isViewer: boolean;
}

export interface AdminSettings {
  hubTitle: string;
  hubSubtitle: string;
  logoUrl: string;
  accessMode: AccessMode;
  /** The passcode itself is never sent to the browser. */
  viewerPasscodeSet: boolean;
  theme: ThemeName;
  customCss: string;
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
  updateCheckEnabled: boolean;
  /** Present when saving changed the submitted CSS, e.g. an @import was stripped. */
  warnings?: string[];
}

export type WebhookFormat = 'discord' | 'slack' | 'ntfy' | 'generic';

export interface Webhook {
  id: number;
  name: string;
  format: WebhookFormat;
  url: string;
  enabled: boolean;
  /** Header names only — values may be tokens and never leave the server. */
  headerKeys: string[];
  headersSet: boolean;
  lastStatus: string | null;
  lastError: string | null;
  lastAttemptAt: string | number | null;
  createdAt: string | number;
  updatedAt: string | number;
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
  /** `email` or `webhook`. */
  channel: string;
  /** Addresses for email; the destination's name for a webhook. */
  recipients: string;
  status: string;
  error: string | null;
  createdAt: string | number;
}

export interface SessionInfo {
  enabled: boolean;
  authenticated: boolean;
}

// --- setup and device administration --------------------------------------

export interface SetupStatus {
  required: boolean;
}

export interface ConfigField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  required?: boolean;
  /** Never sent to the browser; the form shows a "stored" hint instead. */
  secret?: boolean;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  help?: string;
  /** Shown only when another field holds one of these values. */
  visibleWhen?: { key: string; values: string[] };
}

export interface AdapterInfo {
  id: string;
  label: string;
  capabilities: string[];
  configSchema: ConfigField[];
}

export interface AdminDevice {
  id: number;
  slug: string;
  displayName: string;
  location: string | null;
  adapter: string;
  /** False when the stored adapter id is no longer registered. */
  adapterKnown: boolean;
  host: string;
  enabled: boolean;
  vendor: string | null;
  model: string | null;
  serial: string | null;
  capabilities: string[] | null;
  config: Record<string, unknown>;
  /** Secret config keys that currently hold a value. */
  secretsSet: string[];
}

export interface DeviceIdentity {
  vendor: string | null;
  makeAndModel: string | null;
  serial: string | null;
  firmware: string | null;
}

export interface ProbeReading {
  identity: DeviceIdentity;
  state: DeviceState;
  stateReasons: string[];
  supplies?: Supply[];
  media?: MediaSource[];
  jobs?: Job[];
}

export interface ProbeOutcome {
  reachable: boolean;
  confidence: number;
  identity: DeviceIdentity;
  capabilities: string[];
  sample?: ProbeReading;
  /** Human-readable caveats: what responded, and what it declined to say. */
  notes: string[];
}

/** One address that answered a subnet sweep, after identification. */
export interface DiscoveredDevice {
  host: string;
  /** Which of 631 (IPP) / 161 (SNMP) answered. */
  ports: number[];
  adapter: string | null;
  adapterLabel: string | null;
  identity: DeviceIdentity;
  capabilities: string[];
  confidence: number;
  notes: string[];
  suggestedName: string;
  /** Ready to submit as a new device. */
  config: Record<string, unknown>;
  alreadyAdded: boolean;
}

export interface DiscoveryResponse {
  /** Canonical form of what was swept, which may differ from what was typed. */
  subnet: string;
  hostCount: number;
  scanned: number;
  responsive: number;
  /** More hosts answered than the server was willing to identify. */
  truncated: boolean;
  /** The overall deadline cut the sweep short; results are partial. */
  timedOut: boolean;
  devices: DiscoveredDevice[];
  elapsedMs: number;
}

export interface ProbeResponse {
  host: string;
  results: { adapter: string; label: string; result: ProbeOutcome }[];
  /** Highest-confidence adapter, or null when nothing answered. */
  suggested: string | null;
}
