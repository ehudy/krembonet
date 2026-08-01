/**
 * Every admin route is behind an admin guard, and every device-status route is
 * behind the access guard.
 *
 * This is a source-level invariant test, which is unusual enough to justify.
 * The failure it prevents is one nobody notices: a new endpoint added to
 * `routes/admin.ts` without `{ preHandler: requireAdmin }` works perfectly in
 * every manual test — the developer is logged in — and is world-readable in
 * production. There is nothing to see in a browser and nothing in a log.
 *
 * Booting Fastify and asserting 401s would be a stronger check, but it only
 * covers the routes the test remembers to name; this covers whatever is in the
 * file, including routes added tomorrow. The runtime side is verified
 * separately against a live server before release.
 *
 * If a route legitimately has to be open, add it to `INTENTIONALLY_OPEN` with
 * the reason. Making that list the only way to pass is the point: an exemption
 * becomes a deliberate, reviewable edit rather than an omission.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const routesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes');

/**
 * Admin endpoints that must stay reachable without a session, and why.
 *
 * All three are the sign-in mechanism itself or a question about it. None
 * returns anything about a device, a setting, or a secret.
 */
const INTENTIONALLY_OPEN: Record<string, string> = {
  'POST /api/admin/login': 'the login endpoint itself; throttled per IP',
  'POST /api/admin/logout':
    'clears a cookie — refusing an unauthenticated logout is pointless',
  'GET /api/admin/session':
    'reports only whether a credential exists and whether this browser holds one',
};

interface Route {
  verb: string;
  path: string;
  file: string;
  guard: string | null;
}

/**
 * Finds route registrations by anchoring on the path literal.
 *
 * Anchoring on `app.get(` instead would need to match the generic type
 * arguments, which nest (`app.put<{ Body: Record<string, unknown> }>`) and
 * quietly skip the routes whose generics contain a `>` — silently under-testing
 * exactly the endpoints with the most complex bodies.
 */
function routesIn(file: string): Route[] {
  const source = readFileSync(join(routesDir, file), 'utf8');
  const scopeHooks = [...source.matchAll(/app\.addHook\('preHandler',\s*(\w+)\)/g)].map(
    (match) => match[1] as string,
  );

  const found: Route[] = [];

  for (const match of source.matchAll(/'(\/api\/[^']*)'/g)) {
    const index = match.index;
    const before = source.slice(Math.max(0, index - 200), index);
    const verb = /app\.(get|post|put|delete|patch)\s*(?:<[\s\S]*?>)?\s*\(\s*$/.exec(
      before,
    );
    if (verb === null) continue;

    const after = source.slice(index, index + 260);
    const guard = after.includes('requireAdmin')
      ? 'requireAdmin'
      : after.includes('requireViewer')
        ? 'requireViewer'
        : (scopeHooks[0] ?? null);

    found.push({
      verb: (verb[1] as string).toUpperCase(),
      path: match[1] as string,
      file,
      guard,
    });
  }

  return found;
}

function allRoutes(): Route[] {
  return readdirSync(routesDir)
    .filter((name) => name.endsWith('.ts'))
    .flatMap(routesIn);
}

const ROUTES = allRoutes();
const key = (route: Route): string => `${route.verb} ${route.path}`;

describe('route discovery', () => {
  it('finds the routes at all, so a passing suite means something', () => {
    // Guards against the scan silently matching nothing after a refactor, which
    // would make every assertion below vacuously true.
    assert.ok(ROUTES.length >= 25, `only found ${ROUTES.length} routes`);

    for (const expected of [
      'GET /api/health',
      'POST /api/admin/login',
      'PUT /api/admin/settings',
      'POST /api/admin/devices/discover',
      'GET /api/printers/:slug/status',
    ]) {
      assert.ok(
        ROUTES.some((route) => key(route) === expected),
        `route scan missed ${expected}`,
      );
    }
  });
});

describe('/api/admin', () => {
  const adminRoutes = ROUTES.filter((route) => route.path.startsWith('/api/admin'));

  it('covers a meaningful number of endpoints', () => {
    assert.ok(adminRoutes.length >= 20, `only found ${adminRoutes.length} admin routes`);
  });

  it('requires an admin session on every route that is not explicitly exempt', () => {
    const unguarded = adminRoutes
      .filter((route) => route.guard !== 'requireAdmin')
      .filter((route) => INTENTIONALLY_OPEN[key(route)] === undefined)
      .map((route) => `${key(route)} (${route.file})`);

    assert.deepEqual(
      unguarded,
      [],
      `admin routes without requireAdmin:\n  ${unguarded.join('\n  ')}\n` +
        'Add { preHandler: requireAdmin }, or list it in INTENTIONALLY_OPEN with a reason.',
    );
  });

  it('has no stale exemptions', () => {
    // An exemption for a route that no longer exists is a hole waiting for a
    // future endpoint to be given the same name.
    for (const exempt of Object.keys(INTENTIONALLY_OPEN)) {
      assert.ok(
        adminRoutes.some((route) => key(route) === exempt),
        `INTENTIONALLY_OPEN lists ${exempt}, which is not a route any more`,
      );
    }
  });
});

describe('device status routes', () => {
  it('are behind the access guard, so access modes cannot be bypassed', () => {
    const statusRoutes = ROUTES.filter((route) => route.file === 'status.ts');
    assert.ok(statusRoutes.length >= 4);

    for (const route of statusRoutes) {
      assert.equal(route.guard, 'requireViewer', `${key(route)} is not access-guarded`);
    }
  });
});

describe('the open surface', () => {
  it('is exactly the endpoints the browser needs before it can authenticate', () => {
    // A deliberate whitelist: anything new showing up here is a decision that
    // should be made on purpose, not discovered later.
    const open = ROUTES.filter(
      (route) => route.guard === null && INTENTIONALLY_OPEN[key(route)] === undefined,
    )
      .map(key)
      .sort();

    assert.deepEqual(open, [
      'GET /api/access',
      'GET /api/health',
      'GET /api/hub',
      'GET /api/setup',
      'POST /api/access/lock',
      'POST /api/access/unlock',
      'POST /api/setup',
    ]);
  });
});
