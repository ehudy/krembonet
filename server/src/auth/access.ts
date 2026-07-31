/**
 * Who may read the dashboard — the decision only, with no Fastify and no
 * database.
 *
 * Split out from the preHandler that uses it because the failure modes here are
 * quiet ones: a mode that accidentally allows everyone reads exactly like a
 * mode that works, and nothing in an HTTP test would notice. The table of
 * (mode × who is asking) is small enough to enumerate in tests, so it is.
 */
import type { AccessMode } from '../settings/types.js';

export interface Viewer {
  /** Holds a valid admin session cookie. */
  isAdmin: boolean;
  /** Has already entered the viewer passcode in this browser. */
  isViewer: boolean;
  /** Whether a viewer passcode has actually been set. */
  passcodeSet: boolean;
}

export type AccessDecision =
  /** Serve the request. */
  | { allowed: true }
  /** Refuse, and tell the browser which door to knock on. */
  | { allowed: false; reason: 'passcode-required' | 'admin-required'; message: string };

const ALLOW: AccessDecision = { allowed: true };

/**
 * Decides whether a request may read device status.
 *
 * An admin session always passes. Requiring an admin to also type the viewer
 * PIN would mean the person who set it is the one most likely to be locked out
 * by a typo in it.
 *
 * `passcode` mode with no passcode set falls back to admin-only rather than to
 * open. A half-configured gate must fail closed: the operator's intent was
 * plainly "not public", and honouring the mode they picked while the passcode
 * is missing would publish the dashboard at the exact moment they meant to
 * restrict it.
 */
export function decideAccess(mode: AccessMode, viewer: Viewer): AccessDecision {
  if (viewer.isAdmin) return ALLOW;

  switch (mode) {
    case 'public':
      return ALLOW;

    case 'passcode': {
      if (!viewer.passcodeSet) {
        return {
          allowed: false,
          reason: 'admin-required',
          message:
            'Dashboard access is restricted, but no viewer passcode has been set. Sign in as an admin and set one.',
        };
      }
      if (viewer.isViewer) return ALLOW;
      return {
        allowed: false,
        reason: 'passcode-required',
        message: 'A passcode is required to view this dashboard.',
      };
    }

    case 'admin_only':
      return {
        allowed: false,
        reason: 'admin-required',
        message: 'This dashboard is restricted to administrators.',
      };

    default: {
      // Unreachable while `AccessMode` is exhaustive, but a value that slipped
      // past the settings guard must not read as "public".
      const exhaustive: never = mode;
      void exhaustive;
      return {
        allowed: false,
        reason: 'admin-required',
        message: 'This dashboard is restricted.',
      };
    }
  }
}
