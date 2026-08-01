import { useTranslation, type Translate } from '../i18n/i18n.js';
import type { MediaSource } from '../types.js';

function widthLabel(source: MediaSource, t: Translate): string | null {
  if (source.widthInches === null) return null;
  return source.type === 'roll'
    ? t('media.rollWidth', { inches: source.widthInches })
    : t('media.sheetWidth', { inches: source.widthInches });
}

/**
 * Devices report vendor codes, not names. When a code is not in the lookup
 * table we show the code itself rather than inventing a description — a wrong
 * paper name is worse than an unfamiliar one, because someone will plot on it.
 */
function MediaRow({ source }: { source: MediaSource }) {
  const { t } = useTranslation();
  const width = widthLabel(source, t);

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
        {source.mediaTypeName !== null ? (
          <span>{source.mediaTypeName}</span>
        ) : source.mediaTypeCode !== null ? (
          <span className="paper-unknown" title={t('media.unknownCode')}>
            <code>{source.mediaTypeCode}</code>
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
