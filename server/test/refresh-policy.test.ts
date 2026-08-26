/**
 * The rules that decide whether to touch a printer at all.
 *
 * Both halves guard a mistake that is invisible in a browser. A forced refresh
 * that quietly honoured the TTL looks identical to one that worked — the page
 * updates, the ages tick over, and the number the operator walked back to their
 * desk to check is still the one from before they changed the roll. A cooldown
 * that failed open looks identical too, until a plotter stops answering.
 *
 * These import `refresh-policy.js` rather than `pollDevice.js` on purpose:
 * pollDevice opens SQLite at import time, and none of this needs a database.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeviceCapability } from '../src/devices/adapter.js';
import type { DeviceView } from '../src/poller/cache.js';
import {
  forceCooldownRemainingMs,
  FORCE_REFRESH_COOLDOWN_MS,
  JOBS_TTL_MS,
  markForced,
  planRefresh,
  resetForceLimiter,
  SUPPLIES_TTL_MS,
} from '../src/poller/refresh-policy.js';

const ALL: DeviceCapability[] = ['reachability', 'supplies', 'media', 'jobs'];

/** A cached view whose two readings are `ageMs` old. */
function viewAged(suppliesAgeMs: number, jobsAgeMs: number): DeviceView {
  const at = (ageMs: number): string => new Date(Date.now() - ageMs).toISOString();

  return {
    slug: 'plotter',
    displayName: 'Plotter',
    location: null,
    model: null,
    host: '10.0.0.9',
    adapter: 'ipp',
    state: 'idle',
    stateReasons: [],
    supplies: [],
    media: [],
    jobs: [],
    capabilities: ALL,
    isOnline: true,
    lastSuccessAt: at(suppliesAgeMs),
    lastError: null,
    consecutiveFailures: 0,
    suppliesUpdatedAt: at(suppliesAgeMs),
    jobsUpdatedAt: at(jobsAgeMs),
  };
}

describe('planRefresh — TTL path', () => {
  it('reads nothing when both readings are inside their TTL', () => {
    const plan = planRefresh({
      view: viewAged(1_000, 1_000),
      supported: ALL,
      wantSupplies: true,
      wantJobs: true,
      force: false,
    });

    assert.deepEqual(plan, { supplies: false, jobs: false });
  });

  it('reads each section once its own TTL has passed', () => {
    // Between the two TTLs: the queue is stale, ink and paper are not.
    const plan = planRefresh({
      view: viewAged(1_000, JOBS_TTL_MS + 1_000),
      supported: ALL,
      wantSupplies: true,
      wantJobs: true,
      force: false,
    });

    assert.deepEqual(plan, { supplies: false, jobs: true });
  });

  it('reads everything for a device that has never been polled', () => {
    const plan = planRefresh({
      view: undefined,
      supported: ALL,
      wantSupplies: true,
      wantJobs: true,
      force: false,
    });

    assert.deepEqual(plan, { supplies: true, jobs: true });
  });
});

