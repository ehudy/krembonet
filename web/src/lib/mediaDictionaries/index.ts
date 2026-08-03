/**
 * Vendor media dictionaries, and the generic humanizer behind them.
 *
 * The whole set produces *suggestions* — proposals a person accepts in the
 * admin form — never resolutions the dashboard shows on its own. That boundary
 * is the point of the design and is enforced by a test in
 * ../../test/mediaSuggestions.test.ts.
 *
 * Resolution order, most confident first:
 *   1. a vendor dictionary keyed on the code after its `com.<vendor>-` prefix;
 *   2. for Canon, the family a hex range implies (see ./canon.ts);
 *   3. the humanizer, but only for a code that literally spells a name —
 *      `heavyweight_coated`, `satinPhoto` — never a bare hex blob.
 * Anything that survives all three is left unmapped, which is the correct
 * outcome for a code that carries no meaning we can read.
 */
import { suggestCanon } from './canon.js';
import { suggestEpson } from './epson.js';
import { suggestHp } from './hp.js';

/** Per-vendor resolvers, keyed by the prefix that selects them. */
const VENDOR_RESOLVERS: { prefix: string; resolve: (local: string) => string | null }[] = [
  { prefix: 'com.canon-', resolve: suggestCanon },
  { prefix: 'com.hp-', resolve: suggestHp },
  { prefix: 'com.epson-', resolve: suggestEpson },
];

/**
 * Splits a code into its `com.<vendor>-` prefix and the rest.
 *
 * Case-insensitive on the prefix so a hand-typed `COM.Epson-` still splits,
 * while the remainder keeps its original case — the humanizer reads a camelCase
 * seam out of it, so lower-casing here would erase a boundary it needs.
 */
function splitVendorCode(code: string): { prefix: string; local: string } | null {
  const match = /^(com\.[a-z0-9]+-)(.+)$/i.exec(code);
  if (match === null) return null;
  return { prefix: (match[1] as string).toLowerCase(), local: match[2] as string };
}

/**
 * A dictionary suggestion for a normalized (trimmed, lower-cased) code.
 *
 * Returns null when no vendor module claims it — the humanizer is a separate,
 * later step so the two concerns stay testable apart.
 */
export function suggestFromDictionaries(code: string): string | null {
  const split = splitVendorCode(code);
  if (split === null) return null;

  const resolver = VENDOR_RESOLVERS.find((entry) => entry.prefix === split.prefix);
  return resolver?.resolve(split.local) ?? null;
}

/**
 * A readable name for a code that spells one, or null when it does not.
 *
 * The rule that keeps this honest: only humanize a remainder that carries word
 * structure — an underscore, a hyphen, or a camelCase seam. A bare token with
 * none of those is either an opaque hex id (`012f`) or a meaningless fragment
 * (`vendor`), and inventing "Vendor" from it is exactly the false suggestion
 * this design refuses. Such a code is left for the unmapped list.
 */
export function humanizeMediaCode(code: string): string | null {
  // Strip a vendor prefix if there is one; otherwise humanize the code whole,
  // which lets a prefix-less `heavyweight-coated` still read as a name.
  const split = splitVendorCode(code);
  const local = split === null ? code : split.local;

  const hasStructure = /[_-]/.test(local) || /[a-z][A-Z]/.test(local);
  if (!hasStructure) return null;

  const words = local
    // camelCase seam → space, before lower-casing loses the boundary.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-\s]+/)
    .filter((word) => word !== '');

  if (words.length === 0) return null;

  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
