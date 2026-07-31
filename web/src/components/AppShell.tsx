/**
 * Full-width application shell with a persistent left sidebar.
 *
 * The sidebar collapses behind a toggle under 900px rather than disappearing,
 * so the hub stays usable from a phone next to the plotter.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { api } from '../api.js';
import { Link, matchPath, useRouter } from '../router.js';

const DEFAULT_HUB_TITLE = 'KremboNet';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  /** Extra path prefixes that should also light this item up. */
  match?: string[];
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: '🏠' },
  {
    to: '/printers/plotter',
    label: 'Plotter',
    icon: '🖨️',
    match: ['/printers/:slug'],
  },
  { to: '/admin', label: 'Admin', icon: '⚙️', match: ['/admin/:page'] },
];

function isActive(item: NavItem, path: string): boolean {
  if (item.to === '/') return path === '/';
  if (path === item.to) return true;
  return (item.match ?? []).some((pattern) => matchPath(pattern, path) !== null);
}

/** `KremboNet` becomes `KN`; a title with no inner capitals falls back to its
 * first two letters, so the mark is never blank. */
function initials(title: string): string {
  const capitals = title.match(/[A-Z]/g);
  if (capitals !== null && capitals.length >= 2) return capitals.slice(0, 3).join('');
  return title.slice(0, 2).toUpperCase();
}

export function AppShell({ children }: { children: ReactNode }) {
  const { path } = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState(DEFAULT_HUB_TITLE);

  // Close the drawer whenever navigation happens, otherwise it stays over the
  // page you just navigated to on mobile.
  useEffect(() => setIsOpen(false), [path]);

  // The operator owns the hub name, so it is fetched rather than compiled in.
  // A failed fetch keeps the default — a missing name should not blank the shell.
  useEffect(() => {
    let cancelled = false;
    api
      .getHub()
      .then((hub) => {
        if (!cancelled && hub.title !== '') setTitle(hub.title);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <div className={`shell${isOpen ? ' is-drawer-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            {initials(title)}
          </span>
          <span className="brand-text">
            <strong>{title}</strong>
            <small>Local device telemetry</small>
          </span>
        </div>

        <nav className="nav" aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={`nav-item${isActive(item, path) ? ' is-active' : ''}`}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className="dot" aria-hidden="true" />
          Local network only
        </div>
      </aside>

      {/* Click-away layer, only interactive while the drawer is open. */}
      <button
        type="button"
        className="drawer-scrim"
        aria-label="Close navigation"
        tabIndex={isOpen ? 0 : -1}
        onClick={() => setIsOpen(false)}
      />

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="drawer-toggle"
            aria-label="Toggle navigation"
            aria-expanded={isOpen}
            onClick={() => setIsOpen((open) => !open)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <span className="topbar-title">{title}</span>
        </header>

        <main className="content">{children}</main>
      </div>
    </div>
  );
}
