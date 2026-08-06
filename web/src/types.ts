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
  /**
   * The cartridge SKU extracted from the device's marker name (`GPR-66`), or
   * null when it carried none. Shown in tooltips and the reorder list — what to
   * actually order, kept separate from the colour the label shows.
   */
  partNumber: string | null;
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
  /**
   * True when the device has stopped listing this job but its engine has not
   * gone idle — a spooler drops a job when the upload finishes, not when the
   * paper stops. The state is then the printer's, not the job's, so the table
   * has to say the row is inferred.
   */
  lingering: boolean;
  /**
   * Epoch ms of the last poll at which the device itself listed the job.
   * Milliseconds rather than the ISO strings used by `lastSuccessAt` because
   * the server holds it as a number and converting a whole queue per request
   * buys nothing.
   */
  lastSeenAt: number;
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
  attention: AttentionLevel;
  attentionSummary: string | null;
  attentionReasons: string[];
  ttl: { suppliesSeconds: number; jobsSeconds: number };
}

/**
 * How badly a device needs someone to walk over to it.
 *
 * Decided server-side from the device's own state reasons — see
 * server/src/devices/attention.ts. `error` means it cannot print until
 * something is done; `warning` means it still can, but not for long.
 */
export type AttentionLevel = 'ok' | 'warning' | 'error';

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
  /** Consumables past their low threshold — reorder, not walk-over. */
  lowSupplies: number;
  /** Waste receptacles past their fill threshold — empty on the way past. */
  wasteFull: number;
  activeJobs: number;
  attention: AttentionLevel;
  /** One phrase for a status pill, e.g. "Paper out" or "Paper jam +1". */
  attentionSummary: string | null;
  /** Every condition, most severe first. */
  attentionReasons: string[];
  /**
   * True when this device will not shout — today that means maintenance mode.
   * Kept distinct from `isMuted` because the card reads it as a question about
   * behaviour rather than about which switch is set.
   */
  alertsSuppressed: boolean;
  /** Maintenance mode: no alert rule fires for this device. */
  isMuted: boolean;
}

export interface DeviceListResponse {
  backgroundPollMinutes: number;
  devices: DeviceSummary[];
}

// --- fleet-wide views -----------------------------------------------------

/** Fields every fleet response repeats, so a row can name its device. */
export interface FleetDeviceRef {
  slug: string;
  displayName: string;
  location: string | null;
  model: string | null;
  host: string;
  isOnline: boolean;
  lastSuccessAt: string | null;
}

export interface FleetSupplyDevice extends FleetDeviceRef {
  /** Empty for a device that has never been polled, and for one with no supplies. */
  supplies: Supply[];
}

export interface SupplyMatrixResponse {
  devices: FleetSupplyDevice[];
}

export interface FleetMediaDevice extends FleetDeviceRef {
  media: MediaSource[];
}

export interface MediaCatalogResponse {
  devices: FleetMediaDevice[];
}

/**
 * What happened, as opposed to who was told about it.
 *
 * `offline` and `recovered` are the two edges of one condition rather than one
 * category reported twice — a timeline needs to distinguish them.
 */
export type ActivityEventType = 'offline' | 'recovered' | 'supply_low' | 'media_error';

export interface ActivityEvent {
  id: number;
  deviceId: number | null;
  /** Null once the device is deleted; the event still names it. */
  deviceSlug: string | null;
  /** The device's name at the time, which is what makes an old row meaningful. */
  deviceName: string;
  type: ActivityEventType;
  message: string;
  createdAt: string;
}

export interface ActivityResponse {
  events: ActivityEvent[];
}

export type AccessMode = 'public' | 'passcode' | 'admin_only';

export type ThemeName = 'system' | 'dark' | 'light' | 'kiosk';

export type LanguageName = 'system' | 'en' | 'es';

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
  language: LanguageName;
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
  language: LanguageName;
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

/** The four things an alert rule can watch for. */
export type AlertConditionType = 'offline' | 'supply_low' | 'waste_full' | 'media_out';

