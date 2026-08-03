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
