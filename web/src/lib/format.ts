/**
 * Date and duration formatting.
 *
 * The functions take a translator rather than importing one, so they stay pure
 * and testable — and so a caller cannot accidentally format in one language
 * while the surrounding page renders in another.
 *
 * Absolute times go through `toLocaleString` with the active locale rather than
 * `undefined`. Passing `undefined` uses the *browser's* locale, which is right
 * only by coincidence: an operator who set the hub to Spanish on an
 * English-configured machine would get Spanish labels around English dates.
 */
import type { Locale, Translate } from '../i18n/i18n.js';

export function formatTime(
  iso: string | null | undefined,
  locale: Locale,
  t: Translate,
): string {
  if (iso === null || iso === undefined) return t('time.never');

  return new Date(iso).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDate(
  iso: string | null | undefined,
  locale: Locale,
): string | null {
  if (iso === null || iso === undefined) return null;

  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Compact "how long ago", for status lines where a full timestamp is noise.
 *
 * The buckets are pluralised through the dictionary rather than by appending an
 * "s" here, which only works in English and is exactly the kind of assumption
 * that makes a UI feel machine-translated.
 */
export function relativeTime(
  iso: string | number | null | undefined,
  t: Translate,
): string {
  if (iso === null || iso === undefined) return t('time.never');

  const then = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(then)) return t('time.never');

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return t('time.justNow');
  if (seconds < 90) return t('time.minutesAgo', { count: 1 });

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });

  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { count: hours });

  return t('time.daysAgo', { count: Math.round(hours / 24) });
}

/** mm:ss — digits only, so it needs no translation. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
