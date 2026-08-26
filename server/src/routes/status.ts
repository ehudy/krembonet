/**
 * Device status endpoints.
 *
 * Handlers never query a device directly. They ask the poller to refresh
 * anything past its TTL, which is coalesced, then serve the cache. Ten
 * dashboards open at once still amount to one query per TTL window.
 *
 * The one exception is `POST /api/devices/:slug/refresh`, which is a person
 * asking rather than a page loading, and skips the TTL on purpose. It is still
 * a read of the device — nothing here changes anything on a printer — but it
 * is a POST because it does put traffic on the wire, and that should not be
 * something a link preview or a browser prefetch can trigger.
 */
import type { FastifyInstance } from 'fastify';

import {
  isActivityEventType,
  listActivity,
  type ActivityEventType,
} from '../activity/store.js';
import { listAlertRules } from '../alerts/store.js';
import { evaluateSupplies } from '../alerts/rules.js';
import { requireViewer } from '../auth/session.js';
import { assessAttention } from '../devices/attention.js';
import { levelToPercent } from '../devices/types.js';
import {
  ageMs,
  getDeviceView,
  listDeviceViews,
  type DeviceView,
} from '../poller/cache.js';
import {
  ensureFresh,
  findDeviceBySlug,
  forceRefresh,
  type DeviceRow,
  listEnabledDevices,
} from '../poller/pollDevice.js';
import { JOBS_TTL_MS, SUPPLIES_TTL_MS } from '../poller/refresh-policy.js';
import { getSettings } from '../settings/settings.js';

/**
 * Supplies with the two derived fields the browser must never compute itself.
 *
 * `percent` collapses the level union to one comparable number, and `breached`
 * comes from the same rules the alert engine uses. The ink panel used to
 * hardcode its own 15%/85% constants, which meant a bar could turn red at a
 * level that sent no mail, or stay calm at one that did.
 */
function decorateSupplies(view: DeviceView, deviceId: number) {
  const breached = new Set(
    evaluateSupplies(view.slug, deviceId, view.supplies, listAlertRules())
      .filter((condition) => condition.breached)
      .map((condition) => condition.supply.name),
  );

  return view.supplies.map((supply) => ({
    ...supply,
    percent: levelToPercent(supply.level),
    breached: breached.has(supply.name),
  }));
}

function decorate(view: DeviceView, deviceId: number) {
  return {
    ...view,
    supplies: decorateSupplies(view, deviceId),
    suppliesAgeSeconds: Math.round(ageMs(view.suppliesUpdatedAt) / 1000),
    jobsAgeSeconds: Math.round(ageMs(view.jobsUpdatedAt) / 1000),
    servedAt: new Date().toISOString(),
    // The detail view gets every condition, not just the headline: an operator
    // walking to the device wants to know it is both jammed and out of paper.
    ...(() => {
      const attention = assessAttention(view.state, view.stateReasons);
      return {
        attention: attention.level,
        attentionSummary: attention.summary,
        attentionReasons: attention.conditions.map((condition) => condition.label),
      };
    })(),
  };
}

/**
 * The device-detail payload.
 *
 * Shared by the status route and the forced refresh so the two can never drift:
 * the browser stores whichever it last received, and a refresh that returned a
 * differently-shaped object would leave the page half-updated.
 */
function statusPayload(view: DeviceView, device: DeviceRow) {
  return {
    ...decorate(view, device.id),
    ttl: { suppliesSeconds: SUPPLIES_TTL_MS / 1000, jobsSeconds: JOBS_TTL_MS / 1000 },
  };
}

/**
 * How many supplies are past their alert threshold, split by which way the
 * supply runs.
 *
 * These are two different sentences to an operator: a low consumable is
 * "reorder toner", a full receptacle is "empty the waste box on the way past".
 * Counting them together produced "1 supply low" on a printer whose only issue
 * was a full waste tank — wrong on both the number and the noun. Uses the same
 * rules the alert engine does, so the counts and the mail can never disagree.
 */
function countBreaches(
  view: DeviceView,
  deviceId: number,
): { lowSupplies: number; wasteFull: number } {
  const breached = evaluateSupplies(
    view.slug,
    deviceId,
    view.supplies,
    listAlertRules(),
  ).filter((condition) => condition.breached);

  return {
    lowSupplies: breached.filter((c) => c.supply.kind === 'consumable').length,
    wasteFull: breached.filter((c) => c.supply.kind === 'receptacle').length,
  };
}

