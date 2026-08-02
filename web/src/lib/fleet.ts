/**
 * Fleet-level derivations shared by the Overview and the feature pages.
 *
 * These live in one place because the alternative is three pages that each
 * decide for themselves what "needs attention" means. That has already happened
 * once in this codebase — the ink panel carried its own threshold constants and
 * could turn a bar red at a level that sent no mail — and the fix was to move
 * the decision somewhere single. Same reasoning, one layer up.
 *
 * Nothing here re-derives anything the server already decided. `attention` and
 * `breached` arrive on the payload; these functions only combine them.
 */
import type { DeviceSummary, FleetSupplyDevice, Supply } from '../types.js';

/**
 * Conditions about paper, as the server labels them.
 *
 * Matched against `attentionReasons`, which carries the English labels from
 * server/src/devices/attention.ts — the classification is server-side and only
 * the wording is localised, so these are stable identifiers rather than display
 * text. A label this list does not know simply does not count as a paper
 * condition, which is the safe direction: it may still qualify as an error.
 */
const PAPER_CONDITIONS: ReadonlySet<string> = new Set([
  'Paper out',
  'Paper needed',
  'Paper low',
  'Tray empty',
  'Tray missing',
  'Paper jam',
  'Output tray full',
  'Output tray missing',
  'Output tray nearly full',
]);

export function hasPaperCondition(device: DeviceSummary): boolean {
  return device.attentionReasons.some((reason) => PAPER_CONDITIONS.has(reason));
}

/**
 * Whether a device belongs in "Action Required".
 *
 * Three things qualify: it cannot be reached, it reported a fault that stops it
 * printing, or it is short of paper. Supplies running low deliberately do not —
 * they have their own widget, and a cartridge at 12% is something to order, not
 * something to walk over to. Mixing the two makes the urgent list long enough
 * to stop being read.
 */
export function needsAction(device: DeviceSummary): boolean {
  return !device.isOnline || device.attention === 'error' || hasPaperCondition(device);
}

/**
 * Ordering for the action list: unreachable first, then faults, then paper.
 *
 * An unreachable device leads because nothing else reported about it can be
 * trusted — its last known state is by definition stale.
 */
export function actionSeverity(device: DeviceSummary): number {
  if (!device.isOnline) return 0;
  if (device.attention === 'error') return 1;
  return 2;
}

export function devicesNeedingAction(devices: readonly DeviceSummary[]): DeviceSummary[] {
  return devices
    .filter(needsAction)
    .sort(
      (a, b) =>
        actionSeverity(a) - actionSeverity(b) || a.displayName.localeCompare(b.displayName),
    );
}

/**
 * Where "critical" starts, for the re-order widget.
 *
 * Deliberately not the alert threshold. That one answers "should this page
 * someone at 3am", and an operator can set it to 5% if they like living
 * dangerously; this one answers "what should I put on the next order", which is
 * a purchasing question with a longer horizon. A supply can be critical here
 * and not breached, and that is the useful case — it is the warning before the
 * warning.
 */
export const CRITICAL_SUPPLY_PERCENT = 20;

/** One supply, carrying the device it belongs to. */
export interface FleetSupply {
  slug: string;
  deviceName: string;
  location: string | null;
  isOnline: boolean;
  supply: Supply;
  /** Never null: an unmeasurable supply cannot be ranked and is excluded. */
  percent: number;
}

/**
 * Consumables running low across the fleet, lowest first.
 *
 * Receptacles are excluded rather than inverted. A waste tank at 12% is 12%
 * *full*, which is the healthiest it gets — including it would put the emptiest
 * tank in the building at the top of a re-order list.
 *
 * Supplies with no number are excluded too. A device that declines to report a
 * level has not reported a low one, and a purchasing list is the last place to
 * start guessing.
 */
export function criticalSupplies(
  devices: readonly FleetSupplyDevice[],
  threshold: number = CRITICAL_SUPPLY_PERCENT,
): FleetSupply[] {
  const rows: FleetSupply[] = [];

  for (const device of devices) {
    for (const supply of device.supplies) {
      if (supply.kind !== 'consumable') continue;
      if (supply.percent === null || supply.percent >= threshold) continue;

      rows.push({
        slug: device.slug,
        deviceName: device.displayName,
        location: device.location,
        isOnline: device.isOnline,
        supply,
        percent: supply.percent,
      });
    }
  }

  return rows.sort(
    (a, b) => a.percent - b.percent || a.deviceName.localeCompare(b.deviceName),
  );
}
