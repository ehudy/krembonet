/**
 * Turning a vendor's marker name into something an operator reads at a glance.
 *
 * Devices label their supplies for their own parts catalogue, not for a wall
 * display: "Black Cartridge HP W9060MC", "Canon GPR-66 Black Toner", "Black
 * TK-172". The colour is the thing someone glances for; the SKU is the thing
 * they type into a reorder form. This splits the two — a clean colour name for
 * the UI, the part number kept alongside for the tooltip and the reorder list.
 *
 * Matching is deliberately wide across vendors: the full word ("Magenta"), the
 * terse code every vendor spells differently ("M", "MBK", "pK"), and the phrase
 * a receptacle wears ("Toner Collection Unit"). One printer per floor is rarely
 * from the same maker as the next, and a fleet view where Canon says "Black"
 * and Kyocera says "Black TK-172" cannot be scanned down a column.
 *
 * What it does *not* do is guess. A name carrying none of the known keywords is
 * returned exactly as the device gave it, because a greedy cleaner that stripped
 * every string down to fragments would turn a perfectly good "Ink Reservoir"
 * into "Reservoir". A name left too long is recoverable; one mangled into
 * nonsense is not — hence the test that walks a list of names nothing here is
 * allowed to touch.
 */

/**
 * Supply keywords, most specific first.
 *
 * Order carries real meaning and is not alphabetical convenience:
 *
 *  - The receptacle and service phrases lead, because a waste unit routinely
 *    names the colourant it collects ("Waste Toner Black") and testing colours
 *    first would file it under Black.
 *  - "Matte Black" and "Photo Black" precede the bare "Black" they contain.
 *  - The single-letter codes trail their own full words, so "Cyan" is matched
 *    as a word before anything has to reason about a stray "C".
 *
 * Every alternative is anchored on word boundaries, which is what keeps the
 * terse codes safe: `\bk\b` matches the "K" of "Toner K" and not the "K" inside
 * "Kit" or "TK-172".
 */
const SUPPLY_KEYWORDS: readonly { pattern: RegExp; label: string }[] = [
  {
    // Epson's waste-ink pad is a maintenance part, not a toner box, so it is
    // claimed here before the generic waste rule below can take it.
    pattern: /\bmaintenance\b|\bcleaner\b|\bcleaning\s+(?:unit|kit)\b|\bwaste\s+ink\b/i,
    label: 'Maintenance Cartridge',
  },
  {
    pattern: /\bwaste\b|\btoner\s+collection\b|\bcollection\s+unit\b/i,
    label: 'Waste Toner Box',
  },
  { pattern: /\bmatte\s+black\b|\bmbk\b|\bmk\b/i, label: 'Matte Black' },
  { pattern: /\bphoto\s+black\b|\bpbk\b|\bpk\b/i, label: 'Photo Black' },
  { pattern: /\bblack\b|\bnoir\b|\bbk\b|\bk\b/i, label: 'Black' },
  { pattern: /\bcyan\b|\bc\b/i, label: 'Cyan' },
  { pattern: /\bmagenta\b|\bm\b/i, label: 'Magenta' },
  { pattern: /\byellow\b|\by\b/i, label: 'Yellow' },
];

/**
 * A vendor cartridge SKU, if the name carries one.
 *
 * Two shapes cover most of them: a lettered prefix with a dashed number
 * (`GPR-66`, `TK-172`, `TN-336`) and the run-together form HP and Kyocera
 * favour (`W9060MC`, `TK172`). Kept tight on purpose — a loose pattern would
 * pull a plain number out of "Cyan 80" and call it a part number.
 */
const PART_NUMBER = /\b([A-Z]{2,4}-\d{2,4}[A-Z]?|[A-Z]{1,3}\d{3,5}[A-Z]{0,3})\b/;

export interface CleanedSupplyName {
  /** The colour or container name when one was recognised, otherwise the device's own. */
  label: string;
  /** The extracted cartridge SKU, for tooltips and reordering. Null when none. */
  partNumber: string | null;
}

export function cleanSupplyName(rawName: string): CleanedSupplyName {
  const text = rawName.trim();

  // Case preserved: SKUs are upper-case, and the match is returned verbatim.
  const partNumber = PART_NUMBER.exec(text)?.[1] ?? null;

  // Matched against the whole name, SKU included. Stripping the part number
  // first is tempting and wrong: "MBK-100" would then have nothing left to
  // recognise, and a name that is only a SKU is exactly the one that most needs
  // its colour code read.
  const match = SUPPLY_KEYWORDS.find((entry) => entry.pattern.test(text));
  return {
    label: match?.label ?? text,
    partNumber,
  };
}
