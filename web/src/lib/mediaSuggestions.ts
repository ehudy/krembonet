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
import { humanizeMediaCode, suggestFromDictionaries } from './mediaDictionaries/index.js';

/**
 * Stock a commercial print shop actually keeps, for the name field's datalist.
 *
 * Ordered roughly by weight and finish rather than alphabetically, because
 * that is how someone standing at a plotter thinks about paper — the list is
 * read, not searched.
 */
export const COMMON_MEDIA_NAMES: readonly string[] = [
  'Plain Paper',
  'Premium Plain Paper 80',
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
 * The name to propose for a raw vendor code, or null when there is nothing
 * worth proposing.
 *
 * The lookups themselves live in ./mediaDictionaries — structured per vendor,
 * with a Canon range fallback and a generic humanizer for codes that spell a
 * name. This function is just the order they run in and the normalisation they
 * share. Null is the common and correct answer: most codes carry no meaning to
 * read, and inventing something for them is the failure this whole design
 * avoids.
 */
export function suggestMediaName(code: string): string | null {
  const trimmed = code.trim();
  // Dictionaries match case-insensitively; the humanizer needs the original
  // case, since a camelCase seam is one of the things it reads a name from.
  return suggestFromDictionaries(trimmed.toLowerCase()) ?? humanizeMediaCode(trimmed);
}
