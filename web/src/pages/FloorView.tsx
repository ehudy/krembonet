/**
 * The Overview as someone standing at a printer needs it.
 *
 * Strictly the printers this person pinned — their daily machines — as a grid
 * of cards, each answering one of three questions: is it free, what paper is in
 * it, and will it run out mid-job. The error list, the critical-supplies buying
 * view and the event log are all deliberately absent; "broken" reaches an
 * operator here as *"you cannot print on this one"*, which is the form they can
 * act on. The incident view is a mode away.
 *
 * There is deliberately no whole-fleet table beneath the cards. This view is a
 * curated board, not a directory — the searchable list of every printer is what
 * /devices is for. A card pulls its own status with a jobs refresh, because a
 * queue is the one reading that is worthless when stale: a card claiming "Ready"
 * from a poll two hours ago sends someone to a busy machine. That cost is
 * bounded by pins being chosen by hand, and capped besides.
 */
import { useCallback } from 'react';
import { Layers, Star } from 'lucide-react';

import { api } from '../api.js';
import { PinButton } from '../components/PinButton.js';
import { usePinnedDevices } from '../hooks/usePinnedDevices.js';
import { usePolled } from '../hooks/usePolled.js';
import { useTranslation, type Translate } from '../i18n/i18n.js';
import { relativeTime } from '../lib/format.js';
import { resolveMediaLabel } from '../lib/mediaLabel.js';
import { queueStatus, type QueueStatus } from '../lib/queueStatus.js';
import { fillColor } from '../lib/supplyColor.js';
import { Link } from '../router.js';
import type { DeviceSummary, MediaSource } from '../types.js';

/**
 * How often a pinned card re-reads its queue.
 *
 * Matches the device detail page rather than the 30s the cached fleet
 * endpoints use: this one reaches the printer, and the server's own jobs TTL
 * plus its single-flighting mean several open dashboards still collapse into
 * one query per window.
 */
const QUEUE_REFRESH_MS = 60_000;

/**
 * How many pinned devices get a live card.
 *
 * Pins are chosen by hand and rarely number more than a few, but nothing stops
 * someone starring the entire fleet, and each card is a request. Beyond this
 * they are still reachable in the list below, which costs nothing extra.
 */
const FLOOR_CARD_LIMIT = 8;

/** Renders a queue phrase, which may or may not carry a count. */
function statusText(status: QueueStatus, t: Translate): string {
  return status.values === undefined ? t(status.key) : t(status.key, status.values);
}

/** What is loaded, in as few words as fit on one line. */
function paperSummary(media: readonly MediaSource[], t: Translate): string | null {
  const loaded = media.filter((source) => source.isLoaded);
  if (loaded.length === 0) return null;

  return loaded
    .map((source) => {
      // Resolved through all four tiers; the raw code only when nothing names
      // it. Never a guess — someone will plot a job on whatever this says.
      const label = resolveMediaLabel(source, t);
      const name = label.name ?? label.code;
      const width =
        source.widthInches === null
          ? null
          : t('media.sheetWidth', { inches: source.widthInches });

      if (name === null) return width ?? source.label;
      return width === null ? name : `${name} · ${width}`;
    })
    .join(' / ');
}

/**
 * A pinned printer, in full.
 *
 * Fetches its own status so each card refreshes independently; a slow or
 * unreachable device delays only its own tile rather than the whole page.
 */
