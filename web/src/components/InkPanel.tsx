import type { Supply } from '../types.js';

/** Below this an ink tank is worth flagging to whoever is looking. */
const LOW_INK_PERCENT = 15;
/** Above this the maintenance tank is close to needing replacement. */
const HIGH_WASTE_PERCENT = 85;

function isConcerning(supply: Supply): boolean {
  return supply.kind === 'waste'
    ? supply.percent >= HIGH_WASTE_PERCENT
    : supply.percent <= LOW_INK_PERCENT;
}

function SupplyRow({ supply }: { supply: Supply }) {
  const concerning = isConcerning(supply);

  return (
    <div className="supply-row">
      <div className="supply-label" title={supply.label}>
        {supply.label}
      </div>
      <div className="supply-track">
        <div
          className="supply-fill"
          style={{ width: `${supply.percent}%`, backgroundColor: supply.colorHex }}
        />
      </div>
      <div className={`supply-value${concerning ? ' is-concerning' : ''}`}>
        {supply.percent}%
      </div>
    </div>
  );
}

export function InkPanel({ supplies }: { supplies: Supply[] }) {
  const inks = supplies.filter((supply) => supply.kind === 'ink');
  const receptacles = supplies.filter((supply) => supply.kind === 'waste');

  return (
    <section className="card">
      <h2 className="card-title">Ink Levels</h2>

      {inks.length === 0 && <p className="muted">No ink data reported.</p>}
      {inks.map((supply) => (
        <SupplyRow key={supply.index} supply={supply} />
      ))}

      {receptacles.length > 0 && (
        <div className="waste-section">
          {receptacles.map((supply) => (
            <div key={supply.index} className="waste-row">
              <div className="supply-label" title={supply.label}>
                {supply.label}
              </div>
              <div className="supply-track">
                <div
                  className="supply-fill"
                  style={{
                    width: `${supply.percent}%`,
                    backgroundColor: supply.colorHex,
                  }}
                />
              </div>
              {/* Deliberately "full", not "remaining" — this tank fills up as
                  the others drain, and the printer reports it that way. */}
              <div
                className={`supply-value${isConcerning(supply) ? ' is-concerning' : ''}`}
              >
                {supply.percent}% full
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
