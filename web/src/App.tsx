import { AppShell } from './components/AppShell.js';
import { Overview } from './pages/Overview.js';
import { DeviceDetail } from './pages/DeviceDetail.js';
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
  return (
    <AppShell>
      <Routes />
    </AppShell>
  );
}
