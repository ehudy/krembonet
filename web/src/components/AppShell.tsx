/**
 * Full-width application shell with a persistent left sidebar.
 *
 * The sidebar collapses behind a toggle under 900px rather than disappearing,
 * so the hub stays usable from a phone next to the plotter.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { api } from '../api.js';
import { DEFAULT_HUB_TITLE } from '../hooks/useBranding.js';
import { Link, matchPath, useRouter } from '../router.js';
import type { DeviceSummary } from '../types.js';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  /** Extra path prefixes that should also light this item up. */
  match?: string[];
}

const OVERVIEW: NavItem = { to: '/', label: 'Overview', icon: '🏠' };
const ADMIN: NavItem = {
  to: '/admin',
  label: 'Admin',
  icon: '⚙️',
  match: ['/admin/:page'],
};

/**
 * Builds the sidebar from the devices the hub actually has.
 *
 * This used to be a hardcoded link to one device's slug, which is the single
 * assumption that made the app a one-printer tool.
 */
function navFor(devices: DeviceSummary[]): NavItem[] {
  return [
    OVERVIEW,
    ...devices.map((device) => ({
      to: `/devices/${device.slug}`,
      label: device.displayName,
      icon: '🖨️',
      // Bookmarks and older links still point at /printers/:slug, so the item
      // has to light up for both.
      match: [`/printers/${device.slug}`],
    })),
    // With no devices the sidebar would be Overview and Admin only, which
    // reads as a broken install rather than an empty one.
    ...(devices.length === 0
      ? [{ to: '/admin/devices', label: 'Add a device', icon: '➕' }]
      : []),
    ADMIN,
  ];
}

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

interface AppShellProps {
  children: ReactNode;
  /**
   * The operator-owned hub name. Passed in rather than fetched here: App
   * already loads it as part of branding, and a second `/api/hub` request would
   * let the sidebar and the document title disagree for a frame.
   */
  title?: string;
}

export function AppShell({ children, title = DEFAULT_HUB_TITLE }: AppShellProps) {
  const { path } = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);

  // Close the drawer whenever navigation happens, otherwise it stays over the
  // page you just navigated to on mobile.
  useEffect(() => setIsOpen(false), [path]);

  // Reloaded on navigation so a device added in the admin portal appears in the
  // sidebar without a full page refresh.
  useEffect(() => {
    const controller = new AbortController();
    api
      .listDevices(controller.signal)
      .then((response) => setDevices(response.devices))
      .catch(() => undefined);
    return () => controller.abort();
  }, [path]);

  const nav = navFor(devices);

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
          {nav.map((item) => (
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
