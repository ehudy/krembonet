/**
 * Choosing a visible fill for a supply bar.
 *
 * Devices report the real colour of what is in the cartridge, which is the
 * right thing to draw — a magenta tank drawn magenta is information. It breaks
 * for exactly one family of supplies: black, matte black, and photo black all
 * report something at or near `#000000`, and on the dark theme's `#18181B`
 * card that fill is invisible. A black cartridge at 8% and one at 80% looked
 * identical, which is the reading an operator most needs to see.
 *
 * The substitute is a CSS variable rather than a hex value, because the right
 * answer depends on the theme and this module has no idea which is active:
 * light zinc on dark, near-black on light. The variable resolves per theme in
 * global.css.
 *
 * Decided by luminance rather than by matching supply names. Vendors label the
 * same cartridge "Black", "Matte Black", "MBK", "PGBK", "Noir", and a name list
 * would need extending forever; a colour too dark to see is too dark to see
 * whatever it is called.
 */
import type { Supply } from '../types.js';

/** Resolves to a light zinc on the dark theme and a near-black on the light one. */
export const DARK_INK_FILL = 'var(--supply-dark-ink)';

/**
 * Relative luminance, per WCAG 2.x.
 *
 * The sRGB gamma expansion matters: a naive channel average calls `#0000FF`
 * mid-bright and `#00FF00` the same, so pure blue — genuinely hard to see on a
 * dark card — would pass while green got swapped for no reason.
 */
export function relativeLuminance(hex: string): number | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) return null;

  let digits = match[1] as string;
  if (digits.length === 3) {
    digits = digits
      .split('')
      .map((character) => character + character)
      .join('');
  }

  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return (
    0.2126 * (channels[0] as number) +
    0.7152 * (channels[1] as number) +
    0.0722 * (channels[2] as number)
  );
}

/**
 * Below this, a fill is indistinguishable from the dark card behind it.
 *
 * 0.06 sits above `#000000` (0) and `#1a1a1a` (~0.01) and below the darkest
 * colour worth keeping — a deep cyan like `#006680` lands around 0.11. Tuned to
 * catch the black family without recolouring anything that was already visible.
 */
export const TOO_DARK = 0.06;

export function isTooDarkToRender(hex: string): boolean {
  const luminance = relativeLuminance(hex);
  // An unparseable colour is not evidence of darkness; the caller falls back to
  // the accent for those.
  return luminance !== null && luminance < TOO_DARK;
}

/**
 * The colour a bar is filled with.
 *
 * A breached supply is danger red regardless of what the device says: at that
 * moment the point of the bar is "act on this", and a cyan tank drawn cyan
 * while it is empty buries the row that matters.
 */
export function fillColor(supply: Supply): string {
  if (supply.breached) return 'var(--danger)';

  const reported = supply.colorHex;
  if (reported === null || reported === '') return 'var(--accent)';
  if (isTooDarkToRender(reported)) return DARK_INK_FILL;

  return reported;
}
