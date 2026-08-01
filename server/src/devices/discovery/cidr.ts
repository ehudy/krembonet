/**
 * CIDR parsing and the limits on what may be swept — pure, no sockets.
 *
 * Separated from the scanner because the interesting failures are arithmetic,
 * not network: an off-by-one at a subnet boundary, a `/8` that would emit
 * sixteen million addresses, or a typo that silently sweeps a stranger's
 * network instead of the office one. All of that is testable without a socket.
 */

/** Maximum addresses a single sweep may cover: a `/20`, i.e. 4094 hosts. */
export const MIN_PREFIX = 20;
export const MAX_HOSTS = 4094;

export interface ParsedSubnet {
  /** Canonical `network/prefix`, which may differ from what was typed. */
  cidr: string;
  network: string;
  broadcast: string | null;
  prefix: number;
  /** Addresses to probe, network and broadcast already removed. */
  hosts: string[];
  /** True when the range is RFC 1918, CGNAT, link-local, or loopback. */
  isPrivate: boolean;
}

export type CidrResult = { subnet: ParsedSubnet } | { error: string };

function toInt(octets: number[]): number {
  // `>>> 0` keeps this unsigned: the top bit of a 10.x or 192.x address makes
  // the shifted value negative otherwise, and every comparison below breaks.
  return (
    (((octets[0] as number) << 24) |
      ((octets[1] as number) << 16) |
      ((octets[2] as number) << 8) |
      (octets[3] as number)) >>>
    0
  );
}

function toDotted(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

function parseAddress(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    // Rejects '', '01', '1e2', ' 1' — anything Number() would happily coerce
    // into a plausible-looking address that is not the one the operator typed.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }

  return toInt(octets);
}

/**
 * Ranges a self-hosted LAN tool has any business sweeping.
 *
 * RFC 1918, CGNAT (100.64/10, which is what a lot of managed office kit sits
 * behind), link-local, and loopback.
 */
function isPrivateAddress(value: number): boolean {
  const first = (value >>> 24) & 0xff;
  const second = (value >>> 16) & 0xff;

  if (first === 10) return true;
  if (first === 127) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 169 && second === 254) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  return false;
}

/**
 * Parses `a.b.c.d/n` into the addresses to probe.
 *
 * Host bits in the input are ignored rather than rejected — `192.168.1.34/24`
 * means "the /24 that address is on", which is what someone reading their own
 * IP off a laptop will type. The canonical form comes back in `cidr` so the UI
 * can show what was actually swept.
 *
 * `/31` and `/32` are treated as RFC 3021 point-to-point and single-host
 * ranges: every address is a host, with no network or broadcast to exclude.
 */
export function parseCidr(input: string): CidrResult {
  const text = String(input ?? '').trim();
  const match = /^([0-9.]+)\/([0-9]{1,2})$/.exec(text);

  if (match === null) {
    return { error: 'Enter a subnet in CIDR form, for example 192.168.1.0/24.' };
  }

  const address = parseAddress(match[1] as string);
  if (address === null) {
    return { error: `"${match[1]}" is not a valid IPv4 address.` };
  }

  const prefix = Number(match[2]);
  if (prefix > 32) return { error: 'A prefix length cannot be greater than /32.' };

  if (prefix < MIN_PREFIX) {
    const size = 2 ** (32 - prefix);
    return {
      error: `/${prefix} covers ${size.toLocaleString()} addresses. Scan /${MIN_PREFIX} or smaller (at most ${MAX_HOSTS.toLocaleString()} hosts) — sweep large networks in pieces.`,
    };
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (address & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  const first = prefix >= 31 ? network : network + 1;
  const last = prefix >= 31 ? broadcast : broadcast - 1;

  const hosts: string[] = [];
  for (let value = first; value <= last; value += 1) hosts.push(toDotted(value));

  return {
    subnet: {
      cidr: `${toDotted(network)}/${prefix}`,
      network: toDotted(network),
      broadcast: prefix >= 31 ? null : toDotted(broadcast),
      prefix,
      hosts,
      // Checked on the network address: a range does not straddle the
      // private/public boundary at any prefix this accepts.
      isPrivate: isPrivateAddress(network),
    },
  };
}
