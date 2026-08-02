/**
 * One entry in the event timeline.
 *
 * Shared by the Overview widget and the full log, in two densities. They differ
 * only in whether the absolute timestamp is shown alongside the relative one:
 * the widget answers "has anything happened lately", where "12 min ago" is the
 * whole answer, and the log answers "what happened overnight", where the clock
 * time is the point.
 *
 * The event type carries the colour, not the severity of the message. A
 * recovery is green, an outage is red, and a supply crossing is amber — that
 * mapping is fixed per type rather than derived, so an operator scanning the
 * left edge of the feed can read it without reading the words.
 */
import {
  CircleCheck,
  Droplet,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';

import { useTranslation } from '../i18n/i18n.js';
import { formatTime, relativeTime } from '../lib/format.js';
import { Link } from '../router.js';
import type { ActivityEvent, ActivityEventType } from '../types.js';

/** Icon and tone per event type. `tone` is a class suffix, not a colour. */
const APPEARANCE: Record<ActivityEventType, { icon: LucideIcon; tone: string }> = {
  offline: { icon: WifiOff, tone: 'is-bad' },
  recovered: { icon: CircleCheck, tone: 'is-good' },
  supply_low: { icon: Droplet, tone: 'is-warn' },
  media_error: { icon: TriangleAlert, tone: 'is-bad' },
};

export function ActivityRow({
  event,
  compact = false,
}: {
  event: ActivityEvent;
  compact?: boolean;
}) {
  const { t, locale } = useTranslation();
  const { icon: Icon, tone } = APPEARANCE[event.type];

  return (
    <article className={`activity-row${compact ? ' is-compact' : ''}`}>
      <span className={`activity-marker ${tone}`} aria-hidden="true">
        <Icon size={14} strokeWidth={2} />
      </span>

      <div className="activity-body">
        <div className="activity-head">
          {/* Linked only while the device still exists. A deleted device keeps
              its name in the history — that is what makes an old row mean
              anything — but a link to a page that 404s is worse than plain
              text. */}
          {event.deviceSlug === null ? (
            <strong>{event.deviceName}</strong>
          ) : (
            <Link to={`/devices/${event.deviceSlug}`} className="activity-device">
              <strong>{event.deviceName}</strong>
            </Link>
          )}
          <span className={`activity-type ${tone}`}>{t(`activity.types.${event.type}`)}</span>
        </div>

        <p className="activity-message">{event.message}</p>
      </div>

      <time className="activity-time muted" dateTime={event.createdAt}>
        {relativeTime(event.createdAt, t)}
        {!compact && (
          <small className="activity-absolute">
            {formatTime(event.createdAt, locale, t)}
          </small>
        )}
      </time>
    </article>
  );
}
