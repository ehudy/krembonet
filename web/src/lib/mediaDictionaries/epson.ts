/**
 * Epson media codes. Suggestions only — see ./canon.ts for the reasoning.
 */

/** Codes (prefix stripped, lower-cased) confirmed to a specific stock. */
export const EPSON_EXACT: Readonly<Record<string, string>> = {
  '9f2a': 'Satin Photo Paper',
};

export function suggestEpson(local: string): string | null {
  return EPSON_EXACT[local] ?? null;
}
