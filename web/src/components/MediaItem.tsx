/**
 * One row in any list of media slots.
 *
 * Shared by the Media Catalog's three tabs and the device page's Loaded Media
 * panel, which between them used to render the same kind of thing — a named
 * slot, with a line of detail under it — four different ways: a link with an
 * icon, the same link plus a right-aligned badge, and two flex rows led by a
 * grey circle. Side by side that read as unrelated screens rather than views of
 * one catalogue, and moving between them made the eye re-find where a row's
 * name starts.
 *
 * The detail is always the muted second line, never a pill pinned to the right
 * edge: a badge in the corner carries a different visual weight from prose under
 * a name. The icon is a real glyph rather than a coloured disc, because a grey
 * circle in front of every row says nothing — it is the same shape whether the
 * tray is a roll, a cassette, or empty — while costing the row 30px of the width
 * its name needed.
 *
 * Whether the row links anywhere is the only thing that varies: a printer row
 * goes to its printer, and a tray row is already inside its printer's panel.
 */
import type { LucideIcon } from 'lucide-react';

import { Link } from '../router.js';

/** Joins the parts of a subtitle, dropping the ones a device did not report. */
export function subtitleOf(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== '').join(' · ');
}

export function MediaItem({
  icon: Icon,
  title,
  subtitle,
  hint,
  to,
  isDim = false,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  /** Tooltip for the subtitle, e.g. why a raw vendor code is showing. */
  hint?: string;
  /** Omitted for a row that is not a link. */
  to?: string;
  /** An empty slot: present, but with nothing in it. */
  isDim?: boolean;
}) {
  const body = (
    <>
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
      <span>
        <strong>{title}</strong>
        <small className="muted" title={hint}>
          {subtitle}
        </small>
      </span>
    </>
  );

  return (
    <li className={`media-item${isDim ? ' is-dim' : ''}`}>
      {to === undefined ? (
        <span className="media-line">{body}</span>
      ) : (
        <Link to={to} className="media-line">
          {body}
        </Link>
      )}
    </li>
  );
}