/**
 * `device` is the registry row, not just its id: the suppression flags live
 * there rather than on the poll result, and a card has to show that a device is
 * muted whether or not it has ever been polled.
 */
function summarize(view: DeviceView, device: DeviceRow) {
  // Reachable and stocked is not the same as working: an empty tray stops a
  // printer just as completely as an unplugged one, and the dashboard used to
  // call that "Healthy".
  const attention = assessAttention(view.state, view.stateReasons);

  return {
    slug: view.slug,
    displayName: view.displayName,
    location: view.location,
    model: view.model,
    host: view.host,
    adapter: view.adapter,
    state: view.state,
    capabilities: view.capabilities,
    isOnline: view.isOnline,
    lastSuccessAt: view.lastSuccessAt,
    consecutiveFailures: view.consecutiveFailures,
    // Enough for Overview cards to show a health summary without a second
    // request per device. Split so a full waste tank does not read as a low
    // consumable — they are different jobs for whoever walks over.
    ...countBreaches(view, device.id),
    activeJobs: view.jobs.length,
    /** True when any alert category is silenced; drives the card indicator. */
    // One flag now: maintenance mode is the whole of per-device suppression.
    // `alertsSuppressed` is kept as its own field rather than folded into
    // `isMuted` because the card and the row read it as "this device will not
    // shout", which is a question about behaviour and not about which switch is
    // set — and a future second form of suppression would answer it too.
    alertsSuppressed: device.isMuted,
    isMuted: device.isMuted,
    attention: attention.level,
    /** One phrase for the card, e.g. "Paper out" or "Paper jam +1". */
    attentionSummary: attention.summary,
    attentionReasons: attention.conditions.map((condition) => condition.label),
  };
}

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  // Every route in this file reports what a device is doing, which is exactly
  // what the access modes exist to gate. Applied at the scope rather than per
  // route so a route added later is covered by default — an unguarded status
  // endpoint would silently reopen the whole dashboard.
  app.addHook('preHandler', requireViewer);

  /**
   * The device list the shell navigates from. Reads the registry rather than
   * the cache so a configured device appears before its first poll lands.
   */
  app.get('/api/devices', async () => {
    const { backgroundPollMinutes } = getSettings();
    const rows = listEnabledDevices();

    return {
      backgroundPollMinutes,
      devices: rows.map((device) => {
        const view = getDeviceView(device.slug);
        return view === undefined
          ? {
              slug: device.slug,
              displayName: device.displayName,
              location: device.location,
              model: device.model,
              host: device.host,
              adapter: device.adapter,
              state: 'unknown' as const,
              capabilities: [],
              isOnline: false,
              lastSuccessAt: null,
              consecutiveFailures: 0,
              lowSupplies: 0,
              wasteFull: 0,
              activeJobs: 0,
              // A device configured but never polled has nothing to report, and
              // must not read as an error — it has not been asked yet.
              attention: 'ok' as const,
              attentionSummary: null,
              attentionReasons: [],
              alertsSuppressed: device.isMuted,
              isMuted: device.isMuted,
            }
          : summarize(view, device);
      }),
    };
  });

  /** Retained under the old path so existing links and bookmarks keep working. */
  app.get('/api/printers', async () => {
    const { backgroundPollMinutes } = getSettings();
    const bySlug = new Map(listEnabledDevices().map((device) => [device.slug, device]));

    return {
      backgroundPollMinutes,
      printers: listDeviceViews().flatMap((view) => {
        const device = bySlug.get(view.slug);
        // A cached view with no registry row is a device deleted mid-flight;
        // dropping it beats inventing suppression flags for it.
        return device === undefined ? [] : [summarize(view, device)];
      }),
    };
  });

  app.get<{
    Params: { slug: string };
    Querystring: { refresh?: string };
  }>('/api/printers/:slug/status', async (request, reply) => {
    const device = findDeviceBySlug(request.params.slug);
    if (device === undefined) {
      return reply.code(404).send({ error: `Unknown device: ${request.params.slug}` });
    }

    // `refresh=jobs` is what the open dashboard polls on its 60s timer: it
    // keeps the queue live without pulling supplies every minute, since those
    // are on the background cadence.
    const jobsOnly = request.query.refresh === 'jobs';

    const { view, error } = await ensureFresh(device, {
      supplies: !jobsOnly,
      jobs: true,
    });

    if (view === undefined) {
      return reply.code(503).send({
        error: 'No data for this device yet',
        detail: error?.message ?? null,
      });
    }

    return statusPayload(view, device);
  });

  /**
   * A live read of one device, ignoring both TTLs. The manual refresh button.
   *
   * Answers with the same payload as the status route plus three fields about
   * the refresh itself:
   *
   *  - `refreshed` — whether the device was actually queried. False means the
   *    cooldown refused, and what follows is the cache.
   *  - `cooldownSeconds` — how long before another force is allowed. Lets the
   *    button disable itself rather than firing requests that will be refused.
   *  - `refreshError` — the device failed to answer, but a previous reading is
   *    being served. Named so it cannot be mistaken for the `error` field the
   *    client's fetch wrapper reads off a failed response: this is a successful
   *    response carrying stale data, which is different from a failed request.
   *
   * A refused refresh is a 200, not a 429. The caller asked for this device's
   * status and is getting it; that the reading is a few seconds old is a fact
   * about the payload, not a failure of the request, and turning it into an
   * exception would put an error banner on the page for pressing a button
   * twice.
   */
  app.post<{ Params: { slug: string } }>(
    '/api/devices/:slug/refresh',
    async (request, reply) => {
      const device = findDeviceBySlug(request.params.slug);
      if (device === undefined) {
        return reply.code(404).send({ error: `Unknown device: ${request.params.slug}` });
      }

      const { view, error, refreshed, cooldownMs } = await forceRefresh(device);

      if (view === undefined) {
        return reply.code(503).send({
          error: 'No data for this device yet',
          detail: error?.message ?? null,
        });
      }

      request.log.info(
        { device: device.slug, refreshed, cooldownMs, failed: error !== undefined },
        'manual refresh',
      );

      return {
        ...statusPayload(view, device),
        refreshed,
        cooldownSeconds: Math.ceil(cooldownMs / 1000),
        refreshError: error?.message ?? null,
      };
    },
  );

  /** Recent queue history, including jobs the device has already dropped. */
  app.get<{ Params: { slug: string } }>(
    '/api/printers/:slug/jobs',
    async (request, reply) => {
      const view = getDeviceView(request.params.slug);
      if (view === undefined) {
        return reply.code(404).send({ error: `Unknown device: ${request.params.slug}` });
      }
      return { jobs: view.jobs, jobsUpdatedAt: view.jobsUpdatedAt };
    },
  );

  /**
   * Every supply on every device, in one response.
   *
   * Serves both the fleet re-order matrix and the Overview's critical-supplies
   * widget. Built from the cache rather than by refreshing, for the same reason
   * `/api/devices` is: a page showing thirty printers must not become thirty
   * device queries, and supplies move over days.
   */
  app.get('/api/supplies', async () => {
    return {
      devices: listEnabledDevices().map((device) => {
        const view = getDeviceView(device.slug);

        return {
          slug: device.slug,
          displayName: device.displayName,
          location: device.location,
          model: device.model,
          host: device.host,
          isOnline: view?.isOnline ?? false,
          lastSuccessAt: view?.lastSuccessAt ?? null,
          // A device configured but never polled reports nothing, which is
          // different from reporting that it has no supplies. Both render as an
          // empty row; only the second is a fact about the hardware.
          supplies: view === undefined ? [] : decorateSupplies(view, device.id),
        };
      }),
    };
  });

  /** Loaded paper stock across the fleet, for the media catalogue. */
  app.get('/api/media', async () => {
    return {
      devices: listEnabledDevices().map((device) => {
        const view = getDeviceView(device.slug);

        return {
          slug: device.slug,
          displayName: device.displayName,
          location: device.location,
          model: device.model,
          host: device.host,
          isOnline: view?.isOnline ?? false,
          lastSuccessAt: view?.lastSuccessAt ?? null,
          media: view?.media ?? [],
        };
      }),
    };
  });

  /**
   * The event timeline.
   *
   * `type` may be repeated (`?type=offline&type=recovered`); unrecognised
   * values are dropped rather than rejected, so a client filtering on a type a
   * newer build added gets the rest of the feed instead of a 400.
   */
  app.get<{ Querystring: { limit?: string; type?: string | string[] } }>(
    '/api/activity',
    async (request) => {
      const requested = request.query.type;
      const types = (
        requested === undefined ? [] : Array.isArray(requested) ? requested : [requested]
      ).filter((value): value is ActivityEventType => isActivityEventType(value));

      const parsed = Number.parseInt(request.query.limit ?? '', 10);

      return {
        events: listActivity({
          ...(Number.isFinite(parsed) ? { limit: parsed } : {}),
          types,
        }),
      };
    },
  );
}
