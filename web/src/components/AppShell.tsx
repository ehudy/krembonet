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
import {
  Droplets,
  History,
  Home,
  Layers,
  Menu,
  Printer,
  Settings,
  Star,
  type LucideIcon,
} from 'lucide-react';

import { VersionBadge } from './VersionBadge.js';
import { api } from '../api.js';
import { usePinnedDevices } from '../hooks/usePinnedDevices.js';
import { DEFAULT_HUB_TITLE } from '../hooks/useBranding.js';
import { useTranslation } from '../i18n/i18n.js';
import { Link, matchPath, useRouter } from '../router.js';
import type { UpdateStatus } from '../types.js';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Extra path prefixes that should also light this item up. */
  match?: string[];
}

/**
 * Fixed navigation.
 *
 * This used to render one link per device, which worked at three printers and
 * fell apart at thirty: the nav grew without bound, pushed Admin off the
 * bottom, and offered no way to find anything. The fleet pages replace that —
 * each is a whole-fleet view of one dimension — so the sidebar stays the same
 * height at 3 devices and at 300, and the only per-device entries are the ones
 * an operator explicitly pinned.
 */
const PRIMARY_NAV: NavItem[] = [
  { to: '/', label: 'nav.overview', icon: Home },
  // Individual devices live under /devices/:slug, so the item stays lit while
  // looking at one.
  {
    to: '/devices',
    label: 'nav.devices',
    icon: Printer,
    match: ['/devices/:slug', '/printers/:slug'],
  },
  { to: '/supplies', label: 'nav.supplies', icon: Droplets },
  { to: '/activity', label: 'nav.activity', icon: History },
  { to: '/media', label: 'nav.media', icon: Layers },
];

/** Pinned to the bottom, away from the things looked at every day. */
const ADMIN_NAV: NavItem = {
  to: '/admin',
  label: 'nav.admin',
  icon: Settings,
  match: ['/admin/:page'],
};

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

/**
 * The starred devices, under their own sub-header.
 *
 * Renders nothing at all when nothing is pinned — header included. An empty
 * "PINNED" heading over a gap is worse than no heading: it is a permanent
 * reminder of a feature the operator has chosen not to use, taking up the space
 * the nav was moved out of the sidebar to reclaim.
 *
 * Names come from the device list, which is fetched only when there is
 * something to name. A slug that no longer resolves is dropped once the list
 * arrives: it is a pin to a deleted device, and a nav item leading to a 404 is
 * worse than one that quietly goes away.
 */
function PinnedNav({ path }: { path: string }) {
  const { t } = useTranslation();
  const { pinned } = usePinnedDevices();
  const [names, setNames] = useState<Map<string, string> | null>(null);

  const hasPins = pinned.length > 0;

  useEffect(() => {
    if (!hasPins) return;

    const controller = new AbortController();
    api
      .listDevices(controller.signal)
      .then((data) => {
        setNames(new Map(data.devices.map((device) => [device.slug, device.displayName])));
      })
      .catch(() => {
        // The pages themselves report an unreachable hub. A sidebar that
        // announces it too would say the same thing twice, on every route.
      });

    return () => controller.abort();
  }, [hasPins]);

  if (!hasPins) return null;

  // Before the list resolves the slug stands in for the name. It is a readable
  // identifier and it is what the URL says, so the row is never blank or
  // shifting height while the request is in flight.
  const visible = pinned.filter((slug) => names === null || names.has(slug));
  if (visible.length === 0) return null;

  return (
    <>
      <h2 className="nav-heading">{t('nav.pinned')}</h2>
      <nav className="nav nav-pinned" aria-label={t('nav.pinned')}>
        {visible.map((slug) => {
          const to = `/devices/${encodeURIComponent(slug)}`;
          return (
            <Link
              key={slug}
              to={to}
              className={`nav-item${path === to ? ' is-active' : ''}`}
            >
              <Star className="nav-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="truncate">{names?.get(slug) ?? slug}</span>
            </Link>
          );
        })}
      </nav>
    </>
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

  // Close the drawer whenever navigation happens, otherwise it stays over the
  // page you just navigated to on mobile.
  useEffect(() => setIsOpen(false), [path]);

  return (
    <div className={`shell${isOpen ? ' is-drawer-open' : ''}`}>
      <aside className="sidebar">
        <Brand title={title} subtitle={subtitle} logoUrl={logoUrl} />

        <nav className="nav" aria-label={t('nav.main')}>
          {PRIMARY_NAV.map((item) => {
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
                {t(item.label)}
              </Link>
            );
          })}
        </nav>

        <PinnedNav path={path} />

        {/* Admin sits at the bottom, pushed there by the spacer, so the pages
            looked at daily stay at the top and the settings live out of the
            way — but always in the same place. */}
        <div className="sidebar-spacer" />

        <nav className="nav nav-secondary" aria-label={t('nav.admin')}>
          <Link
            to={ADMIN_NAV.to}
            className={`nav-item${isActive(ADMIN_NAV, path) ? ' is-active' : ''}`}
          >
            <Settings
              className="nav-icon"
              size={16}
              strokeWidth={1.75}
              aria-hidden="true"
            />
            {t(ADMIN_NAV.label)}
          </Link>
        </nav>

        <div className="sidebar-footer">
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
