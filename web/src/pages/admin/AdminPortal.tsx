/**
 * Admin area: auth gate, sub-navigation, logout.
 *
 * Session state is checked once on mount. Any admin request that comes back
 * 401 flips this back to the login form, so an expired cookie surfaces as a
 * sign-in prompt rather than a page full of errors.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  FileStack,
  HardDrive,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';

import { ApiError, api } from '../../api.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Link, matchPath, useRouter } from '../../router.js';
import { AdminAlerts } from './AdminAlerts.js';
import { AdminDevices } from './AdminDevices.js';
import { AdminLogin } from './AdminLogin.js';
import { AdminPaperTypes } from './AdminPaperTypes.js';
import { AdminSettings } from './AdminSettings.js';
import { AdminWebhooks } from './AdminWebhooks.js';

const TABS: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/admin', label: 'Settings', icon: SlidersHorizontal },
  { to: '/admin/devices', label: 'Devices', icon: HardDrive },
  { to: '/admin/paper-types', label: 'Paper types', icon: FileStack },
  { to: '/admin/alerts', label: 'Alerts', icon: Bell },
];

/** Sections under the Alerts tab. */
const ALERT_TABS = [
  { to: '/admin/alerts', label: 'History' },
  { to: '/admin/alerts/webhooks', label: 'Webhooks' },
];

export function AdminPortal() {
  const { path, navigate } = useRouter();
  const [state, setState] = useState<'loading' | 'in' | 'out' | 'disabled'>('loading');

  const check = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const session = await api.session(signal);
      if (!session.enabled) setState('disabled');
      else setState(session.authenticated ? 'in' : 'out');
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setState('out');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    return () => controller.abort();
  }, [check]);

  // Any 401 from a nested admin call means the cookie expired mid-session.
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent): void => {
      if (event.reason instanceof ApiError && event.reason.status === 401) {
        setState('out');
      }
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, []);

  async function logout(): Promise<void> {
    await api.logout().catch(() => undefined);
    setState('out');
    navigate('/admin');
  }

  if (state === 'loading') return <p className="muted">Checking session…</p>;

  if (state === 'disabled') {
    return (
      <>
        <PageHeader title="Admin" />
        <div className="banner is-warning">
          <strong>The admin portal is disabled.</strong> No admin password is set. Either
          complete first-run setup at <code>/setup</code>, or set{' '}
          <code>ADMIN_PASSWORD</code> in <code>.env</code> and restart. A blank password
          disables the portal rather than leaving it open.
        </div>
      </>
    );
  }

  if (state === 'out') {
    return <AdminLogin onSuccess={() => void check()} />;
  }

  const isDevices = matchPath('/admin/devices', path) !== null;
  const isPaperTypes = matchPath('/admin/paper-types', path) !== null;
  const isWebhooks = matchPath('/admin/alerts/webhooks', path) !== null;
  const isAlerts = matchPath('/admin/alerts', path) !== null || isWebhooks;
  const isSettings = !isDevices && !isPaperTypes && !isAlerts;

  return (
    <>
      <PageHeader
        title="Admin"
        subtitle="Devices, access, alerts, appearance, and paper code mapping"
        actions={
          <button type="button" className="btn-secondary" onClick={() => void logout()}>
            Sign out
          </button>
        }
      />

      <nav className="tabs" aria-label="Admin sections">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <Link
              key={tab.to}
              to={tab.to}
              className={`tab${
                (tab.to === '/admin' && isSettings) ||
                (tab.to === '/admin/alerts' && isAlerts) ||
                (tab.to !== '/admin' &&
                  tab.to !== '/admin/alerts' &&
                  matchPath(tab.to, path) !== null)
                  ? ' is-active'
                  : ''
              }`}
            >
              <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {isAlerts && (
        <nav className="tabs is-sub" aria-label="Alert sections">
          {ALERT_TABS.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              className={`tab${
                (tab.to === '/admin/alerts/webhooks') === isWebhooks ? ' is-active' : ''
              }`}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      )}

      {isDevices ? (
        <AdminDevices />
      ) : isPaperTypes ? (
        <AdminPaperTypes />
      ) : isWebhooks ? (
        <AdminWebhooks />
      ) : isAlerts ? (
        <AdminAlerts />
      ) : (
        <AdminSettings />
      )}
    </>
  );
}
