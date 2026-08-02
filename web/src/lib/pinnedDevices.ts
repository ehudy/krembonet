/**
 * Which devices an operator has starred, kept in `localStorage`.
 *
 * Client-side rather than a hub setting on purpose. A pin is one person's view
 * of a shared dashboard — the two printers on *their* floor — and storing it
 * server-side would mean the receptionist's stars rearranging the sidebar for
 * the drawing office. There is no login here to hang a per-user preference off,
 * so the browser is the only honest place for it.
 *
 * Devices are identified by slug. It is the identifier the client already has:
 * `/api/devices` never sends the numeric row id, and the slug is what every
 * route and link is built from. A renamed device keeps its slug, so a pin
 * survives a rename; a device deleted and re-added under the same name resolves
 * to the same slug and inherits the pin, which is the behaviour an operator
 * expects from something that looks like the same printer.
 */
import { createLocalStore } from './localStore.js';

export const PINNED_STORAGE_KEY = 'krembonet_pinned_devices';

/**
 * Coerces whatever is in storage into a slug list.
 *
 * Exported for the tests, which is where the awkward inputs live: a bare
 * string, a nested array, a number that happens to look like an id. This value
 * is user-writable, so a malformed entry has to degrade to "nothing is pinned"
 * rather than throw on every render of the sidebar.
 */
export function parsePinned(raw: string | null): string[] {
  if (raw === null || raw === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const slugs: string[] = [];

  for (const entry of parsed) {
    if (typeof entry !== 'string') continue;
    const slug = entry.trim();
    // Duplicates would render the same device twice in the sidebar, and are
    // trivially produced by hand-editing the key.
    if (slug === '' || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }

  return slugs;
}

export const pinnedStore = createLocalStore<string[]>({
  key: PINNED_STORAGE_KEY,
  parse: parsePinned,
  serialize: (slugs) => JSON.stringify(slugs),
  fallback: [],
});

export function readPinned(): string[] {
  return pinnedStore.read();
}

export function isPinned(slug: string): boolean {
  return readPinned().includes(slug);
}

/**
 * Adds or removes a pin, and returns whether the device is now pinned.
 *
 * Read-modify-write against storage rather than against React state, so two
 * components toggling different devices cannot clobber each other's entry.
 * Appends rather than sorting: the order stars were added in is the operator's
 * own ordering, and re-sorting it alphabetically would throw that away.
 */
export function togglePinned(slug: string): boolean {
  const current = readPinned();
  const next = current.includes(slug)
    ? current.filter((entry) => entry !== slug)
    : [...current, slug];

  pinnedStore.write(next);
  return next.includes(slug);
}
