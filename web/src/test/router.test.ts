/**
 * Path matching is the one part of the hand-rolled router with real logic, so
 * it is tested directly.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { matchPath } from '../router.js';

describe('matchPath', () => {
  it('matches a static path', () => {
    assert.deepEqual(matchPath('/', '/'), {});
    assert.deepEqual(matchPath('/admin', '/admin'), {});
  });

  it('extracts a param segment', () => {
    assert.deepEqual(matchPath('/devices/:slug', '/devices/plotter'), {
      slug: 'plotter',
    });
  });

  it('still matches the legacy device path', () => {
    // Alert mail already sent, and any bookmark made before M1, points at
    // /printers/:slug. Both patterns have to resolve.
    assert.deepEqual(matchPath('/printers/:slug', '/printers/plotter'), {
      slug: 'plotter',
    });
    assert.equal(matchPath('/devices/:slug', '/printers/plotter'), null);
  });

  it('rejects a different length', () => {
    assert.equal(matchPath('/devices/:slug', '/devices'), null);
    assert.equal(matchPath('/devices/:slug', '/devices/a/b'), null);
  });

  it('rejects a different static segment', () => {
    assert.equal(matchPath('/admin/settings', '/admin/paper-types'), null);
  });

  it('decodes percent-encoded params', () => {
    assert.deepEqual(matchPath('/media/:code', '/media/com.canon%2D012f'), {
      code: 'com.canon-012f',
    });
  });

  it('ignores trailing slashes', () => {
    assert.deepEqual(matchPath('/admin', '/admin/'), {});
  });
});
