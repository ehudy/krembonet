/**
 * Resolving the branding logo into an inline email attachment.
 *
 * Why not just `<img src="{logoUrl}">`: email clients, and Gmail's image proxy
 * in particular, cannot fetch a site-relative path, a `data:` URI, or a URL on a
 * private VLAN — which are exactly the three shapes a self-hosted hub's logo
 * takes. All three arrived as a broken-image placeholder. Attaching the bytes to
 * the message and referencing them by Content-ID (`cid:krembonet-logo`)
 * sidesteps the fetch entirely.
 *
 * This is the only part of the email path that touches the disk, so it is kept
 * out of the pure template. When it cannot produce bytes — no logo, a remote URL
 * we will not fetch, an unreadable or non-image file — it returns null, and the
 * caller renders a text header rather than an image that would break.
 */
import { readFileSync } from 'node:fs';
import { dirname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Content-ID the template references as `cid:krembonet-logo`. */
export const LOGO_CID = 'krembonet-logo';

/**
 * The mark used when no logo is configured — the same KremboNet wordmark the
 * SPA falls back to in its sidebar, so an alert email and the dashboard it
 * links to are wearing the same identity.
 *
 * A site-relative path rather than embedded bytes, so it goes down the existing
 * `fromDiskPath` route and inherits its behaviour: a build where the SPA is not
 * staged next to the server has no such file, `readFileSync` throws, and the
 * caller renders the text header it already renders today. The fallback can
 * only add an image, never break one.
 */
export const DEFAULT_LOGO_PATH = '/logo.svg';

/** A nodemailer-shaped inline attachment. */
export interface InlineImage {
  filename: string;
  cid: string;
  content: Buffer;
  contentType: string;
  contentDisposition: 'inline';
}

const here = dirname(fileURLToPath(import.meta.url));
/** Where @fastify/static serves the SPA from; a site-relative logo lives here. */
const STATIC_ROOT = resolve(here, '..', '..', 'public');

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function inline(content: Buffer, contentType: string): InlineImage {
  // filename 'logo' by design: for an inline image the Content-Type header is
  // what the client reads, and a fixed name keeps the part stable.
  return {
    filename: 'logo',
    cid: LOGO_CID,
    content,
    contentType,
    contentDisposition: 'inline',
  };
}

/** `data:[<mime>][;base64],<payload>` — the embedded-logo case. */
function fromDataUri(value: string): InlineImage | null {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(value);
  if (match === null) return null;

  const contentType = (match[1] ?? '').toLowerCase();
  // Only images become an image attachment; anything else is not a logo.
  if (!contentType.startsWith('image/')) return null;

  const isBase64 = match[2] !== undefined;
  const payload = match[3] ?? '';

  try {
    const content = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    return content.length > 0 ? inline(content, contentType) : null;
  } catch {
    return null;
  }
}

/** A site-relative path like `/assets/logo.svg`, served from the static root. */
function fromDiskPath(sitePath: string): InlineImage | null {
  // Drop any query or hash a browser-style path might carry.
  const clean = (sitePath.split(/[?#]/)[0] ?? '').trim();

  const ext = (/\.[a-z0-9]+$/i.exec(clean)?.[0] ?? '').toLowerCase();
  const contentType = MIME_BY_EXT[ext];
  if (contentType === undefined) return null;

  // Resolve inside the static root and refuse anything that climbs out of it.
  const resolved = normalize(resolve(STATIC_ROOT, `.${clean}`));
  if (resolved !== STATIC_ROOT && !resolved.startsWith(STATIC_ROOT + sep)) return null;

  try {
    const content = readFileSync(resolved);
    return content.length > 0 ? inline(content, contentType) : null;
  } catch {
    return null;
  }
}

/**
 * Turns a branding `logoUrl` into an inline attachment, or null when it cannot.
 *
 * Handled: an embedded `data:` URI (base64 or percent-encoded), and a
 * site-relative path served from the static root. A remote `http(s)` URL is
 * deliberately not fetched — that is network I/O with an SSRF surface at send
 * time — so it falls through to null and the caller's text header.
 *
 * An unset logo resolves to the shipped KremboNet mark rather than to null, to
 * match what the dashboard now shows for the same setting. Null is still the
 * answer for everything that cannot produce bytes, so the callers' text-header
 * path is unchanged and still reachable.
 */
export function resolveLogoAttachment(logoUrl: string): InlineImage | null {
  const value = logoUrl.trim();
  if (value === '') return fromDiskPath(DEFAULT_LOGO_PATH);
  if (value.startsWith('data:')) return fromDataUri(value);
  if (value.startsWith('/') && !value.startsWith('//')) return fromDiskPath(value);
  return null;
}
