/**
 * Mirrors the server's API payloads.
 *
 * Kept as a hand-written copy rather than imported from the server workspace:
 * the server compiles with NodeNext and the SPA with a bundler resolver, and
 * wiring a shared build for a handful of interfaces costs more than it saves.
 */

export type PrinterState = 'idle' | 'processing' | 'stopped' | 'unknown';

export type JobState =
  | 'pending'
  | 'pending-held'
  | 'processing'
  | 'processing-stopped'
  | 'canceled'
  | 'aborted'
  | 'completed'
  | 'unknown';

export interface Supply {
  index: number;
  name: string;
  label: string;
  /** `ink` counts down toward empty; `waste` counts up toward full. */
  kind: 'ink' | 'waste';
  percent: number;
  colorHex: string;
}

export interface Roll {
  source: string;
  label: string;
  isLoaded: boolean;
  mediaTypeCode: string | null;
  /** Null when the code is not in the lookup table — show the code instead. */
  mediaTypeName: string | null;
  widthMm: number | null;
  widthInches: number | null;
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

export interface PrinterStatus {
  slug: string;
  displayName: string;
  model: string | null;
  host: string;
  state: PrinterState;
  stateReasons: string[];
  supplies: Supply[];
  rolls: Roll[];
  jobs: Job[];
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

export interface PrinterSummary {
  slug: string;
  displayName: string;
  model: string | null;
  host: string;
  state: PrinterState;
  isOnline: boolean;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lowSupplies: number;
  activeJobs: number;
}

export interface PrinterListResponse {
  backgroundPollMinutes: number;
  printers: PrinterSummary[];
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
