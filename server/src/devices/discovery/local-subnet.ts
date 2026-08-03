/**
 * Working out which subnet the hub itself is on.
 *
 * The discovery form used to open on a hardcoded `192.168.1.0/24`, which is
 * right for a lot of home routers and wrong for most offices — so the first
 * thing an operator did was clear it and type their own, having first gone to
 * find out what it was. The server already knows: it has an address on that
 * network. Pre-filling from it turns the common case into pressing Scan.
 *
 * Only a suggestion. It is pre-filled into an editable field, never swept
 * automatically, because a hub with several interfaces may well be offering the
 * wrong one and the operator is the authority on which network their printers
 * are actually on.
 *
 * The selection logic is pure and takes the interface list as an argument, so
 * it can be tested against the shapes real machines produce — several
 * interfaces, VPN tunnels, Docker bridges — without a network.
 */

/** The subset of `os.NetworkInterfaceInfo` this needs. */
export interface InterfaceAddress {
  address: string;
  netmask: string;
  family: string | number;
  internal: boolean;
}

export interface LocalSubnet {
  /** Canonical `network/prefix`, ready to drop into the sweep field. */
  cidr: string;
  /** Which interface it came from, so the UI can say where the guess came from. */
  interfaceName: string;
  /** The hub's own address on that network. */
  address: string;
  /**
   * Where the answer came from.
   *
   * `client` means it was derived from the address the browser reached the hub
   * on, which is the only reliable signal when the server is containerised;
   * `interface` means it came from the host's own adapters.
   */
  source: 'client' | 'interface';
}

/**
 * Docker's default bridge space.
 *
 * A container sees `172.17.0.1` and little else, so an interface scan inside
 * one confidently proposes a network containing nothing but the container's own
 * stack. These are deprioritised rather than excluded, because 172.16/12 is
 * ordinary RFC 1918 space and plenty of real offices are numbered in it —
 * throwing it away outright would break exactly the sites that need discovery
 * most. A better answer wins if one exists; this is still offered if not.
 */
function isDockerDefaultRange(value: number): boolean {
  const first = (value >>> 24) & 0xff;
  const second = (value >>> 16) & 0xff;
  return first === 172 && second >= 17 && second <= 31;
}

/**
 * Ranges a LAN sweep has any business proposing.
 *
 * The same set the CIDR parser accepts, minus loopback: a subnet derived from a
 * client that reached the hub over the loopback interface describes the machine
 * itself, not a network with printers on it.
 */
function isSweepablePrivate(value: number): boolean {
  const first = (value >>> 24) & 0xff;
  const second = (value >>> 16) & 0xff;

  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  return false;
}

/**
 * The subnet implied by the address a client reached the hub on.
 *
 * This is the one signal that survives containerisation. Inside Docker the
 * server's own interfaces describe the bridge network and nothing else, but the
 * browser had to use a real LAN address to get here — so that address names the
 * network the printers are on, and a /24 around it is the range worth sweeping.
 *
 * Assumed /24 because the client tells us an address and not a mask, and a /24
 * is both the overwhelmingly common office layout and small enough to sweep in
 * seconds. It is a pre-filled suggestion in an editable field; someone on a /23
 * corrects it.
 *
 * Anything that is not a sweepable private IPv4 returns null: a hostname, an
 * IPv6 address, a loopback connection from a local browser, or a public address
 * are all reasons to fall back to the interface scan rather than guess.
 */
export function subnetFromClientAddress(address: string | undefined): LocalSubnet | null {
  if (address === undefined) return null;

  // Strips the IPv4-mapped IPv6 form Node hands back on a dual-stack socket,
  // and any zone or port suffix that came with it.
  const cleaned = address.trim().replace(/^::ffff:/i, '').split('%')[0] ?? '';

  const value = toInt(cleaned);
  if (value === null || !isSweepablePrivate(value)) return null;

  const cidr = toCidr(cleaned, 24);
  if (cidr === null) return null;

  return { cidr, interfaceName: 'client', address: cleaned, source: 'client' };
}

/**
 * Interfaces that are technically up and never the answer.
 *
 * Container bridges and VPN tunnels carry real private addresses, so neither
 * "is it private" nor "is it internal" excludes them — but a hub in Docker
 * sweeping `172.17.0.0/16` finds its own network stack and nothing else, which
 * looks broken. Matched on name because that is the only thing that
 * distinguishes them, and conservatively: anything not recognised is allowed
 * through, since a wrong exclusion is worse than a wrong suggestion.
 */
