/**
 * Which Overview an operator sees, kept in `localStorage`.
 *
 * The two modes answer different questions for different people standing in
 * different places, which is why this is a mode rather than more sections on
 * one page:
 *
 *  - Command Center is for whoever keeps the fleet running. It leads with what
 *    is broken, what needs ordering, and what happened overnight.
 *  - Floor & Queue is for whoever is trying to print something. It leads with
 *    "is the machine free, what is loaded in it, and will it run out
 *    mid-job" — and deliberately omits the error list and the event log, which
 *    are someone else's problem and only make the page harder to read.
 *
 * Per browser rather than per hub, for the same reason pins are: this is one
 * person's view of a shared dashboard, and there are no accounts here to hang
 * it off. Someone at the plotter choosing the floor view must not switch the
 * IT manager's screen on the next floor.
 */
import { createLocalStore } from './localStore.js';

export const OVERVIEW_VIEW_STORAGE_KEY = 'krembonet_overview_view';

export type OverviewMode = 'command_center' | 'floor_queue';

export const OVERVIEW_MODES: readonly OverviewMode[] = ['command_center', 'floor_queue'];

/**
 * The default for a browser that has never chosen.
 *
 * Command Center, because it is a superset of the information: someone who
 * wanted the floor view and got this one sees more than they needed, while the
 * reverse hides a broken printer from the person responsible for it.
 */
export const DEFAULT_OVERVIEW_MODE: OverviewMode = 'command_center';

export function isOverviewMode(value: unknown): value is OverviewMode {
  return OVERVIEW_MODES.includes(value as OverviewMode);
}

/**
 * The mode to actually render, given the stored preference and who is looking.
 *
 * A viewer is always shown Floor & Queue — the "is it free, what is loaded"
 * layout for someone standing at a printer — and has no toggle to change it, so
 * their stored preference (which they cannot set) is ignored. An admin gets
 * whatever they last chose, defaulting to Command Center.
 *
 * Kept as a pure function rather than a ternary at the call site because it is
 * the one line that encodes the whole auth-driven-default rule, and it is
 * worth being able to point a test at it.
 */
export function effectiveOverviewMode(
  stored: OverviewMode,
  isAdmin: boolean,
): OverviewMode {
  return isAdmin ? stored : 'floor_queue';
}

/**
 * Stored as a bare string rather than JSON.
 *
 * It is a single enum value, and a quoted `"floor_queue"` in devtools invites
 * someone to "fix" it into `floor_queue` and have it silently stop working.
 * Both forms are accepted on read for exactly that reason.
 */
export function parseOverviewMode(raw: string | null): OverviewMode {
  if (raw === null) return DEFAULT_OVERVIEW_MODE;

  const trimmed = raw.trim().replace(/^"(.*)"$/, '$1');
  return isOverviewMode(trimmed) ? trimmed : DEFAULT_OVERVIEW_MODE;
}

export const overviewModeStore = createLocalStore<OverviewMode>({
  key: OVERVIEW_VIEW_STORAGE_KEY,
  parse: parseOverviewMode,
  serialize: (mode) => mode,
  fallback: DEFAULT_OVERVIEW_MODE,
});
