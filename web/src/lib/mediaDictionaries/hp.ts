/**
 * HP media codes. Suggestions only — see ./canon.ts for the reasoning.
 *
 * No range convention is claimed here: HP's driver codes do not follow the
 * tidy high-byte families Canon's do, so an unrecognised HP code falls through
 * to the generic humanizer or stays unmapped rather than being classified by a
 * pattern that is not really there.
 */

/** Codes (prefix stripped, lower-cased) confirmed to a specific stock. */
export const HP_EXACT: Readonly<Record<string, string>> = {
  '0041': 'Heavyweight Coated (130g)',
};

export function suggestHp(local: string): string | null {
  return HP_EXACT[local] ?? null;
}
