/**
 * Suggestions for naming a paper code — proposals, never resolutions.
 *
 * Deliberately a separate file from standardMedia.ts, and the distinction is
 * the whole point of it. That one holds the PWG/IPP keywords, which are
 * standardised: `transparency` means transparency on every printer ever built,
 * so the dashboard resolves it automatically. What is here is the opposite —
 * commercial paper names an operator might want, and vendor codes that
 * *usually* mean a particular stock in a particular manufacturer's drivers.
 *
 * The project's position on that second kind is stated in server/src/db/
 * media-pack.ts and is not being reversed here: no vendor code is ever resolved
 * to a name automatically, because a table lifted from one office's driver is
 * wrong for the next one, and a wrong paper name is worse than an unfamiliar
 * one — someone will plot a job on it.
 *
 * So nothing in this file feeds the resolver. It feeds a datalist and a
 * "Suggest" button: an admin sees the proposal, agrees or types something else,
 * and the name is only stored because a person chose it. That keeps the
 * convenience without letting a guess become a fact.
 *
 * The strings are fixed rather than translated, for the same reason the CSV
 * export's column names are: they end up as one stored value shown to every
 * viewer whatever their language, and they are trade terms — a print shop
 * saying "Bond / CAD (80g)" says it in those words. The UI wrapped around them
 * is localised; the proposed value is not.
 */

/**
 * Stock a commercial print shop actually keeps, for the name field's datalist.
 *
 * Ordered roughly by weight and finish rather than alphabetically, because
 * that is how someone standing at a plotter thinks about paper — the list is
 * read, not searched.
 */
export const COMMON_MEDIA_NAMES: readonly string[] = [
  'Plain Paper',
  'Bond / CAD (80g)',
  'Heavyweight Coated (130g)',
  'Heavyweight Coated (180g)',
  'Premium Matte Paper',
  'Satin Photo Paper',
  'Glossy Photo Paper',
  'Proofing Paper',
  'Fine Art / Smooth Canvas',
  'Backlit Film',
  'Vinyl / Banner',
];

/** The datalist element id, shared by every field that offers these names. */
export const COMMON_MEDIA_LIST_ID = 'common-paper-names';

/**
 * Vendor codes that commonly mean a particular stock.
 *
 * "Commonly" is doing real work in that sentence. These come from the
 * conventions manufacturers use across their driver families, not from a
 * standard, and a given firmware may well use the code for something else.
 * That is exactly why they surface as a button an admin presses rather than as
 * a name the dashboard displays on its own.
 *
 * Keys are matched case-insensitively and with surrounding whitespace trimmed;
 * beyond that a code is compared literally, since a vendor code carries no
 * structure worth parsing.
 */
const VENDOR_CODE_SUGGESTIONS: Record<string, string> = {
  'com.canon-012f': 'Premium Matte Paper',
  'com.canon-0201': 'Heavyweight Coated (130g)',
  'com.epson-9f2a': 'Satin Photo Paper',
  'com.hp-0041': 'Heavyweight Coated (130g)',
};

/**
 * The name to propose for a raw vendor code, or null when there is nothing
 * worth proposing.
 *
 * Null is the common and correct answer: most codes are not in the table, and
 * inventing something for them is the failure this whole design avoids.
 */
export function suggestMediaName(code: string): string | null {
  return VENDOR_CODE_SUGGESTIONS[code.trim().toLowerCase()] ?? null;
}
