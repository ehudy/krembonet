/**
 * Webhook persistence and delivery — the I/O shell around `webhook-format.ts`.
 *
 * Delivery is best-effort and never throws at the caller. An alert engine that
 * dies because a Discord webhook was revoked would stop sending the *email*
 * too, which is the failure mode this whole subsystem is supposed to prevent.
 * Every destination is attempted, every result is recorded, and the caller
 * carries on.
 */
import { eq } from 'drizzle-orm';

import { decryptSecret } from '../crypto/secrets.js';
import { db } from '../db/client.js';
import { devices, webhooks } from '../db/schema.js';
import { parseDeviceRouting, serializeWebhookIds } from './routing.js';
import {
  buildWebhookRequest,
  isWebhookFormat,
  type WebhookFormat,
  type WebhookNotification,
} from './webhook-format.js';

export type WebhookRow = typeof webhooks.$inferSelect;

/**
 * A destination that a POST can be built for.
 *
 * `format` is narrowed from the stored text here rather than trusted: a row
 * written by an older build, or edited by hand, must degrade to the generic
 * JSON shape instead of falling through the formatter's switch.
 */
export interface WebhookTarget {
  id: number;
  name: string;
  format: WebhookFormat;
  url: string;
  headers: Record<string, string>;
}

/** Long enough for a cold serverless receiver, short enough not to stall a poll. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Decodes the stored header blob.
 *
 * The blob is encrypted at rest — it routinely holds a bearer token — so this
 * decrypts before parsing. A failure here costs the operator their custom
 * headers rather than the alert: a webhook that would have carried an auth
 * header still gets attempted, and the receiver's 401 is a far more legible
 * symptom than a poll that threw.
 */
function parseHeaders(raw: string | null): Record<string, string> {
  if (raw === null || raw.trim() === '') return {};

  try {
    const parsed: unknown = JSON.parse(decryptSecret(raw));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') headers[key] = value;
    }
    return headers;
  } catch {
    // Malformed JSON, or a blob that will not decrypt because the key changed.
    return {};
  }
}

export function toTarget(row: WebhookRow): WebhookTarget {
  return {
    id: row.id,
    name: row.name,
    format: isWebhookFormat(row.format) ? row.format : 'generic',
    url: row.url,
    headers: parseHeaders(row.headers),
  };
}

export function listWebhooks(): WebhookRow[] {
  return db.select().from(webhooks).orderBy(webhooks.id).all();
}

export function getWebhook(id: number): WebhookRow | undefined {
  return db.select().from(webhooks).where(eq(webhooks.id, id)).all()[0];
}

export function listEnabledTargets(): WebhookTarget[] {
  return listWebhooks()
    .filter((row) => row.enabled)
    .map(toTarget);
}

/**
 * Drops a deleted destination from every device that routed to it.
 *
 * Without this a device left holding only dead ids would route its alerts at
 * nothing, and the routing card would show an empty selection that reads as
 * "using the defaults" — which is the one thing it would not be doing. Cheap:
 * this runs on an operator deleting a webhook, over a table of tens of rows.
 */
export function forgetWebhookRouting(id: number): void {
  const rows = db
    .select({
      id: devices.id,
      alertEmailRecipients: devices.alertEmailRecipients,
      alertWebhookIds: devices.alertWebhookIds,
    })
    .from(devices)
    .all();

  for (const row of rows) {
    const { webhookIds } = parseDeviceRouting(row);
    if (!webhookIds.includes(id)) continue;

    db.update(devices)
      .set({
        alertWebhookIds: serializeWebhookIds(webhookIds.filter((each) => each !== id)),
        updatedAt: new Date(),
      })
      .where(eq(devices.id, row.id))
      .run();
  }
}

export interface WebhookDeliveryResult {
  target: WebhookTarget;
  ok: boolean;
  /** HTTP status, or null when the request never got one. */
  status: number | null;
  error?: string;
}

function recordAttempt(id: number, result: WebhookDeliveryResult): void {
  db.update(webhooks)
    .set({
      lastStatus: result.ok ? 'ok' : 'failed',
      lastError: result.error ?? null,
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(webhooks.id, id))
    .run();
}

/**
 * Posts one notification to one destination.
 *
 * Returns a result rather than throwing, including for a network failure or a
 * timeout — the caller's job is to log what happened to each destination, not
 * to unwind.
 */
export async function sendWebhook(
  target: WebhookTarget,
  notification: WebhookNotification,
): Promise<WebhookDeliveryResult> {
  const { body, headers } = buildWebhookRequest(target.format, notification);

  // AbortSignal.timeout rather than a manual timer: it cancels the socket, so a
  // receiver that accepts the connection and then hangs cannot pin the poll
  // cycle open for its own idle timeout.
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(target.url, {
      method: 'POST',
      // Operator headers last so an explicit `Authorization` wins, but they
      // cannot silently break a format by overriding its content-type — that
      // is intentional and documented in the portal.
      headers: { ...headers, ...target.headers },
      body,
      signal,
    });

    if (!response.ok) {
      // Receivers put the useful part of a rejection in the body ("invalid
      // webhook token"), and the status alone rarely explains it.
      const detail = await response.text().catch(() => '');
      return {
        target,
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`,
      };
    }

    return { target, ok: true, status: response.status };
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'TimeoutError'
        ? `No response within ${REQUEST_TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : String(error);

    return { target, ok: false, status: null, error: message };
  }
}

/**
 * Posts to every enabled destination.
 *
 * Concurrent because they are independent and a slow receiver should not delay
 * a fast one; `allSettled` because one rejection must not discard the results
 * of the others.
 */
export async function dispatchWebhooks(
  notification: WebhookNotification,
  targets: WebhookTarget[] = listEnabledTargets(),
): Promise<WebhookDeliveryResult[]> {
  if (targets.length === 0) return [];

  const settled = await Promise.allSettled(
    targets.map((target) => sendWebhook(target, notification)),
  );

  const results = settled.map((outcome, index) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : {
          // `sendWebhook` already catches everything, so this is defence
          // against a future edit that stops it doing so.
          target: targets[index] as WebhookTarget,
          ok: false,
          status: null,
          error: String(outcome.reason),
        },
  );

  for (const result of results) recordAttempt(result.target.id, result);

  return results;
}
