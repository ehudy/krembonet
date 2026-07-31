/**
 * Admin area: auth gate, sub-navigation, logout.
 *
 * Session state is checked once on mount. Any admin request that comes back
 * 401 flips this back to the login form, so an expired cookie surfaces as a
 * sign-in prompt rather than a page full of errors.
 */
import { useCallback, useEffect, useState } from 'react';

import { ApiError, api } from '../../api.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Link, matchPath, useRouter } from '../../router.js';
import { AdminAlerts } from './AdminAlerts.js';
import { AdminLogin } from './AdminLogin.js';
import { AdminPaperTypes } from './AdminPaperTypes.js';
import { AdminSettings } from './AdminSettings.js';

const TABS = [
  { to: '/admin', label: 'Settings' },
  { to: '/admin/paper-types', label: 'Paper types' },
  { to: '/admin/alerts', label: 'Alert history' },
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
          <strong>The admin portal is disabled.</strong> Set <code>ADMIN_PASSWORD</code>{' '}
          in <code>.env</code> and restart the container to enable it. A blank password
          disables the portal rather than leaving it open.
        </div>
      </>
    );
  }

  if (state === 'out') {
    return <AdminLogin onSuccess={() => void check()} />;
  }

  const isPaperTypes = matchPath('/admin/paper-types', path) !== null;
  const isAlerts = matchPath('/admin/alerts', path) !== null;

  return (
    <>
      <PageHeader
        title="Admin"
        subtitle="SMTP, alert thresholds, and paper code mapping"
        actions={
          <button type="button" className="btn-secondary" onClick={() => void logout()}>
            Sign out
          </button>
        }
      />

      <nav className="tabs" aria-label="Admin sections">
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            className={`tab${
              (tab.to === '/admin' && !isPaperTypes && !isAlerts) ||
              (tab.to !== '/admin' && matchPath(tab.to, path) !== null)
                ? ' is-active'
                : ''
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {isPaperTypes ? <AdminPaperTypes /> : isAlerts ? <AdminAlerts /> : <AdminSettings />}
    </>
  );
}
