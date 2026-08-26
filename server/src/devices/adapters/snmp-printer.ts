/**
 * Generic SNMP printer adapter.
 *
 * Reads the RFC 3805 Printer MIB, which every mainstream printer vendor
 * implements to some degree. There is no vendor branching anywhere in the read
 * path — the only use of vendor identity is a display label and a probe
 * confidence nudge.
 *
 * It declares no `jobs` capability. The SNMP Job Monitoring MIB (RFC 2707) is
 * essentially never implemented, so a print queue means IPP.
 *
 * Honest limitation: the tray side of this is much weaker than the supply side.
 * Trays routinely answer with the "some remaining" sentinel and leave
 * `prtInputMediaName` blank, so expect loaded/not-loaded and a declared size
 * rather than a percentage.
 */
import {
  asRecord,
  configError,
  DeviceError,
  oneOf,
  optionalNumber,
  optionalString,
  UNKNOWN_IDENTITY,
  type AdapterContext,
  type ConfigField,
  type DeviceAdapter,
  type DeviceCapability,
  type DeviceReading,
} from '../adapter.js';
import {
  createClient,
  type AuthProtocol,
  type PrivProtocol,
  type SnmpClient,
  type SnmpConnection,
  type SnmpVersion,
} from '../snmp/client.js';
import {
  normalizeIdentity,
  normalizeMedia,
  normalizeState,
  normalizeSupplies,
  type SnmpWalk,
} from '../snmp/normalize.js';
import {
  HR_PRINTER,
  PRT_GENERAL,
  PRT_INPUT,
  PRT_MARKER_COLORANT,
  PRT_MARKER_SUPPLIES,
  SYS,
} from '../snmp/oids.js';

export interface SnmpConfig {
  port: number;
  version: SnmpVersion;
  community: string;
  username: string;
  authProtocol: AuthProtocol;
  authKey: string;
  privProtocol: PrivProtocol;
  privKey: string;
  retries: number;
}

const VERSIONS: readonly SnmpVersion[] = ['1', '2c', '3'];
const AUTH_PROTOCOLS: readonly AuthProtocol[] = ['none', 'md5', 'sha'];
const PRIV_PROTOCOLS: readonly PrivProtocol[] = ['none', 'des', 'aes'];

/**
 * v3 fields are present from the first release on purpose.
 *
 * Plenty of organisations disable v1/v2c outright, and adding the security
 * parameters later would be a breaking change to every stored device config.
 */
const CONFIG_SCHEMA: readonly ConfigField[] = [
  { key: 'port', label: 'Port', type: 'number', default: 161 },
  {
    key: 'version',
    label: 'SNMP version',
    type: 'select',
    default: '2c',
    options: [
      { value: '2c', label: 'v2c (most common)' },
      { value: '1', label: 'v1 (older devices)' },
      { value: '3', label: 'v3 (authenticated)' },
    ],
  },
  {
    key: 'community',
    label: 'Community string',
    type: 'string',
    secret: true,
    default: 'public',
    visibleWhen: { key: 'version', values: ['1', '2c'] },
    help: 'Read-only community. Stored per device, not globally.',
  },
  {
    key: 'username',
    label: 'Username',
    type: 'string',
    visibleWhen: { key: 'version', values: ['3'] },
  },
  {
    key: 'authProtocol',
    label: 'Authentication',
    type: 'select',
    default: 'none',
    options: [
      { value: 'none', label: 'None' },
      { value: 'md5', label: 'MD5' },
      { value: 'sha', label: 'SHA' },
    ],
    visibleWhen: { key: 'version', values: ['3'] },
  },
  {
    key: 'authKey',
    label: 'Authentication key',
    type: 'string',
    secret: true,
    visibleWhen: { key: 'version', values: ['3'] },
  },
  {
    key: 'privProtocol',
    label: 'Privacy',
    type: 'select',
    default: 'none',
    options: [
      { value: 'none', label: 'None' },
      { value: 'des', label: 'DES' },
      { value: 'aes', label: 'AES' },
    ],
    visibleWhen: { key: 'version', values: ['3'] },
  },
  {
    key: 'privKey',
    label: 'Privacy key',
    type: 'string',
    secret: true,
    visibleWhen: { key: 'version', values: ['3'] },
  },
  { key: 'retries', label: 'Retries', type: 'number', default: 1 },
];

