/**
 * Who is looking, shared across the shell.
 *
 * The server already answers this at `/api/access`, and App already fetches it
 * and re-checks it on every navigation. This context is that one answer made
 * available to everything under the shell — the sidebar deciding which nav
 * items to show, the Overview deciding which layout to default to, the route
 * guards deciding whether to redirect — so all of them move together the moment
 * an admin signs in or out, rather than each fetching and drifting.
 *
 * It carries `isAdmin` and two verbs, not the whole access payload: consumers
 * only ever ask "is this an admin" and "change that". `refresh` re-reads the
 * server's answer (after a sign-in elsewhere); `signOut` ends the session and
 * refreshes in one step.
 */
import { createContext, useContext, type ReactNode } from 'react';

export interface AuthValue {
  /** True when this browser holds a valid admin session. */
  isAdmin: boolean;
  /** Re-read access state from the server. */
  refresh: () => Promise<void>;
  /** End the admin session, then refresh — so the UI updates without a reload. */
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({
  value,
  children,
}: {
  value: AuthValue;
  children: ReactNode;
}) {
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
