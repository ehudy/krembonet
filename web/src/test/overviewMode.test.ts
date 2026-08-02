/**
 * Parsing the stored Overview mode.
 *
 * Same reasoning as the pin list: the value is user-writable, it is read on
 * every render of the page, and an unrecognised entry has to fall back to a
 * working layout rather than render nothing at all.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_OVERVIEW_MODE,
  OVERVIEW_MODES,
  effectiveOverviewMode,
  isOverviewMode,
  parseOverviewMode,
} from '../lib/overviewMode.js';

describe('parseOverviewMode', () => {
  it('reads both modes', () => {
    assert.equal(parseOverviewMode('command_center'), 'command_center');
    assert.equal(parseOverviewMode('floor_queue'), 'floor_queue');
  });

  it('defaults to the command centre for a browser that has never chosen', () => {
    // The superset of the information: someone who wanted the floor view sees
    // more than they needed, where the reverse would hide a broken printer
    // from the person responsible for it.
    assert.equal(parseOverviewMode(null), DEFAULT_OVERVIEW_MODE);
    assert.equal(DEFAULT_OVERVIEW_MODE, 'command_center');
  });

  it('accepts the JSON-quoted form as well as the bare one', () => {
    // Stored bare, but a previous build or a hand-edit could leave quotes, and
    // silently reverting to the default would look like the setting not saving.
    assert.equal(parseOverviewMode('"floor_queue"'), 'floor_queue');
  });

  it('tolerates surrounding whitespace', () => {
    assert.equal(parseOverviewMode('  floor_queue \n'), 'floor_queue');
  });

  it('falls back rather than rendering an unknown mode', () => {
    for (const value of ['', 'floor', 'FLOOR_QUEUE', '{}', 'null']) {
      assert.equal(parseOverviewMode(value), DEFAULT_OVERVIEW_MODE, value);
    }
  });
});

describe('effectiveOverviewMode', () => {
  it('forces a viewer to Floor & Queue whatever is stored', () => {
    // A viewer has no toggle, so a stored command_center — which they could not
    // have set, but a shared browser might carry — must not leak the admin
    // layout to them.
    assert.equal(effectiveOverviewMode('command_center', false), 'floor_queue');
    assert.equal(effectiveOverviewMode('floor_queue', false), 'floor_queue');
  });

  it('honours an admin’s stored choice', () => {
    assert.equal(effectiveOverviewMode('command_center', true), 'command_center');
    assert.equal(effectiveOverviewMode('floor_queue', true), 'floor_queue');
  });

  it('defaults an admin to Command Center via the stored default', () => {
    assert.equal(effectiveOverviewMode(DEFAULT_OVERVIEW_MODE, true), 'command_center');
  });
});

describe('the mode guard', () => {
  it('accepts exactly the modes the toggle can produce', () => {
    for (const mode of OVERVIEW_MODES) assert.equal(isOverviewMode(mode), true, mode);
    for (const value of ['', 'floor', null, undefined, 42, {}]) {
      assert.equal(isOverviewMode(value), false, String(value));
    }
  });
});
