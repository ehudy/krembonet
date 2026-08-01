/**
 * Turning a subnet sweep into addable devices.
 *
 * The sweep answers "something is listening here". This answers "and it is a
 * Canon TZ-32000 that reports supplies over SNMP", by running the same probe
 * the manual "test connection" button runs. Reusing that path is the point: a
 * device found by discovery is identified by the identical code that would
 * identify it if someone typed the address in.
 *
 * Nothing here writes to the database. Discovery proposes; the operator adds.
 * A sweep that silently created device rows would be a nasty surprise on a
 * network with forty printers on it, only three of which anyone cares about.
 */
import type { DeviceCapability, DeviceIdentity } from '../adapter.js';
import type { RawConfig } from '../config-io.js';
import { probeAll, suggestedAdapter } from '../probe.js';
import { IPP_PORT, SNMP_PORT, sweepSubnet, type HostFinding, type SweepOptions } from './scan.js';

export interface DiscoveredDevice {
  host: string;
  /** Which of 631/161 answered. */
  ports: number[];
  /** Best-guess adapter id, or null when nothing identified it. */
  adapter: string | null;
  adapterLabel: string | null;
  identity: DeviceIdentity;
  capabilities: DeviceCapability[];
  confidence: number;
  notes: string[];
  /** A name the operator will probably keep, pre-filled in the add form. */
  suggestedName: string;
  /** Ready to POST to /api/admin/devices, secrets included. */
  config: RawConfig;
  /** True when a device with this address is already registered. */
  alreadyAdded: boolean;
}

export interface DiscoverOptions extends SweepOptions {
  /**
   * Hosts already registered, so the UI can grey them out rather than offering
   * to add a second copy of the plotter someone set up last week.
   */
  knownHosts: ReadonlySet<string>;
  /** Ceiling on how many responsive addresses get the full probe treatment. */
  maxProbes: number;
  /** Probes in flight at once. Lower than the sweep — these are real requests. */
  probeConcurrency: number;
}

export const DEFAULT_DISCOVER = {
  // A sweep can turn up a lot on a busy network; probing all of it would take
  // minutes. The cap is reported back so the UI can say the list was trimmed.
  maxProbes: 32,
  probeConcurrency: 6,
} as const;

/**
 * The config each adapter needs to probe this address.
 *
 * Only the adapters whose port actually answered are tried, which is what keeps
 * a sweep of a /24 from firing an `ipptool` subprocess at every SNMP-only
 * device on it.
 */
function candidateConfigs(finding: HostFinding, community: string): { adapter: string; config: RawConfig }[] {
  const candidates: { adapter: string; config: RawConfig }[] = [];

  if (finding.ports.includes(IPP_PORT)) {
    // The near-universal default path. A device that uses another one still
    // gets found; the operator edits the URI when they add it.
    candidates.push({
      adapter: 'ipp',
      config: { ippUri: `ipp://${finding.host}:${IPP_PORT}/ipp/print` },
    });
  }

  if (finding.ports.includes(SNMP_PORT)) {
    candidates.push({
      adapter: 'snmp',
      config: { port: SNMP_PORT, version: '2c', community },
    });
  }

  return candidates;
}

/**
 * Builds a display name from whatever the device was willing to say.
 *
 * Falls back to the address, never to a generic "Printer" — two devices both
 * called "Printer" is worse than two called by their IP, and the operator can
 * rename either.
 */
function nameFor(identity: DeviceIdentity, sysDescr: string | null, host: string): string {
  const model = identity.makeAndModel?.trim();
  if (model !== undefined && model !== '') return model.slice(0, 60);

  const vendor = identity.vendor?.trim();
  if (vendor !== undefined && vendor !== '') return `${vendor} (${host})`.slice(0, 60);

  // sysDescr is often a whole paragraph; its first line is usually the model.
  const firstLine = sysDescr?.split(/[\r\n]/)[0]?.trim();
  if (firstLine !== undefined && firstLine !== '') return firstLine.slice(0, 60);

  return host;
}

async function identify(
  finding: HostFinding,
  options: DiscoverOptions,
): Promise<DiscoveredDevice> {
  const candidates = candidateConfigs(finding, options.community);

  // Probe each candidate adapter with the config that adapter needs, then rank
  // them together. `probeAll` with one adapter at a time, rather than all
  // adapters against one config, because the two need different config shapes.
  const probes = [];
  for (const candidate of candidates) {
    probes.push(...(await probeAll(finding.host, candidate.config, candidate.adapter)));
  }
  probes.sort((a, b) => b.result.confidence - a.result.confidence);

  const winner = suggestedAdapter(probes);
  const best = probes.find((probe) => probe.adapter === winner) ?? probes[0];
  const chosen = candidates.find((candidate) => candidate.adapter === winner);

  const identity = best?.result.identity ?? {
    vendor: null,
    makeAndModel: null,
    serial: null,
    firmware: null,
  };

  return {
    host: finding.host,
    ports: finding.ports,
    adapter: winner,
    adapterLabel: winner === null ? null : (best?.label ?? null),
    identity,
    capabilities: best?.result.capabilities ?? [],
    confidence: best?.result.confidence ?? 0,
    notes: best?.result.notes ?? [],
    suggestedName: nameFor(identity, finding.sysDescr, finding.host),
    // Falls back to the first candidate so a host that answered but identified
    // as nothing is still addable — the operator may know what it is.
    config: chosen?.config ?? candidates[0]?.config ?? {},
    alreadyAdded: options.knownHosts.has(finding.host),
  };
}

export interface DiscoveryResult {
  scanned: number;
  responsive: number;
  /** True when more hosts answered than `maxProbes` allowed identifying. */
  truncated: boolean;
  devices: DiscoveredDevice[];
  elapsedMs: number;
}

export async function discover(
  hosts: readonly string[],
  options: DiscoverOptions,
): Promise<DiscoveryResult> {
  const startedAt = Date.now();

  const { findings, scanned } = await sweepSubnet(hosts, options);
  const probeTargets = findings.slice(0, options.maxProbes);

  const devices: DiscoveredDevice[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted === true) return;

      const index = cursor;
      cursor += 1;
      if (index >= probeTargets.length) return;

      devices.push(await identify(probeTargets[index] as HostFinding, options));
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, options.probeConcurrency), probeTargets.length || 1) },
      worker,
    ),
  );

  // Highest confidence first: the devices most likely to be what the operator
  // came looking for are the ones they should not have to scroll to.
  devices.sort((a, b) => b.confidence - a.confidence);

  return {
    scanned,
    responsive: findings.length,
    truncated: findings.length > probeTargets.length,
    devices,
    elapsedMs: Date.now() - startedAt,
  };
}
