import type { MediaSource } from '../types.js';

function widthLabel(source: MediaSource): string | null {
  if (source.widthInches === null) return null;
  return source.type === 'roll' ? `${source.widthInches}in roll` : `${source.widthInches}in`;
}

/**
 * Devices report vendor codes, not names. When a code is not in the lookup
 * table we show the code itself rather than inventing a description — a wrong
 * paper name is worse than an unfamiliar one, because someone will plot on it.
 */
function MediaRow({ source }: { source: MediaSource }) {
  const width = widthLabel(source);

  if (!source.isLoaded) {
    return (
      <div className="paper-row">
        <div className="paper-icon is-empty" aria-hidden="true" />
        <div className="paper-details">
          <strong>{source.label}</strong>
          <span className="muted">No media loaded</span>
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
          <span className="paper-unknown" title="No friendly name for this media code yet">
            <code>{source.mediaTypeCode}</code>
          </span>
        ) : (
          <span className="muted">Loaded</span>
        )}
        {width !== null && <span className="paper-width">{width}</span>}
      </div>
    </div>
  );
}

export function PaperPanel({ media }: { media: MediaSource[] }) {
  return (
    <section className="card">
      <h2 className="card-title">Loaded Media</h2>
      {media.length === 0 ? (
        <p className="muted">This device did not report any media sources.</p>
      ) : (
        media.map((source) => <MediaRow key={source.key} source={source} />)
      )}
    </section>
  );
}
