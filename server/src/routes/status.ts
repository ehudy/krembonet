/**
 * Read-only printer endpoints.
 *
 * Handlers never query a printer directly. They ask the poller to refresh
 * anything past its TTL, which is coalesced, then serve the cache. Ten
 * dashboards open at once still amount to one query per TTL window.
 */
import type { FastifyInstance } from 'fastify';

import {
  ageMs,
  getPrinterView,
  listPrinterViews,
  type PrinterView,
} from '../poller/cache.js';
import {
  ensureFresh,
  findPrinterBySlug,
  JOBS_TTL_MS,
  SUPPLIES_TTL_MS,
} from '../poller/pollPrinter.js';
import { getSettings } from '../settings/settings.js';

function decorate(view: PrinterView) {
  return {
    ...view,
    suppliesAgeSeconds: Math.round(ageMs(view.suppliesUpdatedAt) / 1000),
    jobsAgeSeconds: Math.round(ageMs(view.jobsUpdatedAt) / 1000),
    servedAt: new Date().toISOString(),
  };
}

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/printers', async () => {
    const { backgroundPollMinutes } = getSettings();

    return {
      backgroundPollMinutes,
      printers: listPrinterViews().map((view) => ({
        slug: view.slug,
        displayName: view.displayName,
        model: view.model,
        host: view.host,
        state: view.state,
        isOnline: view.isOnline,
        lastSuccessAt: view.lastSuccessAt,
        consecutiveFailures: view.consecutiveFailures,
        // Enough for Overview cards to show a health summary without a second
        // request per device.
        lowSupplies: view.supplies.filter((supply) =>
          supply.kind === 'waste' ? supply.percent >= 85 : supply.percent <= 15,
        ).length,
        activeJobs: view.jobs.length,
      })),
    };
  });

  app.get<{
    Params: { slug: string };
    Querystring: { refresh?: string };
  }>('/api/printers/:slug/status', async (request, reply) => {
    const printer = findPrinterBySlug(request.params.slug);
    if (printer === undefined) {
      return reply.code(404).send({ error: `Unknown printer: ${request.params.slug}` });
    }

    // `refresh=jobs` is what the open dashboard polls on its 60s timer: it
    // keeps the queue live without pulling ink and paper every minute, since
    // those are on the hourly background cadence.
    const jobsOnly = request.query.refresh === 'jobs';

    const { view, error } = await ensureFresh(printer, {
      supplies: !jobsOnly,
      jobs: true,
    });

    if (view === undefined) {
      return reply.code(503).send({
        error: 'No data for this printer yet',
        detail: error?.message ?? null,
      });
    }

    return {
      ...decorate(view),
      ttl: { suppliesSeconds: SUPPLIES_TTL_MS / 1000, jobsSeconds: JOBS_TTL_MS / 1000 },
    };
  });

  /** Recent queue history, including jobs the printer has already dropped. */
  app.get<{ Params: { slug: string } }>(
    '/api/printers/:slug/jobs',
    async (request, reply) => {
      const view = getPrinterView(request.params.slug);
      if (view === undefined) {
        return reply.code(404).send({ error: `Unknown printer: ${request.params.slug}` });
      }
      return { jobs: view.jobs, jobsUpdatedAt: view.jobsUpdatedAt };
    },
  );
}