/** Subtrees walked for a supplies/media read. */
const SUPPLY_SUBTREES: string[] = [PRT_MARKER_SUPPLIES.table, PRT_MARKER_COLORANT.table];
const MEDIA_SUBTREES: string[] = [PRT_INPUT.table];
const STATE_SUBTREES: string[] = [HR_PRINTER.status, HR_PRINTER.errorState];
const IDENTITY_OIDS: string[] = [SYS.descr, SYS.objectId, SYS.name];
const IDENTITY_SUBTREES: string[] = [PRT_GENERAL.printerName, PRT_GENERAL.serialNumber];

function connectionFor(config: SnmpConfig, context: AdapterContext): SnmpConnection {
  return {
    host: context.host,
    port: config.port,
    version: config.version,
    community: config.community,
    username: config.username,
    authProtocol: config.authProtocol,
    authKey: config.authKey,
    privProtocol: config.privProtocol,
    privKey: config.privKey,
    timeoutMs: context.timeoutMs,
    retries: config.retries,
  };
}

/**
 * Walks the subtrees needed for a request into one map.
 *
 * Sequential by design. Firing a dozen concurrent GETBULKs is a reliable way to
 * make a cheap printer network stack stop answering, and the poller is not in a
 * hurry.
 */
async function collect(client: SnmpClient, subtrees: string[], oids: string[]): Promise<SnmpWalk> {
  const walk: SnmpWalk = {};

  if (oids.length > 0) {
    Object.assign(walk, await client.get(oids));
  }
  for (const subtree of subtrees) {
    Object.assign(walk, await client.walk(subtree));
  }

  return walk;
}

async function readWalk(
  config: SnmpConfig,
  context: AdapterContext,
  sections: readonly DeviceCapability[],
): Promise<SnmpWalk> {
  const subtrees = [...STATE_SUBTREES, ...IDENTITY_SUBTREES];
  if (sections.includes('supplies')) subtrees.push(...SUPPLY_SUBTREES);
  if (sections.includes('media')) subtrees.push(...MEDIA_SUBTREES);

  const client = createClient(connectionFor(config, context));
  try {
    return await collect(client, subtrees, IDENTITY_OIDS);
  } finally {
    client.close();
  }
}

/** Builds a reading from an already-collected walk. Exported for tests. */
export function readingFromWalk(
  walk: SnmpWalk,
  sections: readonly DeviceCapability[],
): DeviceReading {
  const { state, stateReasons } = normalizeState(walk);
  const media = sections.includes('media') ? normalizeMedia(walk) : undefined;

  return {
    identity: normalizeIdentity(walk),
    state,
    stateReasons,
    ...(sections.includes('supplies') ? { supplies: normalizeSupplies(walk) } : {}),
    // An empty `prtInput` table is the SNMP equivalent of a printer answering
    // without `media-col-ready`: the walk succeeded and told us nothing about
    // the trays. Reported as "no evidence" so a sleeping device cannot blank
    // paper it is still holding — see poller/media-continuity.ts.
    ...(media === undefined ? {} : { media, mediaReported: media.length > 0 }),
  };
}

