/**
 * A small typed wrapper around one `localStorage` key.
 *
 * This exists because there are now two per-browser preferences — pinned
 * devices and the Overview view mode — and the interesting part of each is
 * identical: parse defensively, notify this tab as well as the others, and
 * hand React a snapshot it can compare by identity. Copying that twice is how
 * the second one ends up subtly wrong, and the snapshot caching in particular
 * is the kind of thing that is only obviously necessary once you have watched
 * a component re-render forever.
 *
 * Everything here is deliberately forgiving. These values are user-writable —
 * one devtools command away from anything at all — so a malformed entry must
 * degrade to the fallback rather than take down the page that reads it.
 */

/** Fired after this tab writes, since `storage` only reaches *other* tabs. */
const CHANGE_EVENT_PREFIX = 'krembonet:store:';

export interface LocalStore<T> {
  readonly key: string;
  /** Reads through to storage. Use for read-modify-write. */
  read(): T;
  write(value: T): void;
  /** Cached by the raw stored string, so React can compare by identity. */
  getSnapshot(): T;
  /** Storage does not exist during a server render. */
  getServerSnapshot(): T;
  subscribe(onChange: () => void): () => void;
}

export function createLocalStore<T>(options: {
  key: string;
  /** Must tolerate null, empty strings, and anything at all. */
  parse: (raw: string | null) => T;
  serialize: (value: T) => string;
  /** Returned when storage is unavailable or unreadable. */
  fallback: T;
}): LocalStore<T> {
  const { key, parse, serialize, fallback } = options;
  const changeEvent = `${CHANGE_EVENT_PREFIX}${key}`;

  function readRaw(): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      // Private browsing, or storage disabled entirely.
      return null;
    }
  }

  function read(): T {
    try {
      return parse(readRaw());
    } catch {
      return fallback;
    }
  }

  /*
   * Snapshot cache.
   *
   * `useSyncExternalStore` compares snapshots by identity, and parsing produces
   * a fresh object every call — so returning `read()` directly would make React
   * believe the store had changed on every render and loop. The raw stored
   * string is the natural cache key: if the characters in storage have not
   * changed, neither has the value they parse to.
   */
  let cachedRaw: string | null = null;
  let cached: T = fallback;
  let hasCached = false;

  function getSnapshot(): T {
    const raw = readRaw();
    if (!hasCached || raw !== cachedRaw) {
      cachedRaw = raw;
      cached = read();
      hasCached = true;
    }
    return cached;
  }

  function write(value: T): void {
    try {
      window.localStorage.setItem(key, serialize(value));
    } catch {
      // A full or unavailable store means the preference does not stick, which
      // is visible to the operator without an error dialog explaining it.
    }
    window.dispatchEvent(new Event(changeEvent));
  }

  function subscribe(onChange: () => void): () => void {
    const onStorage = (event: StorageEvent): void => {
      // `key` is null when the whole store is cleared, which is also a change.
      if (event.key === null || event.key === key) onChange();
    };

    window.addEventListener(changeEvent, onChange);
    window.addEventListener('storage', onStorage);

    return () => {
      window.removeEventListener(changeEvent, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }

  return {
    key,
    read,
    write,
    getSnapshot,
    getServerSnapshot: () => fallback,
    subscribe,
  };
}
