/**
 * IPP adapter.
 *
 * Wraps the existing `ipptool` stack — which is the best-tested code in the
 * project — behind the adapter interface without changing how it parses
 * anything. The normalisation lives in `../ipp/normalize.ts` and is unchanged.
 *
 * This is the only adapter that can report a print queue: SNMP's Job Monitoring
 * MIB (RFC 2707) is effectively never implemented, so a queue means IPP.
 */
import {
  asRecord,
  configError,
  DeviceError,
  requiredString,
  UNKNOWN_IDENTITY,
  type AdapterContext,
  type ConfigField,
  type DeviceAdapter,
  type DeviceCapability,
  type DeviceReading,
} from '../adapter.js';
import { IppError, ipptool } from '../ipp/ipptool.js';
import { normalizeJobs, normalizePrinterAttributes } from '../ipp/normalize.js';
import { getJobsQuery, getPrinterAttributesQuery } from '../ipp/queries.js';

export interface IppConfig {
  ippUri: string;
}

/**
 * Resource paths worth trying when probing a bare address.
 *
 * There is no discovery mechanism for this — vendors simply differ, and a URI
 * with the wrong path returns a protocol error rather than a redirect.
 */
export const COMMON_IPP_PATHS = [
  '/ipp/print',
  '/ipp/printer',
  '/ipp/port1',
  '/printers/print',
  '/',
] as const;

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'ippUri',
    label: 'IPP URI',
    type: 'string',
    required: true,
    help: 'e.g. ipp://printer.example:631/ipp/print — use ipps:// for TLS.',
  },
];

/** Maps the IPP layer's failure taxonomy onto the shared one. */
function toDeviceError(error: unknown, uri: string): DeviceError {
  if (error instanceof DeviceError) return error;

  if (error instanceof IppError) {
    const code =
      error.code === 'IPP_STATUS'
        ? 'PROTOCOL_ERROR'
        : error.code === 'TIMEOUT'
          ? 'TIMEOUT'
          : error.code === 'UNREACHABLE'
            ? 'UNREACHABLE'
            : 'BAD_RESPONSE';
    return new DeviceError(error.message, code, { cause: error });
  }

  return new DeviceError(`IPP request to ${uri} failed: ${String(error)}`, 'BAD_RESPONSE', {
    cause: error,
  });
}

async function readSupplies(
  config: IppConfig,
  context: AdapterContext,
): Promise<Omit<DeviceReading, 'jobs'>> {
  const response = await ipptool({
    uri: config.ippUri,
    query: getPrinterAttributesQuery(),
    timeoutMs: context.timeoutMs,
  });

  const snapshot = normalizePrinterAttributes(response.attributes);

  return {
    identity: {
      ...UNKNOWN_IDENTITY,
      makeAndModel: snapshot.makeAndModel,
    },
    state: snapshot.state,
    stateReasons: snapshot.stateReasons,
    supplies: snapshot.supplies,
    media: snapshot.media,
  };
}

export const ippPrinterAdapter: DeviceAdapter<IppConfig> = {
  id: 'ipp',
  label: 'Printer over IPP',
  capabilities: ['reachability', 'supplies', 'media', 'jobs'],
  configSchema: CONFIG_SCHEMA,

  parseConfig(raw) {
    const record = asRecord(raw);
    const ippUri = requiredString(record, 'ippUri');

    if (!/^ipps?:\/\//i.test(ippUri)) {
      throw configError(`"ippUri" must start with ipp:// or ipps://, got "${ippUri}".`);
    }

    return { ippUri };
  },

  async probe(config, context) {
    const notes: string[] = [];

    try {
      const reading = await readSupplies(config, context);
      const capabilities: DeviceCapability[] = ['reachability'];

      if ((reading.supplies?.length ?? 0) > 0) capabilities.push('supplies');
      else notes.push('Responded, but reported no supplies. Marker attributes may be unsupported.');

      if ((reading.media?.length ?? 0) > 0) capabilities.push('media');
      else notes.push('Reported no media sources.');

      // Asking for the queue is the only way to know whether it answers; an
      // empty queue is a success, an error is not.
      let jobs;
      try {
        const response = await ipptool({
          uri: config.ippUri,
          query: getJobsQuery('not-completed'),
          timeoutMs: context.timeoutMs,
        });
        jobs = normalizeJobs(response.attributes);
        capabilities.push('jobs');
      } catch {
        notes.push('Get-Jobs was refused, so the print queue will not be shown.');
      }

      return {
        reachable: true,
        // A device that answered Get-Printer-Attributes with real supply data
        // is unambiguously an IPP printer.
        confidence: capabilities.includes('supplies') ? 0.9 : 0.6,
        identity: reading.identity,
        capabilities,
        sample: { ...reading, ...(jobs === undefined ? {} : { jobs }) },
        notes,
      };
    } catch (error) {
      const deviceError = toDeviceError(error, config.ippUri);
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
    const wantsSupplies =
      request.sections.includes('supplies') || request.sections.includes('media');
    const wantsJobs = request.sections.includes('jobs');

    try {
      // Sequential rather than concurrent: the caller already serialises per
      // device, and issuing both at once is exactly what upsets fragile
      // printer network stacks.
      const base = wantsSupplies
        ? await readSupplies(config, context)
        : {
            identity: UNKNOWN_IDENTITY,
            state: 'unknown' as const,
            stateReasons: [],
          };

      if (!wantsJobs) return base;

      const response = await ipptool({
        uri: config.ippUri,
        query: getJobsQuery('not-completed'),
        timeoutMs: context.timeoutMs,
      });

      return { ...base, jobs: normalizeJobs(response.attributes) };
    } catch (error) {
      throw toDeviceError(error, config.ippUri);
    }
  },
};
