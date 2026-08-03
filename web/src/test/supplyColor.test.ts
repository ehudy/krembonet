/**
 * Picking a visible fill for a supply bar.
 *
 * The bug: black ink reports `#000000`, and on the dark theme's `#18181B` card
 * that fill is invisible — a black cartridge at 8% looked exactly like one at
 * 80%. That is the single reading an operator most needs, rendered as nothing.
 *
 * The risk in fixing it is over-correcting. A threshold set too high starts
 * recolouring deep cyans and navies that were perfectly visible, throwing away
 * real information the device reported. Both directions are checked here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DARK_INK_FILL,
  fillColor,
  isTooDarkToRender,
  relativeLuminance,
} from '../lib/supplyColor.js';
import type { Supply } from '../types.js';

function supply(overrides: Partial<Supply> = {}): Supply {
  return {
    index: 0,
    name: 'K',
    label: 'Black',
    kind: 'consumable',
    type: 'toner',
    level: { kind: 'percent', percent: 50 },
    percent: 50,
    breached: false,
    colorHex: '#000000',
    partNumber: null,
    ...overrides,
  };
}

describe('luminance', () => {
  it('matches the WCAG reference points', () => {
    assert.equal(relativeLuminance('#000000'), 0);
    assert.equal(relativeLuminance('#ffffff'), 1);
  });

  it('expands sRGB gamma rather than averaging channels', () => {
    // A channel average calls blue and green equally bright. They are not, and
    // pure blue on a dark card is genuinely hard to see where green is not.
    const blue = relativeLuminance('#0000ff') as number;
    const green = relativeLuminance('#00ff00') as number;
    assert.ok(green > blue * 5, `green ${green} vs blue ${blue}`);
  });

  it('accepts shorthand and a missing hash', () => {
    assert.equal(relativeLuminance('#000'), relativeLuminance('#000000'));
    assert.equal(relativeLuminance('fff'), relativeLuminance('#ffffff'));
  });

  it('returns null for anything it cannot read', () => {
    for (const bad of ['', 'black', '#12345', 'rgb(0,0,0)', '#zzzzzz']) {
      assert.equal(relativeLuminance(bad), null, `parsed ${bad}`);
    }
  });
});

describe('the too-dark test', () => {
  it('catches the whole black family, whatever the vendor calls it', () => {
    // Real values seen from IPP and SNMP for black, matte black, photo black.
    for (const hex of ['#000000', '#000', '#0a0a0a', '#111111', '#1a1a1a', '#181818']) {
      assert.equal(isTooDarkToRender(hex), true, `missed ${hex}`);
    }
  });

  it('leaves colours that were already visible alone', () => {
    // Over-correcting throws away real information: these are dark, but they
    // read fine against a #18181B card.
    for (const hex of [
      '#00cfff',
      '#f200ff',
      '#ffda00',
      '#008080',
      '#006680',
      '#4b5563',
    ]) {
      assert.equal(isTooDarkToRender(hex), false, `needlessly recoloured ${hex}`);
    }
  });

  it('does not treat an unreadable colour as dark', () => {
    assert.equal(isTooDarkToRender('not-a-colour'), false);
  });
});

describe('fill selection', () => {
  it('substitutes a theme-aware variable for black, not a fixed hex', () => {
    // A hex here would be wrong on one of the two themes. The variable
    // resolves light on dark and near-black on light.
    assert.equal(fillColor(supply({ colorHex: '#000000' })), DARK_INK_FILL);
    assert.match(DARK_INK_FILL, /^var\(--/);
  });

  it('keeps the device colour when it is visible', () => {
    assert.equal(fillColor(supply({ colorHex: '#00cfff' })), '#00cfff');
  });

  it('falls back to the accent when the device reported no colour', () => {
    assert.equal(fillColor(supply({ colorHex: null })), 'var(--accent)');
    assert.equal(fillColor(supply({ colorHex: '' })), 'var(--accent)');
  });

  it('shows danger red for a breached supply, whatever its colour', () => {
    // Including black: "act on this" outranks "this is what is in the tank".
    assert.equal(
      fillColor(supply({ colorHex: '#000000', breached: true })),
      'var(--danger)',
    );
    assert.equal(
      fillColor(supply({ colorHex: '#00cfff', breached: true })),
      'var(--danger)',
    );
  });
});
