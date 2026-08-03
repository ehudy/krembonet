/**
 * Per-device alert routing.
 *
 * The behaviour worth pinning down is the fallback, because getting it backwards
 * is silent: a device whose routing is blank must reach the hub-wide
 * destinations, not nothing at all. A test that only checked the override would
 * pass just as happily against a version that dropped every default device's
 * alerts on the floor.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  looksLikeEmail,
  parseDeviceRouting,
  parseRecipients,
  parseWebhookIds,
  resolveEmailRecipients,
  resolveWebhookTargets,
  serializeRecipients,
  serializeWebhookIds,
} from '../src/alerts/routing.js';

const GLOBAL_RECIPIENTS = ['it@example.com'];
const TARGETS = [{ id: 1 }, { id: 2 }, { id: 3 }];

/** A device row with no routing of its own — what every device starts as. */
const UNROUTED = { alertEmailRecipients: null, alertWebhookIds: null };

describe('reading the stored columns', () => {
  it('treats null and blank as no opinion', () => {
    assert.deepEqual(parseDeviceRouting(UNROUTED), {
      emailRecipients: [],
      webhookIds: [],
    });
    assert.deepEqual(
      parseDeviceRouting({ alertEmailRecipients: '  ', alertWebhookIds: '  ' }),
      { emailRecipients: [], webhookIds: [] },
    );
  });

  it('splits an address list however the operator typed it', () => {
    for (const raw of [
      'a@x.com,b@x.com',
      'a@x.com, b@x.com',
      'a@x.com; b@x.com',
      'a@x.com\nb@x.com',
    ]) {
      assert.deepEqual(parseRecipients(raw), ['a@x.com', 'b@x.com'], raw);
    }
  });

  it('survives a webhook blob that will not parse', () => {
    // A hand-edited row costs this device its override, not its alerts.
    assert.deepEqual(
      parseDeviceRouting({ alertEmailRecipients: null, alertWebhookIds: '{oops' })
        .webhookIds,
      [],
    );
  });

  it('round-trips through the serialisers', () => {
    const stored = {
      alertEmailRecipients: serializeRecipients(['floor2@example.com']),
      alertWebhookIds: serializeWebhookIds([2, 1]),
    };

    assert.deepEqual(parseDeviceRouting(stored), {
      emailRecipients: ['floor2@example.com'],
      webhookIds: [1, 2],
    });
  });

  it('stores nothing for an empty selection, so blank reads back as blank', () => {
    assert.equal(serializeRecipients([]), null);
    assert.equal(serializeWebhookIds([]), null);
  });

  it('drops ids that are not ids, and de-duplicates the rest', () => {
    assert.deepEqual(parseWebhookIds([3, '1', 1, 0, -2, 'x', null]), [1, 3]);
    assert.deepEqual(parseWebhookIds('not an array'), []);
  });
});

describe('resolving destinations', () => {
  it('falls back to the hub-wide list when the device has no addresses', () => {
    assert.deepEqual(
      resolveEmailRecipients(parseDeviceRouting(UNROUTED), GLOBAL_RECIPIENTS),
      GLOBAL_RECIPIENTS,
    );
  });

  it('uses the device addresses instead of, not as well as, the global ones', () => {
    // "As well as" would quietly re-add the fleet-wide list to a printer that
    // was deliberately routed at one floor's support address.
    const routing = parseDeviceRouting({
      alertEmailRecipients: 'floor2-support@example.com',
      alertWebhookIds: null,
    });

    assert.deepEqual(resolveEmailRecipients(routing, GLOBAL_RECIPIENTS), [
      'floor2-support@example.com',
    ]);
  });

  it('sends to every enabled destination when nothing is selected', () => {
    assert.deepEqual(
      resolveWebhookTargets(parseDeviceRouting(UNROUTED), TARGETS),
      TARGETS,
    );
  });

  it('narrows to the selected destinations when some are', () => {
    const routing = parseDeviceRouting({
      alertEmailRecipients: null,
      alertWebhookIds: '[1,3]',
    });

    assert.deepEqual(resolveWebhookTargets(routing, TARGETS), [{ id: 1 }, { id: 3 }]);
  });

  it('ignores a selected destination that is disabled or gone', () => {
    const routing = parseDeviceRouting({
      alertEmailRecipients: null,
      alertWebhookIds: '[2,99]',
    });

    assert.deepEqual(resolveWebhookTargets(routing, TARGETS), [{ id: 2 }]);
  });
});

describe('the address check', () => {
  it('catches the typos worth catching', () => {
    for (const value of ['it@example.com', 'a.b+c@sub.example.co.uk']) {
      assert.equal(looksLikeEmail(value), true, value);
    }
    for (const value of ['it@example', 'example.com', 'it @example.com', '']) {
      assert.equal(looksLikeEmail(value), false, value);
    }
  });
});
