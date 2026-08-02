/**
 * React binding for the Overview view-mode store.
 */
import { useCallback } from 'react';

import { useLocalStore } from './useLocalStore.js';
import { overviewModeStore, type OverviewMode } from '../lib/overviewMode.js';

export function useOverviewMode(): [OverviewMode, (mode: OverviewMode) => void] {
  const mode = useLocalStore(overviewModeStore);

  const setMode = useCallback((next: OverviewMode) => {
    overviewModeStore.write(next);
  }, []);

  return [mode, setMode];
}