export const snmpPrinterAdapter: DeviceAdapter<SnmpConfig> = {
  id: 'snmp',
  label: 'Printer over SNMP (RFC 3805)',
  // No `jobs`: RFC 2707 is effectively never implemented.
  capabilities: ['reachability', 'supplies', 'media'],
  configSchema: CONFIG_SCHEMA,

  parseConfig(raw) {
    const record = asRecord(raw);
    const version = oneOf(record, 'version', VERSIONS, '2c');

    const config: SnmpConfig = {
      port: optionalNumber(record, 'port', 161),
      version,
      community: optionalString(record, 'community', 'public'),
      username: optionalString(record, 'username', ''),
      authProtocol: oneOf(record, 'authProtocol', AUTH_PROTOCOLS, 'none'),
      authKey: optionalString(record, 'authKey', ''),
      privProtocol: oneOf(record, 'privProtocol', PRIV_PROTOCOLS, 'none'),
      privKey: optionalString(record, 'privKey', ''),
      retries: optionalNumber(record, 'retries', 1),
    };

    if (config.port < 1 || config.port > 65535) {
      throw configError(`SNMP port must be between 1 and 65535, got ${config.port}.`);
    }

    if (version === '3') {
      if (config.username === '') {
        throw configError('SNMPv3 requires a username.');
      }
      // Catching this here rather than at request time turns a silent
      // authentication failure every poll into one clear message at save time.
      if (config.authProtocol !== 'none' && config.authKey === '') {
        throw configError('SNMPv3 authentication is enabled but no authentication key was given.');
      }
      if (config.privProtocol !== 'none' && config.privKey === '') {
        throw configError('SNMPv3 privacy is enabled but no privacy key was given.');
      }
      if (config.privProtocol !== 'none' && config.authProtocol === 'none') {
        throw configError('SNMPv3 privacy requires authentication as well.');
      }
    }

    return config;
  },

  async probe(config, context) {
    const notes: string[] = [];

    try {
      const walk = await readWalk(config, context, ['supplies', 'media']);
      const reading = readingFromWalk(walk, ['supplies', 'media']);

      const capabilities: DeviceCapability[] = ['reachability'];
      const supplies = reading.supplies ?? [];
      const media = reading.media ?? [];

      if (supplies.length > 0) {
        capabilities.push('supplies');

        // The distinction that matters for whether this device is actually
        // useful: responding is not the same as reporting numbers.
        const unusable = supplies.filter((supply) => supply.level.kind === 'unknown').length;
        if (unusable === supplies.length) {
          notes.push(
            `Found ${supplies.length} supplies, but none reported a usable level. Alerts cannot be evaluated for this device.`,
          );
        } else if (unusable > 0) {
          notes.push(`${unusable} of ${supplies.length} supplies did not report a level.`);
        }

        const coarse = supplies.filter((supply) => supply.level.kind === 'binary').length;
        if (coarse > 0) {
          notes.push(`${coarse} supplies report only "ok"/"low" rather than a percentage.`);
        }
      } else {
        notes.push('No supplies found. The device may not implement the Printer MIB.');
      }

      if (media.length > 0) {
        capabilities.push('media');
        if (media.every((source) => source.level.kind !== 'percent')) {
          notes.push('Paper trays report presence only, not a fill level.');
        }
      } else {
        notes.push('No paper inputs found.');
      }

      notes.push('SNMP cannot report a print queue; use the IPP adapter if you need one.');

      return {
        reachable: true,
        // Supplies with real levels is strong evidence of a printer speaking
        // the Printer MIB. A bare SNMP agent that answered sysDescr is not.
        confidence: capabilities.includes('supplies') ? 0.8 : 0.3,
        identity: reading.identity,
        capabilities,
        sample: reading,
        notes,
      };
    } catch (error) {
      const deviceError =
        error instanceof DeviceError
          ? error
          : new DeviceError(String(error), 'BAD_RESPONSE', { cause: error });

      return {
        reachable: false,
        confidence: 0,
        identity: UNKNOWN_IDENTITY,
        capabilities: [],
        notes: [`${deviceError.code}: ${deviceError.message}`],
      };
    }
  },

  async read(config, request, context) {
    const walk = await readWalk(config, context, request.sections);
    return readingFromWalk(walk, request.sections);
  },
};
