/**
 * The built-in dictionary of standard PWG/IPP media keywords.
 *
 * These are the self-describing media names defined by the standards (PWG
 * 5101.1 media-type, and the legacy IPP `media` keywords) — `stationery`,
 * `photographic-glossy`, `transparency`, and the rest. Unlike a vendor code
 * such as `com.canon-012f`, they mean the same thing on every printer, so
 * naming them needs no database row and no operator effort: a device reporting
 * `transparency` resolves to "Transparency" out of the box and never shows the
 * amber "unmapped" badge.
 *
 * This is tier 3 of the four the dashboard resolves through, and it lives on
 * the client rather than the server for one reason: the labels are localised,
 * and the server polls in the background with no locale to localise them in.
 * The server resolves the two database tiers (device override, then global) and
 * leaves everything else null; the client fills standard names from here and
 * falls back to the raw code only when even this does not know it.
 *
 * The map is code → translation key. Synonyms collapse onto one key — `plain`
 * and `stationery` are both "Plain Paper" — so the translator names each
 * concept once. Keys live under `standardMedia.*` in the locale files.
 */

/**
 * Normalises a reported code for lookup.
 *
 * Standard keywords are lowercase and hyphenated; some drivers emit underscores
 * or stray case. Vendor codes (`com.canon-012f`) survive normalisation
 * unchanged and simply miss every key, which is the correct outcome — they are
 * not standard.
 */
function normalize(code: string): string {
  return code.trim().toLowerCase().replace(/_/g, '-');
}

/** code → i18n key suffix under `standardMedia.*`. */
const CODE_TO_KEY: Record<string, string> = {
  // Plain.
  plain: 'plain',
  stationery: 'plain',
  'stationery-letter': 'plain',
  'stationery-a4': 'plain',
  // Letterhead / preprinted / prepunched.
  letterhead: 'letterhead',
  'stationery-letterhead': 'letterhead',
  'stationery-preprinted': 'preprinted',
  'stationery-prepunched': 'prepunched',
  // Bond / fine.
  bond: 'bond',
  'stationery-fine': 'bond',
  'stationery-inkjet': 'inkjet',
  // Photographic family.
  photographic: 'photo',
  glossy: 'glossy',
  'photographic-glossy': 'glossy',
  'high-gloss': 'highGloss',
  'photographic-high-gloss': 'highGloss',
  matte: 'matte',
  'photographic-matte': 'matte',
  satin: 'satin',
  'photographic-satin': 'satin',
  'semi-gloss': 'semiGloss',
  'photographic-semi-gloss': 'semiGloss',
  'photographic-film': 'film',
  'back-print-film': 'film',
  // Weights.
  heavyweight: 'heavyweight',
  'stationery-heavyweight': 'heavyweight',
  lightweight: 'lightweight',
  'stationery-lightweight': 'lightweight',
  cardstock: 'cardstock',
  // Envelopes.
  envelope: 'envelope',
  'envelope-plain': 'envelope',
  'envelope-window': 'windowEnvelope',
  // Other standards.
  transparency: 'transparency',
  labels: 'labels',
  'tab-stock': 'tabStock',
  continuous: 'continuous',
  'continuous-long': 'continuous',
  'continuous-short': 'continuous',
  disc: 'disc',
};

/**
 * The i18n key for a standard code, or null when it is not a standard keyword.
 *
 * Callers resolve the label with `t(\`standardMedia.${key}\`)`. Returning the
 * key rather than the label keeps this pure and locale-free, so it can be
 * tested and reused without a translator in hand.
 */
export function standardMediaKey(code: string): string | null {
  return CODE_TO_KEY[normalize(code)] ?? null;
}

/** Whether a code is a standard keyword this dictionary names. */
export function isStandardMediaCode(code: string): boolean {
  return standardMediaKey(code) !== null;
}
