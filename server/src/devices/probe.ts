/**
 * Asking every adapter whether it recognises an address.
 *
 * Lives here rather than in the route because two callers need it now: the
 * manual "test connection" button, and subnet discovery, which probes each
 * responsive address it finds. Sharing it means a device identified during a
 * sweep is identified by exactly the same code that would identify it if the
 * operator typed the address in by hand.
 */
import { config } from '../config.js';
import { DeviceError, type ProbeResult } from './adapter.js';
import type { RawConfig } from './config-io.js';
import { getAdapter, listAdapters } from './registry.js';

export interface AdapterProbe {
  adapter: string;
  label: string;
  result: ProbeResult;
}

const UNKNOWN = {
  vendor: null,
  makeAndModel: null,
  serial: null,
  firmware: null,
} as const;

/** Ranks adapters by how confident each is that it recognises the device. */
export async function probeAll(
  host: string,
  rawConfig: RawConfig,
  adapterId?: string,
): Promise<AdapterProbe[]> {
  const candidates = adapterId === undefined ? listAdapters() : [getAdapter(adapterId)];
  const results: AdapterProbe[] = [];

  for (const adapter of candidates) {
    try {
      const parsed = adapter.parseConfig(rawConfig);
      const result = await adapter.probe(parsed, {
        timeoutMs: config.deviceTimeoutMs,
        host,
      });
      results.push({ adapter: adapter.id, label: adapter.label, result });
    } catch (error) {
      // A config the adapter cannot even parse is a legitimate outcome when
      // probing every adapter at once — the IPP adapter needs a URI the SNMP
      // form never collects. Report it rather than failing the whole probe.
      const message = error instanceof DeviceError ? error.message : String(error);
      results.push({
        adapter: adapter.id,
        label: adapter.label,
        result: {
          reachable: false,
          confidence: 0,
          identity: { ...UNKNOWN },
          capabilities: [],
          notes: [message],
        },
      });
    }
  }

  return results.sort((a, b) => b.result.confidence - a.result.confidence);
}

/**
 * The adapter to suggest, or null.
 *
 * Only ever a suggestion — the admin picks. A probe that guesses wrong and
 * silently commits is worse than one that asks.
 */
export function suggestedAdapter(results: readonly AdapterProbe[]): string | null {
  const best = results[0];
  return best !== undefined && best.result.reachable && best.result.confidence > 0
    ? best.adapter
    : null;
}
