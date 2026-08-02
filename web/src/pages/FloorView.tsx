/**
 * The Overview as someone standing at a printer needs it.
 *
 * Everything on this page answers one of three questions: is the machine free,
 * what paper is in it, and will it run out mid-job. The error list, the
 * critical-supplies buying view and the event log are all deliberately absent —
 * not because an operator should not know a printer is broken, but because
 * "broken" reaches them here as *"you cannot print on this one"*, which is the
 * form they can act on. The incident view is a mode away.
 *
 * Data comes from two places, for a reason worth stating. The fleet list reads
 * the cached device and media endpoints, which cost the printers nothing. The
 * pinned cards additionally pull each device's own status with a jobs refresh,
 * because a queue is the one reading that is worthless when stale — a card
 * claiming "Ready" from a poll two hours ago sends someone to a busy machine.
 * That is bounded by the fact that pins are chosen by hand, and capped besides.
 */
import { useCallback } from 'react';
import { Layers, Printer, Star } from 'lucide-react';

import { api } from '../api.js';
import { usePinnedDevices } from '../hooks/usePinnedDevices.js';
import { usePolled } from '../hooks/usePolled.js';
import { useTranslation, type Translate } from '../i18n/i18n.js';
import { relativeTime } from '../lib/format.js';
import { queueStatus, type QueueStatus } from '../lib/queueStatus.js';
import { fillColor } from '../lib/supplyColor.js';
import { Link } from '../router.js';
import type { DeviceSummary, MediaSource, MediaCatalogResponse } from '../types.js';

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
      // The friendly name when there is one, the raw code when there is not.
      // Never a guess: someone will plot a job on whatever this says.
      const name = source.mediaTypeName ?? source.mediaTypeCode;
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
        <h3>{slug}</h3>
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
        <Star className="floor-pin" size={14} strokeWidth={2} fill="currentColor" aria-hidden="true" />
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
              <small className={supply.breached ? 'is-concerning' : 'muted'}>
                {supply.label}
              </small>
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

/** The queue-focused fleet table, built from the two cached endpoints. */
function FleetList({
  devices,
  media,
}: {
  devices: readonly DeviceSummary[];
  media: MediaCatalogResponse | null;
}) {
  const { t } = useTranslation();

  const paperBySlug = new Map(
    (media?.devices ?? []).map((device) => [device.slug, device.media]),
  );

  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t('floor.device')}</th>
            <th scope="col">{t('floor.state')}</th>
            <th scope="col">{t('floor.queue')}</th>
            <th scope="col">{t('floor.paper')}</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => {
            const status = queueStatus({
              isOnline: device.isOnline,
              state: device.state,
              attention: device.attention,
              attentionReason: device.attentionReasons[0] ?? null,
              totalJobs: device.activeJobs,
              // The list only has a total, so `queueStatus` infers how many are
              // waiting. Stated as null rather than guessed here, so the
              // inference lives in one place.
              waitingJobs: null,
            });

            const paper = paperSummary(paperBySlug.get(device.slug) ?? [], t);

            return (
              <tr key={device.slug}>
                <td>
                  <Link to={`/devices/${device.slug}`} className="device-link">
                    <Printer size={15} strokeWidth={1.75} aria-hidden="true" />
                    <span>
                      <strong>{device.displayName}</strong>
                      {device.location !== null && (
                        <small className="muted">{device.location}</small>
                      )}
                    </span>
                  </Link>
                </td>
                <td>
                  <span className={`queue-pill is-${status.tone}`}>
                    {statusText(status, t)}
                  </span>
                </td>
                <td className="muted queue-depth">{device.activeJobs}</td>
                <td className="muted">
                  {paper ?? <span className="muted">{t('floor.noPaper')}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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

  const loadMedia = useCallback((signal: AbortSignal) => api.listMedia(signal), []);
  const { data: media } = usePolled(loadMedia);

  // Only pins that still resolve to a device get a card; a pin left behind by a
  // deleted printer would otherwise render a tile that never loads.
  const known = new Set(devices.map((device) => device.slug));
  const cards = pinned.filter((slug) => known.has(slug)).slice(0, FLOOR_CARD_LIMIT);
  const hiddenPins = pinned.filter((slug) => known.has(slug)).length - cards.length;

  return (
    <>
      {cards.length > 0 && (
        <>
          <h2 className="section-title">{t('floor.yourDevices')}</h2>
          <div className="floor-grid">
            {cards.map((slug) => (
              <PinnedCard key={slug} slug={slug} />
            ))}
          </div>
          {hiddenPins > 0 && (
            <p className="muted list-footnote">
              {t('floor.morePinned', { count: hiddenPins })}
            </p>
          )}
        </>
      )}

      {/* The hint is shown only when nothing is pinned, and only once the fleet
          has loaded — otherwise it flashes up on every page load before the
          cards appear. */}
      {cards.length === 0 && !isLoading && devices.length > 0 && (
        <div className="empty-state">
          <p>{t('floor.nothingPinned')}</p>
          <Link to="/devices" className="btn-primary">
            {t('floor.pinFromDevices')}
          </Link>
        </div>
      )}

      <h2 className="section-title">{t('floor.allDevices')}</h2>

      {isLoading ? (
        <p className="muted">{t('overview.loadingDevices')}</p>
      ) : (
        <FleetList devices={devices} media={media} />
      )}
    </>
  );
}
