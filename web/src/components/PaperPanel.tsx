import { useTranslation, type Translate } from '../i18n/i18n.js';
import { resolveMediaLabel } from '../lib/mediaLabel.js';
import type { MediaSource } from '../types.js';

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
  const width = widthLabel(source, t);
  const label = resolveMediaLabel(source, t);

  if (!source.isLoaded) {
    return (
      <div className="paper-row">
        <div className="paper-icon is-empty" aria-hidden="true" />
        <div className="paper-details">
          <strong>{source.label}</strong>
          <span className="muted">{t('media.notLoaded')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="paper-row">
      <div className="paper-icon" aria-hidden="true" />
      <div className="paper-details">
        <strong>{source.label}</strong>
        {label.name !== null ? (
          <span>{label.name}</span>
        ) : label.isUnmapped ? (
          <span className="paper-unknown" title={t('media.unknownCode')}>
            <code>{label.code}</code>
          </span>
        ) : (
          <span className="muted">{t('media.loaded')}</span>
        )}
        {width !== null && <span className="paper-width">{width}</span>}
      </div>
    </div>
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
        media.map((source) => <MediaRow key={source.key} source={source} />)
      )}
    </section>
  );
}
