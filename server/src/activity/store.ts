/**
 * The fleet's event history.
 *
 * Separate from `alert_logs` on purpose. That table answers "was anyone told,
 * and did it get through" — one row per destination, with a delivery status.
 * This one answers "what happened", which is a different question with a
 * different audience: an operator scanning a timeline does not care that the
 * Discord webhook returned 204, only that the plotter went offline at 04:12 and
 * came back at 04:19.
 *
 * The practical consequence is that events are recorded whether or not anything
 * carried them. A muted device, a hub with no SMTP configured, and one with
 * alerts switched off entirely all still build a readable history — which is
 * the point, because those are exactly the hubs where the dashboard is the only
 * record there is.
 */
import { desc, eq, inArray, lt, sql } from 'drizzle-orm';

import { db } from '../db/client.js';
import { activityEvents, devices } from '../db/schema.js';

/**
 * What kind of thing happened.
 *
 * Deliberately four, and deliberately not a mirror of `AlertCategory`:
 * `offline` and `recovered` are the two edges of one alert category, and a
 * timeline that collapsed them into "offline" twice would be unreadable.
 */
export type ActivityEventType = 'offline' | 'recovered' | 'supply_low' | 'media_error';

export const ACTIVITY_EVENT_TYPES: readonly ActivityEventType[] = [
  'offline',
  'recovered',
  'supply_low',
  'media_error',
];

export function isActivityEventType(value: unknown): value is ActivityEventType {
  return ACTIVITY_EVENT_TYPES.includes(value as ActivityEventType);
}

/**
 * How many rows to keep.
 *
 * A busy fleet of thirty printers produces a few dozen events a day, so this is
 * months of history. The cap exists because nothing else ever deletes from this
 * table, and an unbounded append-only log on a box nobody administers is a slow
 * disk leak rather than a feature.
 */
export const RETAINED_EVENTS = 2_000;

/** How much slack to let build up before trimming, so most writes do no work. */
const TRIM_SLACK = 200;

export interface RecordedActivity {
  deviceId: number;
  deviceName: string;
  type: ActivityEventType;
  message: string;
}

/**
 * Appends one event, and occasionally trims the tail.
 *
 * Never throws: this is bookkeeping that runs inside the alert path, and a
 * failure to write history must not stop a notification from going out or take
 * down the poll loop. The caller gets a boolean it is free to ignore.
 */
export function recordActivity(event: RecordedActivity): boolean {
  try {
    db.insert(activityEvents)
      .values({
        deviceId: event.deviceId,
        deviceName: event.deviceName,
        eventType: event.type,
        message: event.message,
      })
      .run();

    pruneActivity();
    return true;
  } catch {
    return false;
  }
}

/**
 * Drops the oldest rows once the table has drifted past its cap.
 *
 * Trimming on a slack margin rather than every insert keeps the common write a
 * single statement: the count only crosses the line once every `TRIM_SLACK`
 * events, and the delete that follows removes the whole overshoot at once.
 */
export function pruneActivity(limit = RETAINED_EVENTS): void {
  const [counted] = db
    .select({ total: sql<number>`count(*)` })
    .from(activityEvents)
    .all();

  const total = counted?.total ?? 0;
  if (total <= limit + TRIM_SLACK) return;

  // Deleting by id below a cutoff rather than by `LIMIT ... OFFSET`, because
  // SQLite only supports the latter on DELETE when compiled with a flag that
  // better-sqlite3 does not set.
  const [cutoff] = db
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .orderBy(desc(activityEvents.id))
    .limit(1)
    .offset(limit - 1)
    .all();

  if (cutoff === undefined) return;
  db.delete(activityEvents).where(lt(activityEvents.id, cutoff.id)).run();
}

export interface ActivityEvent {
  id: number;
  deviceId: number | null;
  /** Null once the device is gone, or when it was never resolvable. */
  deviceSlug: string | null;
  deviceName: string;
  type: ActivityEventType;
  message: string;
  createdAt: string;
}

export interface ActivityQuery {
  limit?: number;
  /** Empty or omitted means every type. */
  types?: readonly ActivityEventType[];
}

/**
 * The feed, newest first.
 *
 * The slug is joined in rather than stored, so a renamed or re-slugged device
 * still links correctly from old rows — while `device_name` keeps saying what
 * the device was called when the event happened.
 */
export function listActivity(query: ActivityQuery = {}): ActivityEvent[] {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 500);
  const types = query.types ?? [];

  const rows = db
    .select({
      id: activityEvents.id,
      deviceId: activityEvents.deviceId,
      deviceSlug: devices.slug,
      deviceName: activityEvents.deviceName,
      eventType: activityEvents.eventType,
      message: activityEvents.message,
      createdAt: activityEvents.createdAt,
    })
    .from(activityEvents)
    .leftJoin(devices, eq(activityEvents.deviceId, devices.id))
    .where(types.length === 0 ? undefined : inArray(activityEvents.eventType, [...types]))
    // Ties on the millisecond are common — one poll can record several events
    // in the same tick — so the id breaks them and keeps paging stable.
    .orderBy(desc(activityEvents.createdAt), desc(activityEvents.id))
    .limit(limit)
    .all();

  return rows.map((row) => ({
    id: row.id,
    deviceId: row.deviceId,
    deviceSlug: row.deviceSlug,
    deviceName: row.deviceName,
    // Widened at the boundary rather than asserted: the column is free text as
    // far as SQLite is concerned, and a row written by an older build with a
    // type this one does not know should not crash the feed.
    type: (isActivityEventType(row.eventType)
      ? row.eventType
      : 'media_error') as ActivityEventType,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
  }));
}
