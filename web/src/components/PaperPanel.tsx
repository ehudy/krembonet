import type { Roll } from '../types.js';

function widthLabel(roll: Roll): string | null {
  if (roll.widthInches === null) return null;
  return `${roll.widthInches}in roll`;
}

/**
 * The printer reports vendor codes, not names. When a code is not in the
 * lookup table we show the code itself rather than inventing a description —
 * a wrong paper name is worse than an unfamiliar one, because someone will
 * plot on it.
 */
function RollRow({ roll }: { roll: Roll }) {
  const width = widthLabel(roll);

  if (!roll.isLoaded) {
    return (
      <div className="paper-row">
        <div className="paper-icon is-empty" aria-hidden="true" />
        <div className="paper-details">
          <strong>{roll.label}</strong>
          <span className="muted">No paper loaded</span>
        </div>
      </div>
    );
  }

  return (
    <div className="paper-row">
      <div className="paper-icon" aria-hidden="true" />
      <div className="paper-details">
        <strong>{roll.label}</strong>
        {roll.mediaTypeName !== null ? (
          <span>{roll.mediaTypeName}</span>
        ) : (
          <span className="paper-unknown" title="No friendly name for this media code yet">
            <code>{roll.mediaTypeCode}</code>
          </span>
        )}
        {width !== null && <span className="paper-width">{width}</span>}
      </div>
    </div>
  );
}

export function PaperPanel({ rolls }: { rolls: Roll[] }) {
  return (
    <section className="card">
      <h2 className="card-title">Loaded Paper</h2>
      {rolls.map((roll) => (
        <RollRow key={roll.source} roll={roll} />
      ))}
    </section>
  );
}
