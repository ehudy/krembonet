/**
 * Builds a media pack — a JSON map of vendor media codes to human names — from
 * a CUPS PPD.
 *
 * The PPD is the only artifact carrying both the codes and their names; the
 * printer itself reports codes only, and neither IPP nor SNMP exposes a label
 * (docs/canon-tz32000-field-notes.md §7). Packs are deliberately *not* checked
 * into this repository: the names are vendor product names, and a table built
 * from one office's driver is wrong for the next one. Generate your own and
 * point MEDIA_PACK_PATH at it.
 *
 *   npm run seed:media --workspace=@krembonet/server -- <path-to.ppd> [out.json]
 *
 * Currently understands Canon's `*CNIJMediaType` / `*CNIJMediaTypeIVEC` pairs,
 * which is what the plotter this project started on uses. Other vendors encode
 * media differently; adding a parser here is a good first contribution.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * IVEC 200 ("Auto") and IVEC 0 ("Plain Paper") carry UUIDs whose tails look
 * like vendor codes but correspond to the standard IPP keywords below. The
 * printer reports `auto` / `stationery` for them, never a vendor code.
 */
const KEYWORD_ALIASES: Record<string, string> = {
  '200': 'auto',
  '0': 'stationery',
};

const ppdPath = process.argv[2];
const outputPath = process.argv[3] ?? 'media-pack.json';

if (ppdPath === undefined) {
  console.error('Usage: generate-media-seed.ts <path-to.ppd> [out.json]');
  process.exit(1);
}

// PPDs are latin-1, not UTF-8; reading them as UTF-8 mangles names with
// accented characters.
const ppd = readFileSync(ppdPath, 'latin1');

const names = new Map<string, string>();
for (const match of ppd.matchAll(/^\*CNIJMediaType (\d+)\/(.+?):/gm)) {
  const [, num, name] = match;
  if (num !== undefined && name !== undefined) names.set(num, name);
}

const entries: { code: string; friendlyName: string; vendor?: string }[] = [];
const seen = new Set<string>();

for (const match of ppd.matchAll(
  /^\*CNIJMediaTypeIVEC (\d+): "custom-media-type-canon-[0-9A-Fa-f-]*?([0-9A-Fa-f]{4})"/gm,
)) {
  const [, num, tail] = match;
  if (num === undefined || tail === undefined) continue;

  const friendlyName = names.get(num);
  if (friendlyName === undefined) continue;

  const alias = KEYWORD_ALIASES[num];
  const code = alias ?? `com.canon-${tail.toLowerCase()}`;
  if (seen.has(code)) continue;
  seen.add(code);

  entries.push(
    alias === undefined ? { code, friendlyName, vendor: 'canon' } : { code, friendlyName },
  );
}

if (entries.length === 0) {
  console.error(
    `No media types found in ${ppdPath}. This parser understands Canon PPDs; ` +
      'other vendors encode media differently.',
  );
  process.exit(1);
}

// Standard keywords first, then vendor codes in a stable order, so regenerating
// against an updated driver produces a reviewable diff.
entries.sort((a, b) => {
  const aVendor = a.vendor !== undefined;
  const bVendor = b.vendor !== undefined;
  if (aVendor !== bVendor) return aVendor ? 1 : -1;
  return a.code.localeCompare(b.code);
});

writeFileSync(outputPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');

console.log(`Wrote ${entries.length} media types to ${outputPath}`);
console.log(`Use it with:  MEDIA_PACK_PATH=${outputPath}`);
