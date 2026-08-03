/**
 * Supply levels.
 *
 * Whether a supply is "concerning" is decided by the server from the alert
 * rules, not recomputed here. This panel used to carry its own 15%/85%
 * constants, which meant a bar could turn red at a level that sent no mail.
 */
import { useTranslation, type Translate } from '../i18n/i18n.js';
import { fillColor } from '../lib/supplyColor.js';
import type { Supply, SupplyLevel } from '../types.js';

/**
 * What to show on the right of the bar, given a level that may have no number.
 *
 * "85%" and "85% full" are separate keys rather than a percentage with a
 * suffix appended: Spanish puts a space before the sign, and word order after
 * it is not something a concatenation can express.
 */
function levelText(supply: Supply, t: Translate): string {
  const full = supply.kind === 'receptacle';

  switch (supply.level.kind) {
    case 'percent':
      return t(full ? 'supplies.percentFull' : 'supplies.percent', {
        percent: supply.level.percent,
      });
    case 'absolute':
      return supply.percent === null
        ? t('supplies.absolute', { value: supply.level.value, max: supply.level.max })
        : t(full ? 'supplies.percentFull' : 'supplies.percent', {
            percent: supply.percent,
          });
    case 'binary':
      return supply.level.state === 'attention' ? t('supplies.low') : t('supplies.ok');
    case 'unknown':
      return t('supplies.notReported');
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
  const { t } = useTranslation();
  const width = fillWidth(supply.level, supply.percent);

  // The colour names the row; the part number, when the device gave one, is the
  // thing to type into a reorder form, so it rides along as a quiet suffix and
  // in the tooltip rather than crowding the label.
  const labelTitle =
    supply.partNumber === null ? supply.label : `${supply.label} · ${supply.partNumber}`;

  return (
    <div className="supply-row">
      <div className="supply-label" title={labelTitle}>
        {supply.label}
        {supply.partNumber !== null && (
          <span className="supply-part"> · {supply.partNumber}</span>
        )}
      </div>
      <div
        className="supply-track"
        // The bar is the visual form of a number the row already states, so it
        // carries the ARIA meter role rather than being decoration a screen
        // reader has to infer from a div.
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(supply.percent !== null ? { 'aria-valuenow': supply.percent } : {})}
        aria-valuetext={levelText(supply, t)}
        aria-label={supply.label}
      >
        {width === null ? (
          <div className="supply-fill is-unknown" title={t('supplies.unknownTitle')} />
        ) : (
          <div
            className="supply-fill"
            style={{ width, backgroundColor: fillColor(supply) }}
          />
        )}
      </div>
      <div
        className={`supply-value${supply.breached ? ' is-concerning' : ''}${
          supply.percent === null && supply.level.kind !== 'binary' ? ' is-muted' : ''
        }`}
      >
        {levelText(supply, t)}
      </div>
    </div>
  );
}

export function InkPanel({ supplies }: { supplies: Supply[] }) {
  const { t } = useTranslation();
  const consumables = supplies.filter((supply) => supply.kind === 'consumable');
  const receptacles = supplies.filter((supply) => supply.kind === 'receptacle');

  return (
    <section className="card">
      <h2 className="card-title">{t('supplies.title')}</h2>

      {consumables.length === 0 && <p className="muted">{t('supplies.empty')}</p>}
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
