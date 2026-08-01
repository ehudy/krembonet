/**
 * Per-device alert suppression — pure, no I/O.
 *
 * Suppression silences *notification*, never measurement. A muted device is
 * still polled, still evaluated against its thresholds, still shown as failing
 * on the dashboard, and its alerts are still written to `alert_logs` — marked
 * `muted` rather than `sent`. What stops is the email and the webhook.
 *
 * That distinction is the whole design. "Mute" that also stopped monitoring
 * would mean a printer put into maintenance mode in March is silently
 * unmonitored in September, and nobody would know until someone walked past
 * it. Here the dashboard keeps telling the truth; only the 3am mail stops.
 *
 * Alert *state* is still recorded while muted, which has a consequence worth
 * stating: a supply that crosses its threshold during a mute, and is still
 * across it when the mute is lifted, does not then fire. The condition never
 * transitioned — it was already true — and the dashboard has been showing it
 * the whole time. Re-announcing old news on unmute would be the surprising
 * behaviour, not this.
 */

/** The three things this hub can alert about. */
export type AlertCategory = 'supply' | 'media' | 'offline';

export const ALERT_CATEGORIES: readonly AlertCategory[] = ['supply', 'media', 'offline'];

/** The suppression flags carried on a device row. */
export interface MuteFlags {
  /** Maintenance mode: every category at once. */
  isMuted: boolean;
  muteSupplyAlerts: boolean;
  muteMediaAlerts: boolean;
  muteOfflineAlerts: boolean;
}

const CATEGORY_FLAG: Record<AlertCategory, keyof MuteFlags> = {
  supply: 'muteSupplyAlerts',
  media: 'muteMediaAlerts',
  offline: 'muteOfflineAlerts',
};

/** Why a notification was withheld, or null when it was not. */
export type SuppressionReason = 'maintenance' | 'category' | null;

export function suppressionReason(
  flags: MuteFlags,
  category: AlertCategory,
): SuppressionReason {
  // Maintenance mode is reported ahead of the per-category flag so the log says
  // *why* — "the whole device is muted" and "supply alerts are muted" send an
  // operator to different switches.
  if (flags.isMuted) return 'maintenance';
  return flags[CATEGORY_FLAG[category]] ? 'category' : null;
}

export function isSuppressed(flags: MuteFlags, category: AlertCategory): boolean {
  return suppressionReason(flags, category) !== null;
}

/**
 * True when anything at all is muted.
 *
 * Drives the indicator on a device card: the point is that an operator
 * scanning a wall of cards can see which ones will not shout, without opening
 * each one to find out which switch is set.
 */
export function hasAnySuppression(flags: MuteFlags): boolean {
  return (
    flags.isMuted ||
    flags.muteSupplyAlerts ||
    flags.muteMediaAlerts ||
    flags.muteOfflineAlerts
  );
}

/** Categories currently silenced, for a tooltip or the detail view. */
export function suppressedCategories(flags: MuteFlags): AlertCategory[] {
  if (flags.isMuted) return [...ALERT_CATEGORIES];
  return ALERT_CATEGORIES.filter((category) => flags[CATEGORY_FLAG[category]]);
}
