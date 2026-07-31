import { useCallback, useEffect, useState } from 'react';

import { api } from './api.js';
import { AppShell } from './components/AppShell.js';
import { Overview } from './pages/Overview.js';
import { DeviceDetail } from './pages/DeviceDetail.js';
import { Setup } from './pages/Setup.js';
import { AdminPortal } from './pages/admin/AdminPortal.js';
import { Link, matchPath, useRouter } from './router.js';

function NotFound({ path }: { path: string }) {
  return (
    <>
      <h1>Page not found</h1>
      <p className="muted">
        Nothing is routed at <code>{path}</code>.
      </p>
      <Link to="/" className="btn-primary">
        Back to Overview
      </Link>
    </>
  );
}

function Routes() {
  const { path } = useRouter();

  if (matchPath('/', path) !== null) return <Overview />;

  // `/printers/:slug` is kept alongside `/devices/:slug` so existing bookmarks
  // and the links in already-sent alert mail keep resolving.
  const device =
    matchPath('/devices/:slug', path) ?? matchPath('/printers/:slug', path);
  if (device !== null && device['slug'] !== undefined) {
    // Keyed so switching devices remounts rather than carrying the previous
    // device's data and refresh timer across.
    return <DeviceDetail key={device['slug']} slug={device['slug']} />;
  }

  if (path === '/admin' || path.startsWith('/admin/')) return <AdminPortal />;

  return <NotFound path={path} />;
}

export function App() {
  const { navigate } = useRouter();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);

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

  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    return () => controller.abort();
  }, [check]);

  // Nothing is rendered until we know, so a configured hub never flashes the
  // setup wizard on load.
  if (needsSetup === null) return null;

  if (needsSetup) {
    return (
      <Setup
        onComplete={() => {
          setNeedsSetup(false);
          navigate('/admin/devices');
        }}
      />
    );
  }

  return (
    <AppShell>
      <Routes />
    </AppShell>
  );
}
