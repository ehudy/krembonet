/**
 * Read-only device endpoints.
 *
 * Handlers never query a device directly. They ask the poller to refresh
 * anything past its TTL, which is coalesced, then serve the cache. Ten
 * dashboards open at once still amount to one query per TTL window.
 */
import type { FastifyInstance } from 'fastify';

import { listAlertRules } from '../alerts/store.js';
import { evaluateSupplies } from '../alerts/rules.js';
import { levelToPercent } from '../devices/types.js';
import { ageMs, getDeviceView, listDeviceViews, type DeviceView } from '../poller/cache.js';
import {
  ensureFresh,
  findDeviceBySlug,
  JOBS_TTL_MS,
  listEnabledDevices,
  SUPPLIES_TTL_MS,
} from '../poller/pollDevice.js';
import { getSettings } from '../settings/settings.js';

function decorate(view: DeviceView, deviceId: number) {
  // Evaluated once, here, using the same rules the alert engine uses. The panel
  // used to hardcode its own 15%/85% constants, which meant the bar could turn
  // red at a level that sent no mail, or stay calm at one that did.
  const breached = new Set(
    evaluateSupplies(view.slug, deviceId, view.supplies, listAlertRules())
      .filter((condition) => condition.breached)
      .map((condition) => condition.supply.name),
  );

  return {
    ...view,
    // Levels are a union, so the browser gets the comparable number alongside
    // it rather than re-implementing the conversion — that duplication is
    // exactly what let thresholds drift before.
    supplies: view.supplies.map((supply) => ({
      ...supply,
      percent: levelToPercent(supply.level),
      breached: breached.has(supply.name),
    })),
    suppliesAgeSeconds: Math.round(ageMs(view.suppliesUpdatedAt) / 1000),
    jobsAgeSeconds: Math.round(ageMs(view.jobsUpdatedAt) / 1000),
    servedAt: new Date().toISOString(),
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

function summarize(view: DeviceView, deviceId: number) {
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
    lowSupplies: countBreached(view, deviceId),
    activeJobs: view.jobs.length,
  };
}

export async function statusRoutes(app: FastifyInstance): Promise<void> {
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
            }
          : summarize(view, device.id);
      }),
    };
  });

  /** Retained under the old path so existing links and bookmarks keep working. */
  app.get('/api/printers', async () => {
    const { backgroundPollMinutes } = getSettings();
    const byslug = new Map(listEnabledDevices().map((device) => [device.slug, device.id]));

    return {
      backgroundPollMinutes,
      printers: listDeviceViews().map((view) => summarize(view, byslug.get(view.slug) ?? -1)),
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
}
