/**
 * Canon media codes, as conventions rather than facts.
 *
 * Everything here is a *suggestion* — a name proposed to an admin who confirms
 * it — never something the dashboard resolves on its own. The reasoning is the
 * one stated in ../mediaSuggestions.ts: a code table lifted from one office's
 * driver is wrong for the next, so a person always signs off before a guess
 * becomes a stored name.
 *
 * Two layers, exact first. `CANON_EXACT` is the handful of codes confirmed
 * against real hardware. `CANON_RANGES` captures the imagePROGRAF / TZ-series
 * convention that the high byte names the *family* — 01xx plain, 02xx
 * coated/matte, 03xx photo/glossy — which lets an unrecognised `02a7` still
 * suggest the right shelf to pull from, without pretending to know the exact
 * product.
 */

/** Codes (prefix stripped, lower-cased) confirmed to a specific stock. */
export const CANON_EXACT: Readonly<Record<string, string>> = {
  '012f': 'Premium Plain Paper 80',
  '0201': 'Heavyweight Coated (130g)',
};

/** The imagePROGRAF / TZ family each high-byte prefix belongs to. */
export const CANON_RANGES: readonly { prefix: string; name: string }[] = [
  { prefix: '01', name: 'Plain Paper' },
  { prefix: '02', name: 'Premium Matte Paper' },
  { prefix: '03', name: 'Glossy Photo Paper' },
];

/**
 * A suggested name for a Canon code, prefix already stripped.
 *
 * Exact match wins; otherwise the family for a four-hex-digit `NNxx` code;
 * otherwise null, which leaves the code genuinely unmapped rather than guessed.
 */
export function suggestCanon(local: string): string | null {
  const exact = CANON_EXACT[local];
  if (exact !== undefined) return exact;

  // Only classify things that actually look like a Canon hex code, so a
  // human-readable slug does not get miscategorised by its first two letters.
  if (!/^[0-9a-f]{4}$/.test(local)) return null;

  const prefix = local.slice(0, 2);
  return CANON_RANGES.find((range) => range.prefix === prefix)?.name ?? null;
}
