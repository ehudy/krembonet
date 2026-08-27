/**
 * What is loaded in one printer, slot by slot.
 *
 * The same row shape as the Media Catalog's By-device tab, from the same
 * component — these two lists show identical information about identical things
 * and had drifted into looking like different features. The tray leads, because
 * the panel is already one printer; what is in it is the detail line.
 */
import { Layers } from 'lucide-react';

import { useTranslation, type Translate } from '../i18n/i18n.js';
import { resolveMediaLabel } from '../lib/mediaLabel.js';
import type { MediaSource } from '../types.js';
import { MediaItem, subtitleOf } from './MediaItem.js';

function widthLabel(source: MediaSource, t: Translate): string | null {
  if (source.widthInches === null) return null;
  return source.type === 'roll'
    ? t('media.rollWidth', { inches: source.widthInches })
    : t('media.sheetWidth', { inches: source.widthInches });
}

const MM_PER_FOOT = 304.8;

/**
 * How much of the roll is left.
 *
 * Prefers a real length when an adapter has one, and falls back to the spool
 * percentage that SNMP rolls do report. The two are deliberately rendered in
 * different units: a percentage of an unknown-length spool is not a length, and
 * rounding it into feet would invent stock that may not be on the roll.
 *
 * Whole feet, never decimals. The figure is derived from spool rotation, and a
 * decimal place would claim a precision the device does not have.
 *
 * Feet rather than metres to match `widthLabel`, which is imperial regardless
 * of locale — a row reading "24in roll · 25 m left" mixes the two systems in
 * one line and reads as a bug.
 */
function remainingLabel(source: MediaSource, t: Translate): string | null {
  // IPP is not a source for this: the Canon reports a 0mm roll length and a
  // level of -2 ("unknown"), so only a percentage or a vendor-aware adapter
  // ever fills either branch. See docs/canon-tz32000-field-notes.md.
  if (source.lengthRemainingMm !== null && source.lengthRemainingMm > 0) {
    return t('media.rollRemaining', {
      feet: Math.round(source.lengthRemainingMm / MM_PER_FOOT),
    });
  }

  if (source.level.kind === 'percent') {
    return t('media.rollRemainingPercent', { percent: source.level.percent });
  }

  return null;
}

/**
 * Devices report vendor codes, not names. A code resolves through the four
 * tiers (device override, global, standard dictionary, raw); only a code no
 * tier knows shows as the raw code, because a wrong paper name is worse than an
 * unfamiliar one — someone will plot on it.
 */
function MediaRow({ source }: { source: MediaSource }) {
  const { t } = useTranslation();

  if (!source.isLoaded) {
    return (
      <MediaItem
        icon={Layers}
        title={source.label}
        subtitle={t('media.notLoaded')}
        isDim
      />
    );
  }

  const label = resolveMediaLabel(source, t);

  return (
    <MediaItem
      icon={Layers}
      title={source.label}
      subtitle={subtitleOf([
        label.name ?? label.code ?? t('media.loaded'),
        widthLabel(source, t),
        remainingLabel(source, t),
      ])}
      hint={label.isUnmapped ? t('media.unknownCode') : undefined}
    />
  );
}

export function PaperPanel({ media }: { media: MediaSource[] }) {
  const { t } = useTranslation();

  return (
    <section className="card">
      <h2 className="card-title">{t('media.title')}</h2>
      {media.length === 0 ? (
        <p className="muted">{t('media.empty')}</p>
      ) : (
        <ul className="media-list">
          {media.map((source) => (
            <MediaRow key={source.key} source={source} />
          ))}
        </ul>
      )}
    </section>
  );
}
