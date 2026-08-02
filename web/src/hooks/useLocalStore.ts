/**
 * React binding for a `LocalStore`.
 *
 * `useSyncExternalStore` rather than `useState` plus an effect: the store lives
 * outside React, several components read it at once — the sidebar and every
 * star button on the devices table — and they have to agree within the same
 * commit. Rolling this by hand is how you get a sidebar that updates one render
 * behind the star that caused it.
 */
import { useSyncExternalStore } from 'react';

import type { LocalStore } from '../lib/localStore.js';

export function useLocalStore<T>(store: LocalStore<T>): T {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
}
