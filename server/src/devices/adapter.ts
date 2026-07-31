/**
 * The contract every device adapter implements.
 *
 * An adapter owns one way of talking to hardware — IPP over a CUPS binary, SNMP
 * over UDP, eventually a plain ping. Everything above this file (the poller, the
 * API, the UI) is written against these types and knows nothing about protocols.
 *
 * Two design points are load-bearing:
 *
 *  - **Capabilities are declared, not discovered.** An adapter says up front
 *    what it can report, and a probe narrows that to what a *particular* device
 *    reports. The alternative — calling and catching — turns "this printer has
 *    no queue" into an error on every poll, and means the UI cannot tell an
 *    empty queue from an absent one.
 *  - **`read` takes a section list** rather than exposing one method per kind of
 *    data. The poller already asks for subsets on different cadences, and one
 *    entry point is what makes single-flighting and per-device serialisation
 *    tractable.
 */
import type {
  DeviceState,
  MediaSource,
  PrintJob,
  Supply,
} from './types.js';

export type DeviceCapability = 'reachability' | 'supplies' | 'media' | 'jobs';

export const ALL_CAPABILITIES: readonly DeviceCapability[] = [
  'reachability',
  'supplies',
  'media',
  'jobs',
];

export function isCapability(value: string): value is DeviceCapability {
  return (ALL_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Failure taxonomy shared by every adapter.
 *
 * Deliberately about the *shape* of the failure rather than the protocol, so
 * the poller can decide whether a device is offline or misconfigured without
 * knowing how it was contacted.
 */
export type DeviceErrorCode =
  /** No answer within the timeout. Often a sleeping device, not a dead one. */
  | 'TIMEOUT'
  /** Refused, no route, or name resolution failed. */
  | 'UNREACHABLE'
  /** Answered, but not with something we could parse. */
  | 'BAD_RESPONSE'
  /** Answered and understood, but reported an error of its own. */
  | 'PROTOCOL_ERROR'
  /** Credentials rejected — a wrong community string or SNMPv3 user. */
  | 'AUTH'
  /** The stored configuration is unusable; no request was attempted. */
  | 'CONFIG';

export class DeviceError extends Error {
  override readonly name = 'DeviceError';
  // Declared as a field rather than a constructor parameter property, which
  // Node's type stripping cannot handle (it needs codegen, not just type
  // removal) and would break `npm test`.
  readonly code: DeviceErrorCode;

  constructor(message: string, code: DeviceErrorCode, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

// --- configuration -------------------------------------------------------

/**
 * One field of an adapter's configuration form.
 *
 * The admin UI is generated from these, which is what lets a new adapter ship
 * without any new React. `secret: true` fields are redacted in API responses
 * and never sent back to the browser.
 */
export interface ConfigField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  required?: boolean;
  secret?: boolean;
  default?: string | number | boolean;
  options?: readonly { value: string; label: string }[];
  help?: string;
  /** Shown only when another field has one of these values, e.g. SNMPv3 keys. */
  visibleWhen?: { key: string; values: readonly string[] };
}

// --- reading -------------------------------------------------------------

export interface DeviceIdentity {
  vendor: string | null;
  makeAndModel: string | null;
  serial: string | null;
  firmware: string | null;
}

export const UNKNOWN_IDENTITY: DeviceIdentity = {
  vendor: null,
  makeAndModel: null,
  serial: null,
  firmware: null,
};

/**
 * One reading from a device.
 *
 * Sections the caller did not ask for, or the device cannot provide, are
 * `undefined` — which is distinct from an empty array. An empty `jobs` means
 * "the queue is empty"; an absent `jobs` means "this device has no queue".
 * Collapsing the two would make an SNMP printer look like it had just finished
 * every job it was ever given.
 */
export interface DeviceReading {
  identity: DeviceIdentity;
  state: DeviceState;
  stateReasons: string[];
  supplies?: Supply[];
  media?: MediaSource[];
  jobs?: PrintJob[];
}

export interface ReadRequest {
  sections: readonly DeviceCapability[];
}

export interface ProbeResult {
  reachable: boolean;
  /**
   * 0–1, used to rank adapters during auto-detection. An adapter that got a
   * real answer from the right kind of device should score high; one that
   * merely opened a socket should not.
   */
  confidence: number;
  identity: DeviceIdentity;
  /** What *this* device supports, which may be narrower than the adapter's. */
  capabilities: DeviceCapability[];
  /** A live reading, so the admin UI can show what it found before saving. */
  sample?: DeviceReading;
  /**
   * Human-readable caveats, surfaced in the UI. This is where "toner readable
   * but trays report low/OK only" belongs — the difference between a device
   * that works and one that merely responds.
   */
  notes: string[];
}

export interface AdapterContext {
  timeoutMs: number;
  /** Host from the device registry, so config need not repeat it. */
  host: string;
}

export interface DeviceAdapter<TConfig = unknown> {
  readonly id: string;
  readonly label: string;
  /** The most this adapter can ever report. A probe narrows it per device. */
  readonly capabilities: readonly DeviceCapability[];
  readonly configSchema: readonly ConfigField[];

  /** Validates and normalises stored JSON. Throws `DeviceError` with `CONFIG`. */
  parseConfig(raw: unknown): TConfig;

  probe(config: TConfig, context: AdapterContext): Promise<ProbeResult>;

  read(
    config: TConfig,
    request: ReadRequest,
    context: AdapterContext,
  ): Promise<DeviceReading>;
}

// --- config helpers ------------------------------------------------------

export function configError(message: string): DeviceError {
  return new DeviceError(message, 'CONFIG');
}

export function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw configError('Device config must be a JSON object.');
  }
  return raw as Record<string, unknown>;
}

export function requiredString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw configError(`Missing required config field "${key}".`);
  }
  return value.trim();
}

export function optionalString(
  record: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

export function optionalNumber(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = record[key];
  if (value === undefined || value === null || value === '') return fallback;

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw configError(`Config field "${key}" must be a number.`);
  }
  return parsed;
}

export function oneOf<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = record[key];
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw configError(`Config field "${key}" must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}
