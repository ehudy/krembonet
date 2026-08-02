/**
 * Read-only device endpoints.
 *
 * Handlers never query a device directly. They ask the poller to refresh
 * anything past its TTL, which is coalesced, then serve the cache. Ten
 * dashboards open at once still amount to one query per TTL window.
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
import { hasAnySuppression, suppressedCategories } from '../alerts/mute.js';
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
  type DeviceRow,
  JOBS_TTL_MS,
  listEnabledDevices,
  SUPPLIES_TTL_MS,
} from '../poller/pollDevice.js';
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
 * How many supplies are currently past their alert threshold.
 *
 * Uses the same rules the alert engine does, so the count on a card and the
 * mail an operator receives can never disagree.
 */
function countBreached(view: DeviceView, deviceId: number): number {
  return evaluateSupplies(view.slug, deviceId, view.supplies, listAlertRules()).filter(
    (condition) => condition.breached,
  ).length;
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
    // request per device.
    lowSupplies: countBreached(view, device.id),
    activeJobs: view.jobs.length,
    /** True when any alert category is silenced; drives the card indicator. */
    alertsSuppressed: hasAnySuppression(device),
    suppressedAlerts: suppressedCategories(device),
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
              activeJobs: 0,
              // A device configured but never polled has nothing to report, and
              // must not read as an error — it has not been asked yet.
              attention: 'ok' as const,
              attentionSummary: null,
              attentionReasons: [],
              alertsSuppressed: hasAnySuppression(device),
              suppressedAlerts: suppressedCategories(device),
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

    return {
      ...decorate(view, device.id),
      ttl: { suppliesSeconds: SUPPLIES_TTL_MS / 1000, jobsSeconds: JOBS_TTL_MS / 1000 },
    };
  });

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
