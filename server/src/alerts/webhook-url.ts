/**
 * What a webhook is allowed to point at.
 *
 * The hub makes an outbound POST to an address an operator typed, which is the
 * shape of a server-side request forgery whatever the intent behind it. The
 * admin session is not a privilege boundary here — an admin can already point a
 * *device* at any address and read what comes back — so this is not pretending
 * to contain a hostile administrator. It exists for the two cases that are
 * worth containing: a typo, and a stolen session on a hub that happens to be
 * running on a cloud VM.
 *
 * Which is why the list of what it refuses is short and specific rather than
 * "anything private". A self-hosted ntfy, Gotify or Home Assistant on the same
 * LAN is the *normal* destination for this application; blocking loopback and
 * RFC1918 would break the primary use case to defend against an operator
 * attacking their own hub. What is blocked is the link-local range — which no
 * webhook receiver has ever legitimately lived on, and which is where every
 * cloud provider parks its instance metadata service, credentials included.
 *
 * Two limits worth stating plainly rather than implying:
 *
 *  - A *hostname* that resolves to a blocked address is not caught. Closing
 *    that means resolving at request time and pinning the socket to the address
 *    that was checked, which Node's `fetch` does not expose without a custom
 *    undici dispatcher. The named metadata hosts are blocked by name as the
 *    cheap half of it.
 *  - A redirect to a blocked address is not caught either, for the same reason.
 *
 * Numeric obfuscation *is* covered, and for free: the WHATWG URL parser
 * normalises `http://2852039166`, `http://0xA9FEA9FE` and
 * `http://0251.0376.0251.0376` all to `169.254.169.254` before this sees them.
 */

/** Hostnames that are only ever a metadata service. */
const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog']);

/** The v4 addresses that mean "this host" rather than a destination. */
const UNSPECIFIED_V4 = '0.0.0.0';

/** AWS's IPv6 instance metadata endpoint. */
const IPV6_METADATA = [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254];

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

/**
 * An IPv6 address as its eight groups, with `::` expanded.
 *
 * Written out rather than pattern-matched on the text: `fd00:ec2::254` and
 * `fd00:0ec2:0000:0000:0000:0000:0000:0254` are the same address, and a check
 * that only recognised one of them would be a check somebody could walk past.
 */
export function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase();

  // An IPv4 tail — `::ffff:169.254.169.254` — is the same address as
  // `::ffff:a9fe:a9fe`, and is how a v4 target hides inside a v6 literal.
  const tail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail !== null) {
    const octets = parseIpv4(tail[1] as string);
    if (octets === null) return null;
    const [a, b, c, d] = octets as [number, number, number, number];
    text = `${text.slice(0, tail.index)}:${((a << 8) | b).toString(16)}:${(
      (c << 8) |
      d
    ).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part
      .split(':')
      .map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : -1));
    return groups.every((group) => group >= 0) ? groups : null;
  };

  const head = toGroups(halves[0] as string);
  const rest = toGroups(halves[1] ?? '');
  if (head === null || rest === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;

  const gap = 8 - head.length - rest.length;
  if (gap < 1) return null;

  return [...head, ...Array<number>(gap).fill(0), ...rest];
}

/** True for an address no outbound webhook should ever be aimed at. */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) return true;

  const octets = parseIpv4(host);
  if (octets !== null) {
    // 169.254.0.0/16. Every major provider's metadata service is at
    // 169.254.169.254, and nothing else on that range is a webhook receiver.
    if (octets[0] === 169 && octets[1] === 254) return true;
    // Not a destination: on Linux it routes to the local host.
    return host === UNSPECIFIED_V4;
  }

  if (!host.startsWith('[') || !host.endsWith(']')) return false;

  const groups = expandIpv6(host.slice(1, -1));
  if (groups === null) return false;

  // fe80::/10 — the v6 link-local range, and the same reasoning as above.
  if (((groups[0] as number) & 0xffc0) === 0xfe80) return true;
  // The unspecified address, which is the v6 spelling of 0.0.0.0.
  if (groups.every((group) => group === 0)) return true;
  if (groups.every((group, index) => group === IPV6_METADATA[index])) return true;

  // An IPv4 address wearing a v6 literal: ::ffff:169.254.169.254.
  const isV4Mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isV4Mapped) {
    const a = (groups[6] as number) >> 8;
    const b = (groups[6] as number) & 0xff;
    return a === 169 && b === 254;
  }

  return false;
}

export type WebhookUrlCheck = { url: string } | { error: string };

/**
 * Validates a webhook URL for storage and for sending.
 *
 * http is allowed alongside https because a self-hosted ntfy or Mattermost on
 * the same LAN commonly has no certificate, and refusing it would push
 * operators toward disabling verification somewhere worse. Everything else —
 * `file:`, `ftp:`, a bare hostname — is refused, since the only thing this URL
 * is ever used for is an outbound POST.
 */
export function parseWebhookUrl(raw: unknown): WebhookUrlCheck {
  const value = String(raw ?? '').trim();
  if (value === '') return { error: 'A webhook URL is required.' };
  if (value.length > 2000) return { error: 'Webhook URL is too long.' };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { error: 'Webhook URL is not a valid URL.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'Webhook URL must start with http:// or https://.' };
  }

  if (isBlockedHost(parsed.hostname)) {
    return {
      error:
        'That address is a link-local or cloud metadata endpoint, which cannot be a webhook destination. A receiver on your own network — including localhost — is fine.',
    };
  }

  return { url: parsed.toString() };
}
