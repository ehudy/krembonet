/**
 * The Overview, in one of two modes.
 *
 * The same fleet answers two different questions depending on who is asking.
 * Whoever keeps the printers running wants to know what is broken, what needs
 * ordering, and what happened overnight. Whoever is trying to print something
 * wants to know whether the machine is free, what is loaded in it, and whether
 * it will run out mid-job. Those are different pages, not different sections of
 * one page — putting both on screen at once produces something twice as long
 * that serves neither reader well.
 *
 * The choice is stored per browser rather than per hub, so the person at the
 * plotter picking the floor view does not rearrange the IT manager's screen.
 * There are no accounts here to hang it off, and adding some to decide which of
 * two layouts to draw would be a large answer to a small question.
 *
 * This file owns only what both modes need: the device list, the header, and
 * the switch. Each mode fetches the rest for itself, so the floor view does not
 * pay for the activity feed it never shows.
 */
import { useCallback } from 'react';
import { Plus } from 'lucide-react';

import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.js';
import { PageHeader } from '../components/PageHeader.js';
import { ViewModeToggle } from '../components/ViewModeToggle.js';
import { useOverviewMode } from '../hooks/useOverviewMode.js';
import { usePolled } from '../hooks/usePolled.js';
import { useTranslation } from '../i18n/i18n.js';
import { effectiveOverviewMode } from '../lib/overviewMode.js';
import { Link } from '../router.js';
import { CommandCenterView } from './CommandCenterView.js';
import { FloorView } from './FloorView.js';

export function Overview() {
  const { t } = useTranslation();
  const { isAdmin } = useAuth();
  const [storedMode, setMode] = useOverviewMode();

  // A viewer is always shown Floor & Queue and has no toggle to change it; an
  // admin gets their stored choice, defaulting to Command Center. So the mode
  // rendered is not the stored one for a viewer, and the switch appears only
  // for an admin.
  const mode = effectiveOverviewMode(storedMode, isAdmin);

  const loadDevices = useCallback((signal: AbortSignal) => api.listDevices(signal), []);
  const fleet = usePolled(loadDevices);

  const devices = fleet.data?.devices ?? [];
  const hasDevices = devices.length > 0;

  return (
    <>
      <PageHeader
        title={t('overview.title')}
        subtitle={t(
          mode === 'floor_queue' ? 'overview.subtitleFloor' : 'overview.subtitle',
        )}
        actions={
          isAdmin ? <ViewModeToggle mode={mode} onChange={setMode} /> : undefined
        }
      />

      {fleet.error !== null && <div className="banner is-error">{fleet.error}</div>}

      {/* A hub with nothing configured gets the setup prompt in either mode.
          Both layouts would otherwise render a page of empty scaffolding around
          a fleet that does not exist yet. */}
      {!fleet.isLoading && !hasDevices ? (
        <div className="empty-state">
          <p>{t('overview.emptyTitle')}</p>
          <Link to="/admin/devices" className="btn-primary">
            <Plus size={15} strokeWidth={2} aria-hidden="true" />
            {t('overview.addFirstDevice')}
          </Link>
        </div>
      ) : mode === 'floor_queue' ? (
        <FloorView devices={devices} isLoading={fleet.isLoading} />
      ) : (
        <CommandCenterView devices={devices} isLoading={fleet.isLoading} />
      )}
    </>
  );
}
