/**
 * The Command Center / Floor & Queue switch.
 *
 * A segmented control rather than a switch, because the two options are peers
 * with names rather than an on/off state — "Floor & Queue" is not "Command
 * Center turned off", and a toggle labelled with one of its two states is the
 * classic way to leave someone unsure which one they are looking at.
 *
 * Built from radios rather than buttons. A screen reader then announces it as
 * one control with two options and reports which is chosen; two `aria-pressed`
 * buttons announce two independent toggles that happen to sit together, and
 * arrow keys do not move between them. The radios are visually hidden and the
 * labels carry the appearance, so focus and keyboard behaviour are the
 * platform's rather than something reimplemented here.
 */
import { LayoutDashboard, Printer } from 'lucide-react';

import { useTranslation } from '../i18n/i18n.js';
import { OVERVIEW_MODES, type OverviewMode } from '../lib/overviewMode.js';

const ICONS: Record<OverviewMode, typeof Printer> = {
  command_center: LayoutDashboard,
  floor_queue: Printer,
};

const LABELS: Record<OverviewMode, string> = {
  command_center: 'overview.viewCommandCenter',
  floor_queue: 'overview.viewFloorQueue',
};

export function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: OverviewMode;
  onChange: (mode: OverviewMode) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="segmented" role="radiogroup" aria-label={t('overview.viewMode')}>
      {OVERVIEW_MODES.map((value) => {
        const Icon = ICONS[value];
        const isActive = mode === value;

        return (
          <label
            key={value}
            className={`segment${isActive ? ' is-active' : ''}`}
            title={t(`${LABELS[value]}Hint`)}
          >
            <input
              type="radio"
              name="overview-view-mode"
              className="visually-hidden"
              value={value}
              checked={isActive}
              onChange={() => onChange(value)}
            />
            <Icon size={14} strokeWidth={2} aria-hidden="true" />
            {t(LABELS[value])}
          </label>
        );
      })}
    </div>
  );
}
