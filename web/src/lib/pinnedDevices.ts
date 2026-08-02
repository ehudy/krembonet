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
 *
 * The parsing here is deliberately forgiving. This value is user-writable — it
 * is one devtools command away — and a malformed entry must degrade to "nothing
 * is pinned" rather than take the sidebar down on every render.
 */

export const PINNED_STORAGE_KEY = 'krembonet_pinned_devices';

/**
 * Fired after this tab writes.
 *
 * The native `storage` event only reaches *other* tabs, so without this the
 * sidebar would not notice a star clicked on the page beside it until a
 * navigation happened to re-render it.
 */
export const PINNED_CHANGE_EVENT = 'krembonet:pinned-devices';

/**
 * Coerces whatever is in storage into a slug list.
 *
 * Exported for the tests, which is where the awkward inputs live: a bare
 * string, a nested array, a number that happens to look like an id.
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

export function readPinned(): string[] {
  try {
    return parsePinned(window.localStorage.getItem(PINNED_STORAGE_KEY));
  } catch {
    // Private browsing, or storage disabled entirely. Pins are a convenience;
    // losing them is not worth breaking the page over.
    return [];
  }
}

function writePinned(slugs: readonly string[]): void {
  try {
    window.localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(slugs));
  } catch {
    // As above — a full or unavailable store means the star does not stick,
    // which is visible to the operator without an error dialog explaining it.
  }
  window.dispatchEvent(new Event(PINNED_CHANGE_EVENT));
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

  writePinned(next);
  return next.includes(slug);
}

/** Subscribes to changes from this tab and from any other. */
export function subscribePinned(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    // `key` is null when the whole store is cleared, which is also a change.
    if (event.key === null || event.key === PINNED_STORAGE_KEY) onChange();
  };

  window.addEventListener(PINNED_CHANGE_EVENT, onChange);
  window.addEventListener('storage', onStorage);

  return () => {
    window.removeEventListener(PINNED_CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}
