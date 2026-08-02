/**
 * Which routes the auth layer treats as admin-only.
 *
 * The set is read in two places that must agree — the sidebar hides these, the
 * router redirects them — so the shared helper is what keeps a route from being
 * hidden yet reachable, or the reverse. The trailing-slash case matters because
 * a hand-typed URL routinely carries one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ADMIN_ONLY_ROUTES, isAdminOnlyRoute } from '../auth/adminRoutes.js';

describe('isAdminOnlyRoute', () => {
  it('covers exactly supplies and the activity log', () => {
    assert.deepEqual([...ADMIN_ONLY_ROUTES].sort(), ['/activity', '/supplies']);
  });

  it('flags the admin-only routes', () => {
    assert.equal(isAdminOnlyRoute('/supplies'), true);
    assert.equal(isAdminOnlyRoute('/activity'), true);
  });

  it('tolerates a trailing slash, as a typed URL often has', () => {
    assert.equal(isAdminOnlyRoute('/supplies/'), true);
    assert.equal(isAdminOnlyRoute('/activity/'), true);
  });

  it('leaves the viewer routes open', () => {
    for (const path of ['/', '/devices', '/media', '/devices/plotter', '/admin']) {
      assert.equal(isAdminOnlyRoute(path), false, path);
    }
  });

  it('does not match a longer path that merely starts the same', () => {
    // /supplies-report is a different route, not the admin one.
    assert.equal(isAdminOnlyRoute('/supplies-report'), false);
    assert.equal(isAdminOnlyRoute('/activity/log/extra'), false);
  });
});
