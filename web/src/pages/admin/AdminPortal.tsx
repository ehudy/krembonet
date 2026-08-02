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
import { useAuth } from '../../auth/AuthContext.js';
import { PageHeader } from '../../components/PageHeader.js';
import { useTranslation } from '../../i18n/i18n.js';
import { Link, matchPath, useRouter } from '../../router.js';
import { AdminAlerts } from './AdminAlerts.js';
import { AdminDevices } from './AdminDevices.js';
import { AdminLogin } from './AdminLogin.js';
import { AdminPaperTypes } from './AdminPaperTypes.js';
import { AdminSettings } from './AdminSettings.js';
import { AdminWebhooks } from './AdminWebhooks.js';

/** Labels are dictionary keys, resolved at render so a language switch applies. */
const TABS: { to: string; key: string; icon: LucideIcon }[] = [
  { to: '/admin', key: 'settings', icon: SlidersHorizontal },
  { to: '/admin/devices', key: 'devices', icon: HardDrive },
  { to: '/admin/paper-types', key: 'paperTypes', icon: FileStack },
  { to: '/admin/alerts', key: 'alerts', icon: Bell },
];

/** Sections under the Alerts tab. */
const ALERT_TABS = [
  { to: '/admin/alerts', key: 'history' },
  { to: '/admin/alerts/webhooks', key: 'webhooks' },
];

export function AdminPortal() {
  const { path, navigate } = useRouter();
  const { t } = useTranslation();
  const { isAdmin, refresh, signOut } = useAuth();
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

  // The shared auth state losing admin — someone signed out from the sidebar on
  // this or another tab — means this portal's cached "signed in" is stale.
  // Re-checking against the cookie rather than trusting the flag keeps this
  // safe during login, where the flag briefly lags behind the fresh cookie: the
  // re-check reads the cookie and stays "in".
  useEffect(() => {
    if (!isAdmin) void check();
  }, [isAdmin, check]);

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
    // The shared sign-out clears the cookie and refreshes access, so the
    // sidebar indicator and the nav fall back to viewer mode with this.
    await signOut();
    setState('out');
    navigate('/admin');
  }

  if (state === 'loading') return <p className="muted">{t('admin.checkingSession')}</p>;

  if (state === 'disabled') {
    return (
      <>
        <PageHeader title={t('admin.title')} />
        <div className="banner is-warning">
          <strong>{t('admin.disabledTitle')}</strong>{' '}
          {/* Split on the placeholders so the code elements survive translation
              rather than being flattened into the sentence. */}
          {t('admin.disabledBody')
            .split(/<setup>|<env>|<file>/)
            .map((part, index) => (
              <span key={index}>
                {part}
                {index === 0 && <code>/setup</code>}
                {index === 1 && <code>ADMIN_PASSWORD</code>}
                {index === 2 && <code>.env</code>}
              </span>
            ))}
        </div>
      </>
    );
  }

  if (state === 'out') {
    return (
      <AdminLogin
        onSuccess={() => {
          // Both: `check` flips this portal in, `refresh` tells the shared auth
          // state so the sidebar shows the Admin Active indicator and the
          // admin-only nav without waiting for the next navigation.
          void check();
          void refresh();
        }}
      />
    );
  }

  const isDevices = matchPath('/admin/devices', path) !== null;
  const isPaperTypes = matchPath('/admin/paper-types', path) !== null;
  const isWebhooks = matchPath('/admin/alerts/webhooks', path) !== null;
  const isAlerts = matchPath('/admin/alerts', path) !== null || isWebhooks;
  const isSettings = !isDevices && !isPaperTypes && !isAlerts;

  return (
    <>
      <PageHeader
        title={t('admin.title')}
        subtitle={t('admin.subtitle')}
        actions={
          <button type="button" className="btn-secondary" onClick={() => void logout()}>
            {t('admin.signOut')}
          </button>
        }
      />

      <nav className="tabs" aria-label={t('admin.sections')}>
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
              {t(`admin.tabs.${tab.key}`)}
            </Link>
          );
        })}
      </nav>

      {isAlerts && (
        <nav className="tabs is-sub" aria-label={t('admin.alertSections')}>
          {ALERT_TABS.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              className={`tab${
                (tab.to === '/admin/alerts/webhooks') === isWebhooks ? ' is-active' : ''
              }`}
            >
              {t(`admin.tabs.${tab.key}`)}
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
