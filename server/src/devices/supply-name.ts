/**
 * Turning a vendor's marker name into something an operator reads at a glance.
 *
 * Devices label their supplies for their own parts catalogue, not for a wall
 * display: "Black Cartridge HP W9060MC", "Canon GPR-66 Black Toner". The colour
 * is the thing someone glances for; the SKU is the thing they type into a
 * reorder form. This splits the two — a clean colour name for the UI, the part
 * number kept alongside for the tooltip and the reorder list.
 *
 * Deliberately conservative. It only rewrites the label when it is *confident*
 * of the colour — one of the known keywords is present — and otherwise leaves
 * the device's own words alone. A greedy cleaner that stripped every string
 * down to guessed fragments would turn a perfectly good "Ink Reservoir" into
 * "Reservoir"; the failure mode here is a name left too long, which is
 * recoverable, not one mangled into nonsense, which is not.
 */

/**
 * Primary colour keywords, most specific first.
 *
 * "Matte Black" and "Photo Black" must be tested before the bare "Black" they
 * contain, and the receptacle phrases before anything else, since a waste unit
 * often names the colourant it collects.
 */
const COLOR_KEYWORDS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\bmatte\s+black\b|\bmbk\b/i, label: 'Matte Black' },
  { pattern: /\bphoto\s+black\b|\bpbk\b/i, label: 'Photo Black' },
  {
    pattern: /\bmaintenance\s+(?:cartridge|kit|box)\b|\bwaste\s+ink\b/i,
    label: 'Maintenance Cartridge',
  },
  {
    pattern: /\bwaste\s+toner\b|\btoner\s+collection\b|\bwaste\s+box\b/i,
    label: 'Waste Toner',
  },
  { pattern: /\bblack\b/i, label: 'Black' },
  { pattern: /\bcyan\b/i, label: 'Cyan' },
  { pattern: /\bmagenta\b/i, label: 'Magenta' },
  { pattern: /\byellow\b/i, label: 'Yellow' },
];

/**
 * A vendor cartridge SKU, if the name carries one.
 *
 * Two shapes cover most of them: a lettered prefix with a dashed number
 * (`GPR-66`, `TK-172`, `TN-336`) and the run-together form HP favours
 * (`W9060MC`). Kept tight on purpose — a loose pattern would pull a plain
 * number out of "80g" and call it a part number.
 */
const PART_NUMBER = /\b([A-Z]{2,4}-\d{2,4}[A-Z]?|[A-Z]{1,3}\d{3,5}[A-Z]{0,3})\b/;

export interface CleanedSupplyName {
  /** The colour name when one was recognised, otherwise the device's own. */
  label: string;
  /** The extracted cartridge SKU, for tooltips and reordering. Null when none. */
  partNumber: string | null;
}

export function cleanSupplyName(rawName: string): CleanedSupplyName {
  const text = rawName.trim();

  // Case preserved: SKUs are upper-case, and the match is returned verbatim.
  const partNumber = PART_NUMBER.exec(text)?.[1] ?? null;

  const color = COLOR_KEYWORDS.find((entry) => entry.pattern.test(text));
  return {
    label: color?.label ?? text,
    partNumber,
  };
}