const SKIPPED_INTERFACES =
  /^(docker|br-|veth|virbr|vmnet|utun|tun|tap|wg|zt|tailscale|ppp|awdl|llw)/i;

/** IPv4, whichever way the runtime spells the family. */
function isIpv4(entry: InterfaceAddress): boolean {
  return entry.family === 'IPv4' || entry.family === 4;
}

function toInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  // Unsigned: a 10.x or 192.x address has the top bit set once shifted.
  return value >>> 0;
}

function toDotted(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

/**
 * Contiguous-ones netmask to a prefix length, or null when it is not one.
 *
 * A mask like `255.255.0.255` is not a netmask however plausible it looks, and
 * turning it into a prefix anyway would produce a sweep range that does not
 * correspond to any real network.
 */
export function netmaskToPrefix(netmask: string): number | null {
  const value = toInt(netmask);
  if (value === null) return null;
  if (value === 0) return 0;

  // Every valid mask is a run of ones then a run of zeros; inverting it must
  // therefore give a value one less than a power of two.
  const inverted = (~value) >>> 0;
  if (((inverted + 1) & inverted) !== 0) return null;

  let prefix = 0;
  for (let bit = 31; bit >= 0; bit -= 1) {
    if ((value & (1 << bit)) === 0) break;
    prefix += 1;
  }
  return prefix;
}

/** The network address for an address/prefix pair, in CIDR form. */
export function toCidr(address: string, prefix: number): string | null {
  const value = toInt(address);
  if (value === null) return null;

  // A /0 mask cannot be produced by shifting 32, which is a no-op in JS.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return `${toDotted((value & mask) >>> 0)}/${prefix}`;
}

/**
 * Picks the interface a sweep should default to.
 *
 * Preference order: a real interface with a usable prefix, smallest network
 * first. Smallest because a /24 office LAN is both the likeliest answer and the
 * one that sweeps in seconds — defaulting to a /16 someone happens to have
 * would offer a range the sweep refuses as too large anyway.
 */
export function pickLocalSubnet(
  interfaces: Readonly<Record<string, InterfaceAddress[] | undefined>>,
): LocalSubnet | null {
  const candidates: (LocalSubnet & { prefix: number; isDocker: boolean })[] = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    if (entries === undefined) continue;
    if (SKIPPED_INTERFACES.test(name)) continue;

    for (const entry of entries) {
      // Loopback is internal and would sweep 127.0.0.0/8 — never the answer.
      if (entry.internal || !isIpv4(entry)) continue;

      const prefix = netmaskToPrefix(entry.netmask);
      // A prefix wider than the sweep's own limit is not worth suggesting: the
      // form would reject it the moment Scan was pressed.
      if (prefix === null || prefix < 20 || prefix > 32) continue;

      const cidr = toCidr(entry.address, prefix);
      if (cidr === null) continue;

      const value = toInt(entry.address);

      candidates.push({
        cidr,
        interfaceName: name,
        address: entry.address,
        source: 'interface',
        prefix,
        isDocker: value !== null && isDockerDefaultRange(value),
      });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort(
    (a, b) =>
      // Docker's own bridge space last: inside a container it is the only thing
      // visible and contains nothing but the container, so anything else is a
      // better guess. Still offered when it is all there is.
      Number(a.isDocker) - Number(b.isDocker) ||
      // Largest prefix = smallest network, which is the likeliest office LAN
      // and the fastest to sweep.
      b.prefix - a.prefix ||
      a.interfaceName.localeCompare(b.interfaceName),
  );

  const best = candidates[0] as LocalSubnet & { prefix: number };
  return {
    cidr: best.cidr,
    interfaceName: best.interfaceName,
    address: best.address,
    source: 'interface',
  };
}

/**
 * The subnet to propose, preferring what the client's own address implies.
 *
 * Order matters and is the whole point of the change: the client address is
 * checked first because it is right in the case the interface scan gets wrong —
 * a hub in a container, where the scan sees a bridge network and the browser
 * sees the real LAN. When there is no usable client address (a local browser on
 * loopback, a hostname, IPv6) the scan is still the better answer, so it is not
 * replaced, only outranked.
 */
export function resolveDefaultSubnet(
  clientAddress: string | undefined,
  interfaces: Readonly<Record<string, InterfaceAddress[] | undefined>>,
): LocalSubnet | null {
  return subnetFromClientAddress(clientAddress) ?? pickLocalSubnet(interfaces);
}
