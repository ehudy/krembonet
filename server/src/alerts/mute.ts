/**
 * Maintenance mode — pure, no I/O.
 *
 * One switch per device, and it means one thing: while it is on, no alert rule
 * fires for this printer. It is for the machine with its lid off on a bench, or
 * the one being tested, where every condition it reports is something a person
 * is standing next to and already knows about.
 *
 * Suppression silences *notification*, never measurement. A muted device is
 * still polled, still evaluated against the hub's thresholds, still shown as
 * failing on the dashboard, and its withheld alerts are still written to
 * `alert_logs` marked `muted` rather than vanishing. That distinction is the
 * whole design: a "mute" that also stopped monitoring would mean a printer put
 * into maintenance in March is silently unmonitored in September, and nobody
 * would know until someone walked past it.
 *
 * This used to be four switches — maintenance mode plus one per category. The
 * three category switches went when notification became rule-driven: "mute
 * supply alerts for this printer" is now something you express by scoping a
 * rule, in the one place all the other routing decisions live, rather than by a
 * flag on the device that silently overrode it from somewhere else.
 *
 * Alert *state* is still recorded while muted, which has a consequence worth
 * stating: a supply that crosses its threshold during a mute, and is still
 * across it when the mute is lifted, does not then fire. The condition never
 * transitioned — it was already true — and the dashboard has been showing it the
 * whole time. Re-announcing old news on unmute would be the surprising
 * behaviour, not this.
 */

/** The suppression flag carried on a device row. */
export interface MuteFlags {
  /** Maintenance mode: no rule fires for this device while it is set. */
  isMuted: boolean;
}

/** Why a notification was withheld, or null when it was not. */
export type SuppressionReason = 'maintenance' | null;

export function suppressionReason(flags: MuteFlags): SuppressionReason {
  return flags.isMuted ? 'maintenance' : null;
}

export function isSuppressed(flags: MuteFlags): boolean {
  return suppressionReason(flags) !== null;
}
