/**
 * Custom CSS sanitising — pure, no database.
 *
 * The custom stylesheet is admin-authored, so this is not a defence against a
 * hostile author: someone who can write here can already change every setting
 * on the hub. It exists for two narrower reasons.
 *
 * First, the string is injected into a `<style>` element. A literal `</style>`
 * anywhere in it — including inside a comment or a quoted string, which is
 * where a copy-paste from a web page will put one — ends the element early and
 * turns everything after it into markup. That is a self-inflicted XSS on a hub
 * whose dashboard may be gated to viewers who are *not* trusted.
 *
 * Second, `@import` and `url(https://…)` reach off the LAN. This is a
 * self-hosted tool for a local network, and a stylesheet that phones out to a
 * font CDN on every dashboard load is both a privacy surprise and a hang on an
 * air-gapped install. Remote references are stripped; `data:` URIs are kept,
 * since an inlined logo is the usual reason to want one.
 */

/**
 * Roughly 200 lines of CSS. Generous for branding tweaks, and small enough that
 * the whole stylesheet still rides along in the unauthenticated `/api/hub`
 * response without making it worth thinking about.
 */
export const MAX_CUSTOM_CSS_LENGTH = 20_000;

export interface CssSanitizeResult {
  css: string;
  /** What was removed, in operator-readable terms. Empty when nothing was. */
  warnings: string[];
}

/** Matches `</style`, however the browser's tokenizer would spell it. */
const CLOSING_STYLE = /<\/\s*style/gi;

/** `@import` in any of its forms, up to the terminating `;` or block. */
const AT_IMPORT = /@import\b[^;{}]*(;|(?=\{)|$)/gi;

/**
 * A `url(...)` pointing somewhere other than this origin or a data URI.
 * Deliberately covers protocol-relative `//host/…` too, which is easy to miss.
 */
const REMOTE_URL = /url\(\s*(['"]?)\s*(https?:|\/\/)[^)]*\1\s*\)/gi;

/**
 * `javascript:` and `expression(` are legacy script vectors in CSS. No engine
 * this app supports still runs either, so stripping them costs nothing and
 * means a stylesheet pasted from an old tutorial cannot smuggle one in.
 */
const LEGACY_SCRIPT = /(javascript\s*:|expression\s*\()/gi;

export function sanitizeCustomCss(raw: string): CssSanitizeResult {
  const warnings: string[] = [];
  let css = String(raw ?? '');

  /**
   * Strips a pattern and records a warning only if it actually matched.
   *
   * Comparing before and after, rather than calling `test` and then `replace`,
   * keeps the two from disagreeing: `test` on a /g regex advances `lastIndex`,
   * and reasoning about whose turn it is to reset it is exactly the kind of
   * thing that works until someone reorders these calls.
   */
  const strip = (pattern: RegExp, replacement: string, warning: string): void => {
    const next = css.replace(pattern, replacement);
    if (next === css) return;
    css = next;
    warnings.push(warning);
  };

  if (css.length > MAX_CUSTOM_CSS_LENGTH) {
    css = css.slice(0, MAX_CUSTOM_CSS_LENGTH);
    warnings.push(`Custom CSS was truncated to ${MAX_CUSTOM_CSS_LENGTH} characters.`);
  }

  // Escaped rather than rejected: the source is almost always a stray tag in a
  // pasted snippet, and failing the whole save over it helps nobody.
  strip(
    CLOSING_STYLE,
    '<\\/style',
    'A literal </style> tag was escaped — it would have broken the page.',
  );
  strip(
    AT_IMPORT,
    '',
    '@import rules were removed — this hub does not load remote stylesheets.',
  );
  strip(
    REMOTE_URL,
    'url()',
    'Remote url() references were removed. Inline images as data: URIs instead.',
  );
  strip(LEGACY_SCRIPT, '', 'javascript: and expression() were removed.');

  return { css: css.trim(), warnings };
}

// --- image asset URLs (logo, favicon) ------------------------------------

/** Roughly 512KB of base64, which is a generous inline image. */
export const MAX_IMAGE_URL_LENGTH = 700_000;

/**
 * Validates a branding image URL — a logo or a favicon.
 *
 * The browser loads this, not the server, so there is no SSRF surface: the risk
 * is markup. `javascript:` in an `<img src>` or a `<link href>` is inert in
 * every current engine, but it is refused anyway rather than relying on that,
 * and so is anything outside the three shapes an image can legitimately take —
 * a `data:` URI of an allowed type, an `http(s):` URL, or a site-relative path
 * served from this hub.
 *
 * `dataTypes` is the set of `image/<subtype>` values accepted inline, which is
 * the one thing that differs between a logo (photographic formats included) and
 * a favicon (which also allows `.ico`).
 */
function parseImageUrl(
  raw: unknown,
  options: { kind: 'Logo' | 'Favicon'; dataTypes: RegExp },
): { url: string } | { error: string } {
  const { kind, dataTypes } = options;
  const value = String(raw ?? '').trim();
  if (value === '') return { url: '' };

  if (value.length > MAX_IMAGE_URL_LENGTH) {
    return { error: `${kind} URL is too long. Inline images must be under ~512KB.` };
  }

  // Site-relative, e.g. /assets/logo.svg. Rejects `//host/x`, which is
  // protocol-relative and therefore remote.
  if (value.startsWith('/') && !value.startsWith('//')) return { url: value };

  if (dataTypes.test(value)) return { url: value };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      error: `${kind} must be a full URL, a /relative path, or a data:image URI.`,
    };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: `${kind} URL cannot use the "${parsed.protocol}" scheme.` };
  }
  return { url: parsed.toString() };
}

/** Inline logo types: the raster and vector formats a browser renders as `<img>`. */
const LOGO_DATA_TYPES = /^data:image\/(png|jpeg|gif|webp|svg\+xml);/i;

/**
 * Inline favicon types. Adds `.ico` in both MIME spellings a browser may
 * produce (`x-icon`, `vnd.microsoft.icon`), and drops the photographic formats
 * that make no sense at tab size.
 */
const FAVICON_DATA_TYPES = /^data:image\/(x-icon|vnd\.microsoft\.icon|png|svg\+xml|webp);/i;

export function parseLogoUrl(raw: unknown): { url: string } | { error: string } {
  return parseImageUrl(raw, { kind: 'Logo', dataTypes: LOGO_DATA_TYPES });
}

export function parseFaviconUrl(raw: unknown): { url: string } | { error: string } {
  return parseImageUrl(raw, { kind: 'Favicon', dataTypes: FAVICON_DATA_TYPES });
}
