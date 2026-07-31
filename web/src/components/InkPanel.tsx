/**
 * Supply levels.
 *
 * Whether a supply is "concerning" is decided by the server from the alert
 * rules, not recomputed here. This panel used to carry its own 15%/85%
 * constants, which meant a bar could turn red at a level that sent no mail.
 */
import type { Supply, SupplyLevel } from '../types.js';

/** Used when a device reports no colour of its own. */
const FALLBACK_COLOR = '#3b82f6';

/** What to show on the right of the bar, given a level that may have no number. */
function levelText(supply: Supply): string {
  const suffix = supply.kind === 'receptacle' ? ' full' : '';

  switch (supply.level.kind) {
    case 'percent':
      return `${supply.level.percent}%${suffix}`;
    case 'absolute':
      return supply.percent === null
        ? `${supply.level.value} of ${supply.level.max}`
        : `${supply.percent}%${suffix}`;
    case 'binary':
      return supply.level.state === 'attention' ? 'Low' : 'OK';
    case 'unknown':
      return 'Not reported';
  }
}

/**
 * Bar width. A level with no number gets no bar rather than a zero-width one,
 * which would read as "empty".
 */
function fillWidth(level: SupplyLevel, percent: number | null): string | null {
  if (percent !== null) return `${percent}%`;
  // A device that only says "ok" or "attention" still supports a coarse bar.
  if (level.kind === 'binary') return level.state === 'attention' ? '10%' : '100%';
  return null;
}

function SupplyRow({ supply }: { supply: Supply }) {
  const width = fillWidth(supply.level, supply.percent);

  return (
    <div className="supply-row">
      <div className="supply-label" title={supply.label}>
        {supply.label}
      </div>
      <div className="supply-track">
        {width === null ? (
          <div className="supply-fill is-unknown" title="This device did not report a level" />
        ) : (
          <div
            className="supply-fill"
            style={{ width, backgroundColor: supply.colorHex ?? FALLBACK_COLOR }}
          />
        )}
      </div>
      <div
        className={`supply-value${supply.breached ? ' is-concerning' : ''}${
          supply.percent === null && supply.level.kind !== 'binary' ? ' is-muted' : ''
        }`}
      >
        {levelText(supply)}
      </div>
    </div>
  );
}

export function InkPanel({ supplies }: { supplies: Supply[] }) {
  const consumables = supplies.filter((supply) => supply.kind === 'consumable');
  const receptacles = supplies.filter((supply) => supply.kind === 'receptacle');

  return (
    <section className="card">
      <h2 className="card-title">Supply Levels</h2>

      {consumables.length === 0 && <p className="muted">No supply data reported.</p>}
      {consumables.map((supply) => (
        <SupplyRow key={supply.index} supply={supply} />
      ))}

      {receptacles.length > 0 && (
        <div className="waste-section">
          {/* Separated because these fill up as the others drain, and the
              device reports them that way. */}
          {receptacles.map((supply) => (
            <SupplyRow key={supply.index} supply={supply} />
          ))}
        </div>
      )}
    </section>
  );
}
