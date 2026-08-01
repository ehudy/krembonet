/**
 * Deciding when a device needs a human.
 *
 * The bug this replaces: a printer that was reachable and full of ink but had
 * an empty tray showed as "Healthy". Reachability and supply level were the
 * only two things measured, and neither is what stops a job.
 *
 * Both adapter vocabularies are exercised against every condition, because the
 * whole point of this module is that `media-empty` from IPP and `no paper` from
 * SNMP are the same fact. A mapping that covers one and not the other produces
 * a dashboard that is right about half the estate.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessAttention, classifyStateReason } from '../src/devices/attention.js';

describe('paper out', () => {
  it('is an error in both vocabularies', () => {
    for (const reason of [
      'media-empty',
      'no paper',
      'media-needed',
      'input tray empty',
    ]) {
      const condition = classifyStateReason(reason);
      assert.notEqual(condition, null, `unrecognised: ${reason}`);
      assert.equal(condition?.level, 'error', `${reason} was not an error`);
    }
  });

  it('flags the device rather than leaving it healthy', () => {
    // The exact scenario: online, inked, and unable to print.
    const attention = assessAttention('idle', ['media-empty']);

    assert.equal(attention.level, 'error');
    assert.equal(attention.summary, 'Paper out');
  });
});

describe('media stalled', () => {
  it('treats a jam as an error from either adapter', () => {
    assert.equal(classifyStateReason('media-jam')?.level, 'error');
    assert.equal(classifyStateReason('jammed')?.level, 'error');
    assert.equal(assessAttention('idle', ['media-jam']).summary, 'Paper jam');
  });

  it('treats a missing or full output tray as an error', () => {
    for (const reason of ['input tray missing', 'output-area-full', 'output full']) {
      assert.equal(classifyStateReason(reason)?.level, 'error', reason);
    }
  });
});

describe('running low', () => {
  it('is a warning, not an error — the device still prints', () => {
    for (const reason of ['media-low', 'low paper', 'output near full']) {
      assert.equal(classifyStateReason(reason)?.level, 'warning', reason);
    }
    assert.equal(assessAttention('idle', ['media-low']).level, 'warning');
  });
});

describe('severity suffixes', () => {
  it('are stripped so the base condition still matches', () => {
    // RFC 8011 allows any reason to carry -report/-warning/-error.
    assert.equal(classifyStateReason('media-empty-error')?.label, 'Paper out');
    assert.equal(classifyStateReason('media-jam-error')?.label, 'Paper jam');
  });

  it('let the device downgrade its own severity', () => {
    // A multi-tray printer with another tray loaded genuinely means "warning",
    // and overriding it to error would cry wolf on a device that still prints.
    assert.equal(classifyStateReason('media-empty-warning')?.level, 'warning');
    assert.equal(classifyStateReason('media-empty-report')?.level, 'warning');
  });

  it('do not let a device upgrade a warning past what it means', () => {
    assert.equal(classifyStateReason('media-low-error')?.level, 'warning');
  });
});

describe('unrecognised reasons', () => {
  it('are ignored rather than treated as faults', () => {
    // Vendors put arbitrary text in this field. A red badge for something the
    // hub does not understand is a badge operators learn to ignore.
    for (const reason of ['moving-to-paused', 'opc-life-over', '', 'wibble']) {
      assert.equal(classifyStateReason(reason), null, `claimed to know: ${reason}`);
    }
    assert.equal(assessAttention('idle', ['moving-to-paused']).level, 'ok');
  });

  it('do not mask a recognised one alongside them', () => {
    const attention = assessAttention('idle', ['wibble', 'media-empty', 'wobble']);
    assert.equal(attention.level, 'error');
    assert.equal(attention.summary, 'Paper out');
  });
});

describe('several conditions at once', () => {
  it('reports the error ahead of the warning', () => {
    const attention = assessAttention('idle', ['media-low', 'media-jam']);

    assert.equal(attention.level, 'error');
    assert.match(attention.summary as string, /^Paper jam/);
  });

  it('counts the rest rather than listing them in the pill', () => {
    const attention = assessAttention('stopped', ['media-jam', 'door open']);

    assert.equal(attention.summary, 'Paper jam +1');
    assert.equal(attention.conditions.length, 2);
  });

  it('collapses two names for one fault', () => {
    // SNMP sets both bits for a single empty tray; "Paper out, Tray empty"
    // reads as two separate problems.
    const attention = assessAttention('stopped', ['no paper', 'media-empty']);

    assert.equal(attention.conditions.length, 1);
    assert.equal(attention.summary, 'Paper out');
  });
});

describe('a stopped device with nothing this understands', () => {
  it('still reports an error rather than claiming health', () => {
    assert.deepEqual(assessAttention('stopped', []), {
      level: 'error',
      conditions: [],
      summary: 'Stopped',
    });
    assert.equal(assessAttention('stopped', ['vendor-nonsense']).level, 'error');
  });
});

describe('a healthy device', () => {
  it('reports nothing at all', () => {
    assert.deepEqual(assessAttention('idle', []), {
      level: 'ok',
      conditions: [],
      summary: null,
    });
    // `none` is what IPP sends when everything is fine; the normalizers already
    // filter it, but it must not classify as a fault if one slips through.
    assert.equal(assessAttention('processing', ['none']).level, 'ok');
  });
});
