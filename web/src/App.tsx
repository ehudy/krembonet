import { AppShell } from './components/AppShell.js';
import { Overview } from './pages/Overview.js';
import { PrinterDetail } from './pages/PrinterDetail.js';
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

  const printer = matchPath('/printers/:slug', path);
  if (printer !== null && printer['slug'] !== undefined) {
    // Keyed so switching printers remounts rather than carrying the previous
    // device's data and refresh timer across.
    return <PrinterDetail key={printer['slug']} slug={printer['slug']} />;
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
