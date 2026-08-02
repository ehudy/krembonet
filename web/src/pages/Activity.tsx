/**
 * The full event timeline.
 *
 * Filtering happens server-side rather than in the browser, which is the one
 * design decision here worth stating. Fetching the last hundred events and
 * hiding the ones that do not match looks simpler, and produces a page that
 * shows three rows when an operator filters to "offline" on a hub where the
 * last hundred events were mostly supply crossings. Asking the server for a
 * hundred *offline* events instead gives a full page every time.
 *
 * There is no pagination. The table keeps a bounded history and this reads the
 * most recent slice of it; an operator who needs more than a few hundred events
 * needs a report, not an infinite scroll.
 */
import { useCallback, useMemo, useState } from 'react';
import { History } from 'lucide-react';

import { api } from '../api.js';
import { ActivityRow } from '../components/ActivityRow.js';
import { PageHeader } from '../components/PageHeader.js';
import { usePolled } from '../hooks/usePolled.js';
import { useTranslation } from '../i18n/i18n.js';
import type { ActivityEvent, ActivityEventType } from '../types.js';

/** How much history one page asks for. */
const PAGE_SIZE = 100;

type Filter = 'all' | ActivityEventType;

const FILTERS: readonly Filter[] = [
  'all',
  'offline',
  'recovered',
  'supply_low',
  'media_error',
];

/** The label for a filter chip. `all` is a page word; the rest are event types. */
function filterLabel(filter: Filter): string {
  return filter === 'all' ? 'activity.filterAll' : `activity.types.${filter}`;
}

/**
 * Groups a feed by calendar day.
 *
 * A flat list of ninety timestamped rows is technically complete and
 * practically unreadable — "was that this morning or Tuesday" is the question
 * the eye asks at every row, and a date heading answers it once per day.
 */
function groupByDay(
  events: readonly ActivityEvent[],
): { day: string; events: ActivityEvent[] }[] {
  const groups: { day: string; events: ActivityEvent[] }[] = [];

  for (const event of events) {
    // The local calendar day, not the UTC one: an event at 01:00 local on
    // Tuesday belongs under Tuesday for the person reading it.
    const date = new Date(event.createdAt);
    const day = Number.isNaN(date.getTime())
      ? event.createdAt
      : `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

    const last = groups.at(-1);
    if (last !== undefined && last.day === day) last.events.push(event);
    else groups.push({ day, events: [event] });
  }

  return groups;
}

/** The heading for a day group, relative where that reads better than a date. */
function dayLabel(iso: string, locale: string, t: (key: string) => string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return t('common.unknown');

  const startOfDay = (value: Date): number =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();

  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (days === 0) return t('activity.today');
  if (days === 1) return t('activity.yesterday');

  return date.toLocaleDateString(locale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function Activity() {
  const { t, locale } = useTranslation();
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(
    (signal: AbortSignal) =>
      api.activity(
        {
          limit: PAGE_SIZE,
          ...(filter === 'all' ? {} : { types: [filter] }),
        },
        signal,
      ),
    [filter],
  );

  const { data, error, isLoading } = usePolled(load);

  const events = useMemo(() => data?.events ?? [], [data]);
  const days = useMemo(() => groupByDay(events), [events]);

  return (
    <>
      <PageHeader title={t('activity.title')} subtitle={t('activity.subtitle')} />

      {error !== null && <div className="banner is-error">{error}</div>}

      <div className="list-controls">
        <div className="filter-chips" role="group" aria-label={t('activity.title')}>
          {FILTERS.map((entry) => (
            <button
              key={entry}
              type="button"
              className={`chip${filter === entry ? ' is-active' : ''}`}
              aria-pressed={filter === entry}
              onClick={() => setFilter(entry)}
            >
              {t(filterLabel(entry))}
            </button>
          ))}
        </div>

        <span className="muted list-count">
          {t('activity.showing', { count: events.length })}
        </span>
      </div>

      {isLoading && <p className="muted">{t('common.loading')}</p>}

      {!isLoading && events.length === 0 && (
        <div className="empty-state">
          <p>
            {filter === 'all' ? t('activity.empty') : t('activity.emptyFiltered')}
          </p>
          <p className="muted">{t('activity.emptyHint')}</p>
        </div>
      )}

      {days.map((group) => {
        const first = group.events[0];
        if (first === undefined) return null;

        return (
          <section key={group.day} className="activity-day">
            <h2 className="section-title">{dayLabel(first.createdAt, locale, t)}</h2>
            <div className="activity-feed">
              {group.events.map((event) => (
                <ActivityRow key={event.id} event={event} />
              ))}
            </div>
          </section>
        );
      })}

      {/* Said once, at the bottom, rather than as a banner at the top: it is
          context for what the operator has just read, not a warning. */}
      {!isLoading && events.length >= PAGE_SIZE && (
        <p className="muted list-footnote">
          <History size={14} strokeWidth={2} aria-hidden="true" />
          {t('activity.truncated', { count: PAGE_SIZE })}
        </p>
      )}
    </>
  );
}
