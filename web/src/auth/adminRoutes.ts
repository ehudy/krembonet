/**
 * Which dashboard routes are the admin's alone.
 *
 * Supplies and the activity log are the operator's back office — what the fleet
 * costs to run, and an audit trail of everything it did — rather than the
 * at-a-glance status a viewer standing at a printer needs. They are hidden from
 * a viewer's sidebar and closed to direct navigation.
 *
 * The list lives here, in one place, because two things read it and they must
 * not disagree: the sidebar deciding what to show, and the router deciding what
 * to redirect. A route hidden from the nav but reachable by URL, or the
 * reverse, is the kind of gap nobody notices until it is a report.
 *
 * This gates the *view*, not the data. Every one of these pages is built from
 * endpoints the server guards on its own, so a viewer who forges the URL past
 * the redirect still gets nothing — this only spares them a page of 403s.
 */
import { matchPath } from '../router.js';

export const ADMIN_ONLY_ROUTES: readonly string[] = ['/supplies', '/activity'];

/** Whether a path is one only an admin may see. Tolerant of a trailing slash. */
export function isAdminOnlyRoute(path: string): boolean {
  return ADMIN_ONLY_ROUTES.some((route) => matchPath(route, path) !== null);
}