function PinnedCard({ slug }: { slug: string }) {
  const { t } = useTranslation();

  const load = useCallback(
    (signal: AbortSignal) => api.deviceStatus(slug, { refresh: 'jobs', signal }),
    [slug],
  );
  const { data, error, isLoading } = usePolled(load, QUEUE_REFRESH_MS);

  if (isLoading) {
    return (
      <section className="floor-card is-loading">
        <p className="muted">{t('common.loading')}</p>
      </section>
    );
  }

  if (data === null) {
    return (
      <section className="floor-card is-blocked">
        <header className="floor-card-head">
          <h3>{slug}</h3>
          {/* Still unpinnable even when the device will not answer — a printer
              that has gone dark is exactly one someone wants off their board.
              The slug stands in for the name the card never got to load. */}
          <PinButton slug={slug} name={slug} />
        </header>
        <p className="muted">{error ?? t('device.unreachablePill')}</p>
      </section>
    );
  }

  const status = queueStatus({
    isOnline: data.isOnline,
    state: data.state,
    attention: data.attention,
    attentionReason: data.attentionReasons[0] ?? null,
    totalJobs: data.jobs.length,
    // The card knows which job is actually printing, so it can say how many
    // someone would be waiting behind rather than guessing from the total.
    waitingJobs: data.jobs.filter((job) => job.state !== 'processing').length,
  });

  const paper = paperSummary(data.media, t);
  const consumables = data.supplies.filter((supply) => supply.kind === 'consumable');

  return (
    <section className={`floor-card is-${status.tone}`}>
      <header className="floor-card-head">
        <h3>
          <Link to={`/devices/${slug}`}>{data.displayName}</Link>
        </h3>
        {/* Clicking it unpins, which removes the card from the grid — the star
            is filled here because everything on this grid is, by definition,
            pinned. */}
        <PinButton slug={slug} name={data.displayName} />
      </header>

      {data.location !== null && <p className="floor-location muted">{data.location}</p>}

      {/* The headline. Deliberately the largest thing on the card — it is the
          only line most people will read. */}
      <p className={`floor-status is-${status.tone}`}>{statusText(status, t)}</p>

      <dl className="floor-facts">
        <div>
          <dt>
            <Layers size={13} strokeWidth={2} aria-hidden="true" />
            {t('floor.paper')}
          </dt>
          <dd>{paper ?? <span className="muted">{t('floor.noPaper')}</span>}</dd>
        </div>
      </dl>

      {consumables.length > 0 && (
        <div className="floor-gauges">
          {consumables.map((supply) => (
            <div key={supply.index} className="floor-gauge" title={supply.label}>
              {/* Label, bar, number — the same order and the same fixed tracks
                  as the device page, so a gauge means the same thing wherever
                  it is read. The name leads because it is what someone is
                  looking for; the bar is what they act on. */}
              <small className={supply.breached ? 'is-concerning' : 'muted'}>
                {supply.label}
              </small>
              <span
                className="supply-track"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={100}
                {...(supply.percent !== null ? { 'aria-valuenow': supply.percent } : {})}
                aria-label={supply.label}
              >
                {supply.percent === null ? (
                  <span className="supply-fill is-unknown" />
                ) : (
                  <span
                    className="supply-fill"
                    style={{
                      width: `${supply.percent}%`,
                      backgroundColor: fillColor(supply),
                    }}
                  />
                )}
              </span>
              {/* A dash, not a zero, when the device declined to give a number
                  — the bar beside it is already hatched to say so, and "0%"
                  would send someone to change a cartridge that is probably
                  full. */}
              <span
                className={`floor-gauge-value${supply.breached ? ' is-concerning' : ''}`}
              >
                {supply.percent === null
                  ? t('common.none')
                  : t('supplies.percent', { percent: supply.percent })}
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="floor-updated muted">
        {t('floor.queueRead', { time: relativeTime(data.servedAt, t) })}
      </p>
    </section>
  );
}

export function FloorView({
  devices,
  isLoading,
}: {
  devices: readonly DeviceSummary[];
  isLoading: boolean;
}) {
  const { t } = useTranslation();
  const { pinned } = usePinnedDevices();

  // Only pins that still resolve to a device get a card; a pin left behind by a
  // deleted printer would otherwise render a tile that never loads.
  const known = new Set(devices.map((device) => device.slug));
  const resolved = pinned.filter((slug) => known.has(slug));
  const cards = resolved.slice(0, FLOOR_CARD_LIMIT);
  const hiddenPins = resolved.length - cards.length;

  // Held back until the fleet has loaded: before then `known` is empty, so no
  // pin resolves and the empty state would flash up over the cards about to
  // appear.
  if (!isLoading && cards.length === 0) {
    return (
      <div className="empty-state floor-empty">
        <Star size={22} strokeWidth={1.75} aria-hidden="true" />
        <p>{t('floor.nothingPinned')}</p>
        <Link to="/devices" className="btn-primary">
          {t('floor.pinFromDevices')}
        </Link>
      </div>
    );
  }

  return (
    <>
      <h2 className="section-title">{t('floor.yourDevices')}</h2>

      {isLoading && cards.length === 0 ? (
        <p className="muted">{t('overview.loadingDevices')}</p>
      ) : (
        <div className="floor-grid">
          {cards.map((slug) => (
            <PinnedCard key={slug} slug={slug} />
          ))}
        </div>
      )}

      {hiddenPins > 0 && (
        <p className="muted list-footnote">
          {t('floor.morePinned', { count: hiddenPins })}
        </p>
      )}
    </>
  );
}
