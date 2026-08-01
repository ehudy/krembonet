/**
 * Full-width application shell with a persistent left sidebar.
 *
 * The sidebar collapses behind a toggle under 900px rather than disappearing,
 * so the hub stays usable from a phone next to the plotter.
 *
 * Branding is passed in rather than fetched here: App already loads it, and a
 * second `/api/hub` request would let the sidebar and the document title
 * disagree for a frame.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Home, Menu, Plus, Printer, Settings, type LucideIcon } from 'lucide-react';

import { api } from '../api.js';
import { VersionBadge } from './VersionBadge.js';
import { DEFAULT_HUB_TITLE } from '../hooks/useBranding.js';
import { useTranslation, type Translate } from '../i18n/i18n.js';
import { Link, matchPath, useRouter } from '../router.js';
import type { DeviceSummary, UpdateStatus } from '../types.js';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Extra path prefixes that should also light this item up. */
  match?: string[];
}

/**
 * Builds the sidebar from the devices the hub actually has.
 *
 * This used to be a hardcoded link to one device's slug, which is the single
 * assumption that made the app a one-printer tool.
 */
function navFor(devices: DeviceSummary[], t: Translate): NavItem[] {
  return [
    { to: '/', label: t('nav.overview'), icon: Home },
    ...devices.map((device) => ({
      to: `/devices/${device.slug}`,
      label: device.displayName,
      icon: Printer,
      // Bookmarks and older links still point at /printers/:slug, so the item
      // has to light up for both.
      match: [`/printers/${device.slug}`],
    })),
    // With no devices the sidebar would be Overview and Admin only, which
    // reads as a broken install rather than an empty one.
    ...(devices.length === 0
      ? [{ to: '/admin/devices', label: t('nav.addDevice'), icon: Plus }]
      : []),
    { to: '/admin', label: t('nav.admin'), icon: Settings, match: ['/admin/:page'] },
  ];
}

function isActive(item: NavItem, path: string): boolean {
  if (item.to === '/') return path === '/';
  if (path === item.to) return true;
  return (item.match ?? []).some((pattern) => matchPath(pattern, path) !== null);
}

interface AppShellProps {
  children: ReactNode;
  title?: string;
  /** Blank hides the line under the title entirely. */
  subtitle?: string;
  /** Blank falls back to the text title. */
  logoUrl?: string;
  /** Omitted until the branding fetch resolves. */
  update?: UpdateStatus;
}

/**
 * The hub's own mark: a logo when one is configured, the name otherwise.
 *
 * There is deliberately no initials badge. A generated two-letter square is a
 * placeholder pretending to be an identity — it made every hub look like the
 * same unbranded product, and it was the loudest coloured element on a palette
 * that is otherwise almost entirely neutral.
 */
function Brand({
  title,
  subtitle,
  logoUrl,
}: {
  title: string;
  subtitle: string;
  logoUrl: string;
}) {
  return (
    <div className="brand">
      {logoUrl === '' ? (
        <span className="brand-text">
          <strong>{title}</strong>
          {/* Rendered only when there is something to say. An empty element
              would still occupy its line-height and leave the title floating. */}
          {subtitle !== '' && <small>{subtitle}</small>}
        </span>
      ) : (
        // The title becomes the alt text: if the image fails, the hub is still
        // named rather than showing a broken-image icon with no context.
        <img className="brand-logo" src={logoUrl} alt={title} />
      )}
    </div>
  );
}

export function AppShell({
  children,
  title = DEFAULT_HUB_TITLE,
  subtitle = '',
  logoUrl = '',
  update,
}: AppShellProps) {
  const { path } = useRouter();
  const { t } = useTranslation();
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

  const nav = navFor(devices, t);

  return (
    <div className={`shell${isOpen ? ' is-drawer-open' : ''}`}>
      <aside className="sidebar">
        <Brand title={title} subtitle={subtitle} logoUrl={logoUrl} />

        <nav className="nav" aria-label={t('nav.main')}>
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`nav-item${isActive(item, path) ? ' is-active' : ''}`}
              >
                {/* strokeWidth 1.75 rather than the default 2: at 16px the
                    default reads heavy next to 13px label text. */}
                <Icon
                  className="nav-icon"
                  size={16}
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <span className="sidebar-status">
            <span className="dot" aria-hidden="true" />
            {t('nav.localOnly')}
          </span>
          {/* Rendered only once the version is known, so the footer does not
              reflow from "vundefined" to a real number on load. */}
          {update !== undefined && update.currentVersion !== '' && (
            <VersionBadge status={update} />
          )}
        </div>
      </aside>

      {/* Click-away layer, only interactive while the drawer is open. */}
      <button
        type="button"
        className="drawer-scrim"
        aria-label={t('nav.closeNav')}
        tabIndex={isOpen ? 0 : -1}
        onClick={() => setIsOpen(false)}
      />

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="drawer-toggle"
            aria-label={t('nav.toggle')}
            aria-expanded={isOpen}
            onClick={() => setIsOpen((open) => !open)}
          >
            <Menu size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <span className="topbar-title">{title}</span>
        </header>

        <main className="content">{children}</main>
      </div>
    </div>
  );
}
