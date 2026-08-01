import { useCallback, useEffect, useState } from 'react';

import { api } from './api.js';
import { AccessGate } from './components/AccessGate.js';
import { AppShell } from './components/AppShell.js';
import { useBranding } from './hooks/useBranding.js';
import { I18nProvider, useTranslation } from './i18n/i18n.js';
import { Overview } from './pages/Overview.js';
import { DeviceDetail } from './pages/DeviceDetail.js';
import { Setup } from './pages/Setup.js';
import { AdminPortal } from './pages/admin/AdminPortal.js';
import { Link, matchPath, useRouter } from './router.js';
import type { AccessStatus } from './types.js';

function NotFound({ path }: { path: string }) {
  const { t } = useTranslation();

  return (
    <>
      <h1>{t('notFound.title')}</h1>
      <p className="muted">
        {/* Split around the path rather than interpolated, so the code element
            survives translation instead of being flattened into the string. */}
        {t('notFound.body').split('<path>')[0]}
        <code>{path}</code>
        {t('notFound.body').split('<path>')[1]}
      </p>
      <Link to="/" className="btn-primary">
        {t('notFound.back')}
      </Link>
    </>
  );
}

function Routes() {
  const { path } = useRouter();

  if (matchPath('/', path) !== null) return <Overview />;

  // `/printers/:slug` is kept alongside `/devices/:slug` so existing bookmarks
  // and the links in already-sent alert mail keep resolving.
  const device = matchPath('/devices/:slug', path) ?? matchPath('/printers/:slug', path);
  if (device !== null && device['slug'] !== undefined) {
    // Keyed so switching devices remounts rather than carrying the previous
    // device's data and refresh timer across.
    return <DeviceDetail key={device['slug']} slug={device['slug']} />;
  }

  if (path === '/admin' || path.startsWith('/admin/')) return <AdminPortal />;

  return <NotFound path={path} />;
}

/**
 * Access is never enforced here — the server decides, and this only mirrors the
 * decision so the browser can show a passcode box instead of a wall of 403s.
 * Every status endpoint refuses on its own, so a tampered client gains nothing.
 */
const ALWAYS_OPEN = (path: string): boolean =>
  path === '/admin' || path.startsWith('/admin/');

export function App() {
  const { path, navigate } = useRouter();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [access, setAccess] = useState<AccessStatus | null>(null);

  // Theme and custom CSS are applied to the document as a side effect, so this
  // has to run above every branch below — including the gate and the wizard,
  // which would otherwise render unthemed.
  const branding = useBranding();

  const check = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const status = await api.setupStatus(signal);
      setNeedsSetup(status.required);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      // If the check itself fails the server is unreachable, and showing the
      // setup wizard would be a lie. Fall through to the normal shell, which
      // reports the connection problem properly.
      setNeedsSetup(false);
    }
  }, []);

  const checkAccess = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      setAccess(await api.access(signal));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      // An unreachable server is not a locked one. Assume open and let the
      // pages report the connection failure themselves, rather than accusing
      // the operator of lacking a passcode their hub may not even use.
      setAccess({
        mode: 'public',
        allowed: true,
        reason: null,
        passcodeSet: false,
        isAdmin: false,
        isViewer: false,
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    return () => controller.abort();
  }, [check]);

  // Re-checked on navigation so signing in at /admin unlocks the dashboard on
  // the way back out, without a page reload.
  useEffect(() => {
    const controller = new AbortController();
    void checkAccess(controller.signal);
    return () => controller.abort();
  }, [checkAccess, path]);

  // Nothing is rendered until we know, so a configured hub never flashes the
  // setup wizard — or a passcode prompt — on load.
  if (needsSetup === null || access === null) return null;

  // Wraps every branch, not just the shell: the wizard and the passcode gate
  // are the two screens a first-time or locked-out visitor sees, and they are
  // the last places that should be stuck in English.
  return (
    <I18nProvider preference={branding.language}>
      {needsSetup ? (
        <Setup
          onComplete={() => {
            setNeedsSetup(false);
            navigate('/admin/devices');
          }}
        />
      ) : !access.allowed && !ALWAYS_OPEN(path) ? (
        // The admin portal stays reachable whatever the access mode. Gating it
        // would make `admin_only` unrecoverable: the only way back in is the
        // sign-in page the gate would be covering.
        <AccessGate
          status={access}
          hubTitle={branding.title}
          onUnlocked={() => void checkAccess()}
        />
      ) : (
        <AppShell
          title={branding.title}
          subtitle={branding.subtitle}
          logoUrl={branding.logoUrl}
          update={branding}
        >
          <Routes />
        </AppShell>
      )}
    </I18nProvider>
  );
}
