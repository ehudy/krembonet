/**
 * Working out what one address speaks, before anyone commits to a config.
 *
 * The existing probe answers "does this adapter recognise this device", which
 * assumes someone already picked an adapter and filled in its settings. This
 * answers the question that comes first: an operator has an IP on a sticker and
 * no idea whether the thing behind it does IPP, SNMP, which SNMP, or only a web
 * page. Getting that wrong means a device added with settings that never poll.
 *
 * So every protocol this hub can use is tried, in the order that decides which
 * one is worth suggesting:
 *
 *   1. IPP on 631 — the best outcome, since it carries the live queue and the
 *      paper trays as well as supplies.
 *   2. SNMP v2c on 161 — supplies and status, no queue.
 *   3. SNMP v1 on 161 — the same, for older kit that refuses v2c.
 *   4. HTTP on 80/443 — not something this hub can poll at all, but worth
 *      reporting: it means the address is a live device with a web UI rather
 *      than empty space, which is the difference between "turn its protocols
 *      on" and "you have the wrong IP".
 *
 * HTTP is checked concurrently with the rest; the SNMP versions are sequential
 * for the same reason they are in the sweep — two GETs at different versions to
 * one UDP port is a good way to confuse an embedded agent.
 */
import type { DeviceCapability, DeviceIdentity } from '../adapter.js';
import type { RawConfig } from '../config-io.js';
import { probeAll, suggestedAdapter } from '../probe.js';
import {
  checkSnmpVersion,
  checkTcpPort,
  IPP_PORT,
  SNMP_PORT,
  SWEEP_SNMP_VERSIONS,
} from './scan.js';

export const HTTP_PORTS = [80, 443] as const;

/** How long each individual protocol test may take. */
export const SMART_PROBE_TIMEOUT_MS = 1500;

export interface SmartProbeProtocols {
  ipp: boolean;
  snmpV2c: boolean;
  snmpV1: boolean;
  http: boolean;
}

export interface SmartProbeResult {
  host: string;
  /** True when anything at all answered — the "wrong IP" check. */
  reachable: boolean;
  protocols: SmartProbeProtocols;
  /** The adapter to configure, or null when nothing this hub polls answered. */
  adapter: string | null;
  adapterLabel: string | null;
  /** Which SNMP version to use, when SNMP is the answer. */
  snmpVersion: '1' | '2c' | null;
  /** The community that worked. Echoed back so the form can be filled in. */
  community: string | null;
  /** Ready to drop into the add-device form for the suggested adapter. */
  config: RawConfig;
  identity: DeviceIdentity;
  capabilities: DeviceCapability[];
  notes: string[];
}

const UNKNOWN: DeviceIdentity = {
  vendor: null,
  makeAndModel: null,
  serial: null,
  firmware: null,
};

/** True when any of the web ports answers — used only to say "something is there". */
async function checkHttp(host: string, timeoutMs: number): Promise<boolean> {
  const results = await Promise.all(
    HTTP_PORTS.map((port) => checkTcpPort(host, port, timeoutMs)),
  );
  return results.includes(true);
}

/**
 * Tries every protocol against one address and reports what to configure.
 *
 * Never throws for an unreachable address: "nothing answered" is the most
 * common real answer and is returned as data, not as an error the form has to
 * catch and translate.
 */
export async function smartProbe(
  host: string,
  community: string,
  timeoutMs: number = SMART_PROBE_TIMEOUT_MS,
): Promise<SmartProbeResult> {
  const [ippOpen, http] = await Promise.all([
    checkTcpPort(host, IPP_PORT, timeoutMs),
    checkHttp(host, timeoutMs),
  ]);

  // Sequential, highest version first, and stopping at the first that answers:
  // a device that speaks v2c has no reason to be asked about v1.
  let snmpVersion: '1' | '2c' | null = null;
  for (const version of SWEEP_SNMP_VERSIONS) {
    const sysDescr = await checkSnmpVersion(host, community, version, timeoutMs);
    if (sysDescr !== null) {
      snmpVersion = version;
      break;
    }
  }

  const protocols: SmartProbeProtocols = {
    ipp: ippOpen,
    snmpV2c: snmpVersion === '2c',
    snmpV1: snmpVersion === '1',
    http,
  };

  // Candidate configs for whatever answered, richest protocol first. Only the
  // ports that replied are probed, so an SNMP-only device never has an
  // `ipptool` subprocess fired at it.
  const candidates: { adapter: string; config: RawConfig }[] = [];
  if (ippOpen) {
    candidates.push({
      adapter: 'ipp',
      config: { ippUri: `ipp://${host}:${IPP_PORT}/ipp/print` },
    });
  }
  if (snmpVersion !== null) {
    candidates.push({
      adapter: 'snmp',
      config: { port: SNMP_PORT, version: snmpVersion, community },
    });
  }

  const probes = [];
  for (const candidate of candidates) {
    probes.push(...(await probeAll(host, candidate.config, candidate.adapter)));
  }
  probes.sort((a, b) => b.result.confidence - a.result.confidence);

  const winner = suggestedAdapter(probes);
  const best = probes.find((probe) => probe.adapter === winner) ?? probes[0];
  const chosen = candidates.find((candidate) => candidate.adapter === winner);

  return {
    host,
    // HTTP counts: it cannot be polled, but it proves the address is live,
    // which is what an operator needs to know before re-checking the sticker.
    reachable: ippOpen || snmpVersion !== null || http,
    protocols,
    adapter: winner,
    adapterLabel: winner === null ? null : (best?.label ?? null),
    snmpVersion,
    community: snmpVersion === null ? null : community,
    // Falls back to the first candidate so an address that answered but
    // identified as nothing is still configurable by hand.
    config: chosen?.config ?? candidates[0]?.config ?? {},
    identity: best?.result.identity ?? { ...UNKNOWN },
    capabilities: best?.result.capabilities ?? [],
    notes: best?.result.notes ?? [],
  };
}
