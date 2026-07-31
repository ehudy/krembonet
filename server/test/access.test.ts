/**
 * Dashboard access decisions.
 *
 * The whole (mode × who is asking) table is enumerated deliberately. A gate
 * that wrongly allows looks identical in a browser to a gate that works — there
 * is no error, no log line, and nothing on screen to notice — so the only place
 * that difference is visible is here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideAccess, type Viewer } from '../src/auth/access.js';

const ANONYMOUS: Viewer = { isAdmin: false, isViewer: false, passcodeSet: true };
const UNLOCKED: Viewer = { isAdmin: false, isViewer: true, passcodeSet: true };
const ADMIN: Viewer = { isAdmin: true, isViewer: false, passcodeSet: true };
const NO_PASSCODE: Viewer = { isAdmin: false, isViewer: false, passcodeSet: false };

describe('public mode', () => {
  it('allows everyone, including a browser that has never authenticated', () => {
    assert.equal(decideAccess('public', ANONYMOUS).allowed, true);
    assert.equal(decideAccess('public', NO_PASSCODE).allowed, true);
    assert.equal(decideAccess('public', ADMIN).allowed, true);
  });
});

describe('passcode mode', () => {
  it('refuses a browser that has not entered the passcode', () => {
    const decision = decideAccess('passcode', ANONYMOUS);
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.reason, 'passcode-required');
  });

  it('allows a browser that has', () => {
    assert.equal(decideAccess('passcode', UNLOCKED).allowed, true);
  });

  it('falls back to admin-only when no passcode has been set', () => {
    // The failure this prevents: honouring "passcode" while the passcode is
    // missing would treat a half-configured gate as no gate, and publish the
    // dashboard at the exact moment the operator meant to restrict it.
    const decision = decideAccess('passcode', NO_PASSCODE);
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.reason, 'admin-required');
  });

  it('does not treat a stale viewer cookie as valid once the passcode is gone', () => {
    const stale: Viewer = { isAdmin: false, isViewer: true, passcodeSet: false };
    assert.equal(decideAccess('passcode', stale).allowed, false);
  });
});

describe('admin_only mode', () => {
  it('refuses an anonymous browser', () => {
    const decision = decideAccess('admin_only', ANONYMOUS);
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.reason, 'admin-required');
  });

  it('refuses a viewer who knows the passcode — it is not an admin credential', () => {
    // The passcode grants read access under `passcode` mode only. Letting it
    // through here would quietly make the lobby PIN equivalent to signing in.
    assert.equal(decideAccess('admin_only', UNLOCKED).allowed, false);
  });

  it('allows an admin', () => {
    assert.equal(decideAccess('admin_only', ADMIN).allowed, true);
  });
});

describe('an admin session', () => {
  it('passes in every mode', () => {
    // An admin who fat-fingers the viewer passcode they just set must not be
    // locked out of the hub by their own gate.
    for (const mode of ['public', 'passcode', 'admin_only'] as const) {
      assert.equal(decideAccess(mode, ADMIN).allowed, true, `admin blocked in ${mode}`);
    }
    assert.equal(
      decideAccess('passcode', { isAdmin: true, isViewer: false, passcodeSet: false })
        .allowed,
      true,
    );
  });
});

describe('refusals', () => {
  it('always carry a message the browser can show', () => {
    for (const viewer of [ANONYMOUS, NO_PASSCODE]) {
      for (const mode of ['passcode', 'admin_only'] as const) {
        const decision = decideAccess(mode, viewer);
        if (decision.allowed) continue;
        assert.ok(decision.message.length > 0, `${mode} refusal had no message`);
      }
    }
  });
});