describe('planRefresh — forced path', () => {
  it('reads both sections however fresh the cache is', () => {
    // The exact case the button exists for: someone has just changed a roll,
    // well inside the 60s supplies window.
    const plan = planRefresh({
      view: viewAged(0, 0),
      supported: ALL,
      wantSupplies: true,
      wantJobs: true,
      force: true,
    });

    assert.deepEqual(plan, { supplies: true, jobs: true });
  });

  it('differs from the unforced plan on the same fresh cache', () => {
    const view = viewAged(1_000, 1_000);
    const request = {
      view,
      supported: ALL,
      wantSupplies: true,
      wantJobs: true,
    };

    assert.deepEqual(planRefresh({ ...request, force: false }), {
      supplies: false,
      jobs: false,
    });
    assert.deepEqual(planRefresh({ ...request, force: true }), {
      supplies: true,
      jobs: true,
    });
  });

  it('still refuses to ask an SNMP printer for a print queue', () => {
    // Forcing overrides the TTL, never the protocol. RFC 2707 is effectively
    // never implemented, so this round trip could only ever fail.
    const plan = planRefresh({
      view: viewAged(0, 0),
      supported: ['reachability', 'supplies', 'media'],
      wantSupplies: true,
      wantJobs: true,
      force: true,
    });

    assert.deepEqual(plan, { supplies: true, jobs: false });
  });

  it('reads a reachability-only device, which the TTL path skips', () => {
    // `pollSupplies` degrades to a bare reachability probe here, and re-checking
    // reachability is exactly what pressing Refresh on a dead device means.
    const supported: DeviceCapability[] = ['reachability'];
    const view = viewAged(SUPPLIES_TTL_MS * 10, SUPPLIES_TTL_MS * 10);

    assert.equal(
      planRefresh({ view, supported, wantSupplies: true, wantJobs: true, force: false })
        .supplies,
      false,
    );
    assert.equal(
      planRefresh({ view, supported, wantSupplies: true, wantJobs: true, force: true })
        .supplies,
      true,
    );
  });

  it('honours a caller that only asked for the queue', () => {
    // `force` overrides the TTL, not the request. Nothing should be able to
    // turn the dashboard's 60s jobs tick into a supplies read.
    const plan = planRefresh({
      view: viewAged(0, 0),
      supported: ALL,
      wantSupplies: false,
      wantJobs: true,
      force: true,
    });

    assert.deepEqual(plan, { supplies: false, jobs: true });
  });
});

describe('forced refresh cooldown', () => {
  it('allows the first force on a device', () => {
    resetForceLimiter();
    assert.equal(forceCooldownRemainingMs('plotter'), 0);
  });

  it('refuses a second force inside ten seconds', () => {
    resetForceLimiter();
    const now = Date.now();
    markForced('plotter', now);

    assert.equal(forceCooldownRemainingMs('plotter', now), FORCE_REFRESH_COOLDOWN_MS);
    assert.equal(forceCooldownRemainingMs('plotter', now + 1_000), 9_000);
    assert.equal(forceCooldownRemainingMs('plotter', now + 9_999), 1);
  });

  it('allows another force once the cooldown has elapsed', () => {
    resetForceLimiter();
    const now = Date.now();
    markForced('plotter', now);

    assert.equal(forceCooldownRemainingMs('plotter', now + FORCE_REFRESH_COOLDOWN_MS), 0);
    assert.equal(forceCooldownRemainingMs('plotter', now + 60_000), 0);
  });

  it('is ten seconds', () => {
    // Pinned deliberately: the client shows this number and disables its button
    // for it, so a change here is a change to what the page tells people.
    assert.equal(FORCE_REFRESH_COOLDOWN_MS, 10_000);
  });

  it('can be re-stamped to measure quiet time rather than request time', () => {
    // What `forceRefresh` does on the way out. A read that took nine seconds
    // would otherwise leave a one-second window, and the devices that answer
    // slowly are the ones with the fragile network stacks.
    resetForceLimiter();
    const started = Date.now();
    markForced('plotter', started);

    const finished = started + 9_000;
    assert.equal(forceCooldownRemainingMs('plotter', finished), 1_000);

    markForced('plotter', finished);
    assert.equal(forceCooldownRemainingMs('plotter', finished), FORCE_REFRESH_COOLDOWN_MS);
    assert.equal(forceCooldownRemainingMs('plotter', finished + 9_000), 1_000);
  });

  it('tracks devices separately', () => {
    // The thing being protected is one printer's network stack. Refreshing the
    // plotter must not lock out the copier down the hall.
    resetForceLimiter();
    const now = Date.now();
    markForced('plotter', now);

    assert.equal(forceCooldownRemainingMs('plotter', now), FORCE_REFRESH_COOLDOWN_MS);
    assert.equal(forceCooldownRemainingMs('copier', now), 0);
  });

  it('does not lock a device out when the clock jumps backwards', () => {
    resetForceLimiter();
    const now = Date.now();
    markForced('plotter', now);

    // An NTP correction mid-cooldown must not extend it past its own length.
    assert.equal(
      forceCooldownRemainingMs('plotter', now - 60_000),
      FORCE_REFRESH_COOLDOWN_MS,
    );
  });
});
