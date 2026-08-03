/**
 * Sweeping a subnet for things that might be printers.
 *
 * Two probes per address, because the two protocols this hub speaks are not
 * detectable the same way:
 *
 *  - **IPP/631** is TCP, so a connect that completes is the answer. The socket
 *    is destroyed immediately; nothing is sent.
 *  - **SNMP/161** is UDP, where "no reply" and "nothing listening" are the same
 *    observation. A closed UDP port answers with an ICMP unreachable that Node
 *    does not surface reliably, so the only honest test is a real SNMP GET —
 *    which means a community string, and means a device using a non-default one
 *    will not be found. That limitation is surfaced in the UI rather than
 *    papered over.
 *
 * Concurrency is bounded and the per-host timeout is short. A sweep is a burst
 * of a few hundred connections across a network someone else is working on, and
 * the polite version of this feature is the only version worth shipping.
 */
import { Socket } from 'node:net';

import { createClient, type SnmpVersion } from '../snmp/client.js';
import { SYS } from '../snmp/oids.js';

export const IPP_PORT = 631;
export const SNMP_PORT = 161;

/**
 * The community versions a sweep will try, in order.
 *
 * v2c first because it is what almost everything made this century speaks and
 * what the rest of this codebase defaults to; v1 second because a surprising
 * number of older office printers — and a few current ones with SNMP locked
 * down to "legacy" — answer only that. Trying v1 first would slow every modern
 * device down for the sake of the minority.
 *
 * v3 is deliberately absent: it needs a username and keys, which a sweep has no
 * way to guess, so a v3-only device is invisible here and has to be added by
 * hand. That is a real limit, and an honest one.
 */
export const SWEEP_SNMP_VERSIONS: readonly Extract<SnmpVersion, '1' | '2c'>[] = [
  '2c',
  '1',
];

export interface SweepOptions {
  /** Per-host, per-protocol budget. Deliberately short — this is a LAN. */
  timeoutMs: number;
  /** How many addresses are in flight at once. */
  concurrency: number;
  /** SNMP community to try. Devices using another one stay invisible. */
  community: string;
  /** Abandons the sweep early, e.g. when the overall deadline passes. */
  signal?: AbortSignal;
}

export const DEFAULT_SWEEP: Omit<SweepOptions, 'signal'> = {
  // Long enough for a busy embedded network stack on a local segment, short
  // enough that 254 dead addresses do not dominate the wall clock.
  timeoutMs: 700,
  concurrency: 48,
  community: 'public',
};

export interface HostFinding {
  host: string;
  /** Ports that answered, in the order they are listed above. */
  ports: number[];
  /** sysDescr, when SNMP answered — a free first look at what this is. */
  sysDescr: string | null;
  /** Which SNMP version actually answered, or null when none did. */
  snmpVersion: '1' | '2c' | null;
}

/**
 * Completes when a TCP connection is established, times out, or is refused.
 *
 * Resolves rather than rejects: a refused connection is the expected result for
 * most of a subnet and is not an error worth constructing.
 */
export function checkTcpPort(
  host: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;

    const finish = (open: boolean): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(open);
    };

    const onAbort = (): void => finish(false);

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/**
 * A single SNMP GET of sysDescr at one version, used purely as a liveness test.
 *
 * No retries: a sweep is not the place to spend three timeouts on an address
 * that is probably a printer nobody plugged in. The full probe that runs
 * afterwards is where accuracy matters.
 */
export async function checkSnmpVersion(
  host: string,
  community: string,
  version: '1' | '2c',
  timeoutMs: number,
): Promise<string | null> {
  const client = createClient({
    host,
    port: SNMP_PORT,
    version,
    community,
    username: '',
    authProtocol: 'none',
    authKey: '',
    privProtocol: 'none',
    privKey: '',
    timeoutMs,
    retries: 0,
  });

  try {
    const walk = await client.get([SYS.descr]);
    const descr = walk[SYS.descr];
    if (descr === undefined) return null;
    return typeof descr === 'string' ? descr : String(descr);
  } catch {
    return null;
  } finally {
    client.close();
  }
}

export interface SnmpFinding {
  sysDescr: string;
  version: '1' | '2c';
}

/**
 * Tries each community version in turn and reports the first that answers.
 *
 * Sequential, not concurrent: two simultaneous GETs at different versions to
 * the same UDP port is a good way to confuse an embedded agent, and the second
 * attempt is only wanted when the first came back silent anyway.
 *
 * The cost is real and worth stating — an address with nothing on 161 now
 * burns two timeouts instead of one, which roughly doubles the SNMP half of a
 * sweep over dead space. That is the price of finding the v1-only devices,
 * which were previously invisible.
 */
export async function checkSnmp(
  host: string,
  community: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SnmpFinding | null> {
  for (const version of SWEEP_SNMP_VERSIONS) {
    if (signal?.aborted === true) return null;

    const sysDescr = await checkSnmpVersion(host, community, version, timeoutMs);
    if (sysDescr !== null) return { sysDescr, version };
  }

  return null;
}

async function inspect(host: string, options: SweepOptions): Promise<HostFinding | null> {
  if (options.signal?.aborted === true) return null;

  // The IPP check runs alongside the SNMP chain rather than before it. The
  // requested order — IPP, then v2c, then v1 — is about which *answer* wins and
  // which SNMP version is tried first, and both hold here: the SNMP versions
  // are strictly sequential, and IPP is reported first in `ports` regardless of
  // which returned sooner. Serialising the two protocols as well would make a
  // dead address cost three timeouts instead of two, which on a /24 of mostly
  // empty space is the difference between a sweep someone waits through and one
  // they cancel.
  const [ippOpen, snmp] = await Promise.all([
    checkTcpPort(host, IPP_PORT, options.timeoutMs, options.signal),
    checkSnmp(host, options.community, options.timeoutMs, options.signal),
  ]);

  const ports: number[] = [];
  if (ippOpen) ports.push(IPP_PORT);
  if (snmp !== null) ports.push(SNMP_PORT);

  if (ports.length === 0) return null;
  return {
    host,
    ports,
    sysDescr: snmp?.sysDescr ?? null,
    snmpVersion: snmp?.version ?? null,
  };
}

/**
 * Runs `inspect` across the address list with a fixed number of workers.
 *
 * A worker pool rather than chunked `Promise.all`, so one slow address holds up
 * one slot instead of stalling an entire batch behind it.
 */
export async function sweepSubnet(
  hosts: readonly string[],
  options: SweepOptions,
): Promise<{ findings: HostFinding[]; scanned: number }> {
  const findings: HostFinding[] = [];
  let cursor = 0;
  let scanned = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted === true) return;

      const index = cursor;
      cursor += 1;
      if (index >= hosts.length) return;

      const finding = await inspect(hosts[index] as string, options);
      scanned += 1;
      if (finding !== null) findings.push(finding);
    }
  };

  const workers = Array.from(
    { length: Math.min(Math.max(1, options.concurrency), hosts.length || 1) },
    worker,
  );
  await Promise.all(workers);

  // Sorted numerically, not lexically: 192.168.1.9 belongs before .10, and a
  // string sort puts it after .100.
  findings.sort((a, b) => compareAddresses(a.host, b.host));

  return { findings, scanned };
}

function compareAddresses(a: string, b: string): number {
  const parse = (value: string): number[] => value.split('.').map(Number);
  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < 4; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
