/**
 * The star that pins a device to the sidebar.
 *
 * A button rather than a checkbox: the visible affordance is a toggle, but the
 * thing it toggles is navigation, not a value in a form, and a checkbox would
 * announce itself as one to a screen reader. `aria-pressed` carries the state
 * instead, which is what a toggle button is for.
 *
 * Rendered inside a table cell that also contains a link to the device, so it
 * stops propagation — clicking the star must never navigate.
 */
import { Star } from 'lucide-react';

import { usePinnedDevices } from '../hooks/usePinnedDevices.js';
import { useTranslation } from '../i18n/i18n.js';

export function PinButton({ slug, name }: { slug: string; name: string }) {
  const { t } = useTranslation();
  const { isPinned, toggle } = usePinnedDevices();
  const pinned = isPinned(slug);

  const label = pinned ? t('pins.unpin', { name }) : t('pins.pin', { name });

  return (
    <button
      type="button"
      className={`pin-button${pinned ? ' is-pinned' : ''}`}
      aria-pressed={pinned}
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toggle(slug);
      }}
    >
      {/* Filled when pinned, outline when not — the state has to be readable
          without hovering for the tooltip, and at this size a colour change
          alone is too subtle to catch while scanning a table. */}
      <Star
        size={15}
        strokeWidth={1.75}
        fill={pinned ? 'currentColor' : 'none'}
        aria-hidden="true"
      />
    </button>
  );
}
