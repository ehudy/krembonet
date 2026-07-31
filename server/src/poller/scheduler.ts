/**
 * Background poll loop.
 *
 * Runs in the same long-lived process as the HTTP server, which is the whole
 * reason this project uses Fastify rather than a request-driven framework:
 * supply alerts have to fire at 3am with no browser open anywhere.
 *
 * This loop only reads supplies and media. The print queue is refreshed on
 * demand by the status route, because nobody needs a queue snapshot taken at
 * 4am and it would be an hour stale by the time anyone looked.
 */
import type { FastifyBaseLogger } from 'fastify';
import { schedule, type ScheduledTask } from 'node-cron';

import { evaluateAlerts } from '../alerts/engine.js';
import { IppError } from '../devices/ipp/ipptool.js';
import { getSettings } from '../settings/settings.js';
import { hydrateCacheFromDb, listEnabledDevices, pollSupplies } from './pollDevice.js';

let task: ScheduledTask | undefined;
let currentExpression: string | undefined;

async function runBackgroundPoll(log: FastifyBaseLogger): Promise<void> {
  for (const device of listEnabledDevices()) {
    const started = Date.now();
    try {
      const view = await pollSupplies(device);
      log.info(
        { device: device.slug, ms: Date.now() - started, state: view.state },
        'background poll ok',
      );

      await evaluateAlerts(device, view, log);
    } catch (error) {
      const code = error instanceof IppError ? error.code : 'UNKNOWN';
      // Warn, not error: a device switched off overnight is expected, and
      // paging on it would train everyone to ignore the logs.
      log.warn(
        { device: device.slug, code, ms: Date.now() - started },
        `background poll failed: ${(error as Error).message}`,
      );
    }
  }
}

/** Minutes to a cron expression, clamped to something a printer can survive. */
export function toCronExpression(minutes: number): string {
  const safe = Math.min(Math.max(Math.round(minutes), 1), 720);
  if (safe === 1) return '* * * * *';
  if (safe < 60) return `*/${safe} * * * *`;

  const hours = Math.round(safe / 60);
  return hours >= 24 ? '0 0 * * *' : `0 */${Math.min(hours, 23)} * * *`;
}

function scheduleWith(expression: string, log: FastifyBaseLogger): void {
  void task?.stop();
  currentExpression = expression;
  task = schedule(expression, () => {
    void runBackgroundPoll(log);
  });
}

export function startPoller(log: FastifyBaseLogger): void {
  // Serve whatever the last run persisted, so a restart is not a blank screen.
  hydrateCacheFromDb();

  const { backgroundPollMinutes } = getSettings();
  const expression = toCronExpression(backgroundPollMinutes);

  log.info({ expression, backgroundPollMinutes }, 'starting background poller');
  scheduleWith(expression, log);

  // Populate the cache and evaluate alerts once at boot rather than waiting a
  // full hour for the first tick.
  void runBackgroundPoll(log);
}

/**
 * Re-reads the interval from settings and reschedules if it changed.
 * Called after an admin saves settings, so a new cadence takes effect without
 * a container restart.
 */
export function reschedulePoller(log: FastifyBaseLogger): void {
  const { backgroundPollMinutes } = getSettings();
  const expression = toCronExpression(backgroundPollMinutes);

  if (expression === currentExpression) return;

  log.info(
    { from: currentExpression, to: expression, backgroundPollMinutes },
    'rescheduling background poller',
  );
  scheduleWith(expression, log);
}

export function stopPoller(): void {
  void task?.stop();
  task = undefined;
  currentExpression = undefined;
}