export type AlertRuleScope = 'all' | 'selected';

/**
 * How often a rule repeats while a condition stays true.
 *
 * `once` is edge-triggered — the behaviour that stops a cartridge at 10%
 * mailing every hour forever. The repeats are for conditions nobody can act on
 * quickly, like a plotter offline over a weekend.
 */
export type AlertRepeatInterval = 'once' | '1h' | '12h' | '24h';

/**
 * One delivery policy: what to watch, on which printers, and who to tell.
 *
 * Distinct from the hub's supply *thresholds*, which live on the Settings page
 * and decide when a bar turns red. These decide whether that condition is worth
 * a message. A hub with no rules sends nothing at all.
 */
/** The number each condition fires on. Null means the hub's own mark. */
export interface AlertRuleThresholds {
  offlineMinutes: number | null;
  supplyPercent: number | null;
  wastePercent: number | null;
}

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Fires when any one of these holds. Never empty on a rule the server stored. */
  conditions: AlertConditionType[];
  /** False for a rule this build cannot read — listed so it can be fixed. */
  isReadable: boolean;
  scope: AlertRuleScope;
  deviceIds: number[];
  thresholds: AlertRuleThresholds;
  repeatInterval: AlertRepeatInterval | string;
  notifyEmail: boolean;
  /** Empty falls back to the global SMTP recipients. */
  customRecipients: string[];
  webhookIds: number[];
  createdAt: string | number;
  updatedAt: string | number;
}

export interface MediaType {
  id: number;
  /** Null for a global mapping; a device id for a per-device override. */
  deviceId: number | null;
  code: string;
  friendlyName: string;
  vendor: string | null;
  isSeeded: boolean;
  updatedAt: string | number;
}

/** A raw paper code seen in a printer's telemetry, and whether it is named yet. */
export interface DiscoveredMediaCode {
  code: string;
  /** Null when no operator has named this code yet. */
  friendlyName: string | null;
  isMapped: boolean;
  /** Every device currently reporting the code. */
  devices: { slug: string; displayName: string }[];
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
  isMuted: boolean;
}

export interface DeviceIdentity {
  vendor: string | null;
  makeAndModel: string | null;
  serial: string | null;
  firmware: string | null;
}

export interface ProbeReading {
  identity: DeviceIdentity;
  /** Absent when the read did not establish what the device is doing. */
  state?: DeviceState;
  stateReasons?: string[];
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
/** Which SNMP version answered. v3 needs credentials a sweep cannot guess. */
export type SnmpSweepVersion = '1' | '2c';

/**
 * What an address speaks.
 *
 * IPP carries the live queue and paper trays as well as supplies; SNMP carries
 * supplies and status only. The difference is worth telling an operator, since
 * it is the reason to go and switch IPP on.
 */
export interface ProtocolSupport {
  ipp: boolean;
  snmp: boolean;
}

export interface DiscoveredDevice {
  host: string;
  /** Which of 631 (IPP) / 161 (SNMP) answered. */
  ports: number[];
  /** The SNMP version that replied, or null when SNMP did not. */
  snmpVersion: SnmpSweepVersion | null;
  protocols: ProtocolSupport;
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

/** Every protocol the smart probe tests against one address. */
export interface SmartProbeProtocols {
  ipp: boolean;
  snmpV2c: boolean;
  snmpV1: boolean;
  /** Not pollable — only proof the address is a live device with a web UI. */
  http: boolean;
}

export interface SmartProbeResponse {
  host: string;
  /** True when anything answered at all, web UI included. */
  reachable: boolean;
  protocols: SmartProbeProtocols;
  adapter: string | null;
  adapterLabel: string | null;
  snmpVersion: SnmpSweepVersion | null;
  community: string | null;
  /** Ready to drop into the add-device form for the suggested adapter. */
  config: Record<string, unknown>;
  identity: DeviceIdentity;
  capabilities: string[];
  notes: string[];
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
