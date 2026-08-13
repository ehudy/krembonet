/**
 * Deciding when a device counts as offline — pure, no I/O.
 *
 * A single failed poll is not an outage. Printers sleep, DHCP leases lapse, a
 * switch reboots, someone unplugs the network cable to hoover. Alerting on the
 * first failure produces a stream of "offline"/"recovered" pairs that trains
 * everyone to filter the sender, which is worse than not alerting at all.
 *
 * So the threshold is two *consecutive* failures, and both directions are
 * edge-triggered: the alert fires on the transition, not on every poll where
 * the device happens to still be down. That is the same rule supply alerts
 * follow, and for the same reason.
 */

/**
 * Consecutive failures before a device is called offline.
 *
 * Shared with the poller, which applies the same threshold to the `is_online`
 * column — see `persistFailure`. One constant rather than two so the state the
 * dashboard renders and the state that sends an email cannot disagree about
 * whether a device is down.
 */
export const OFFLINE_AFTER_FAILURES = 2;

export type ReachabilityTransition = 'offline' | 'recovered' | null;

export interface ReachabilityInput {
  /** Failures recorded so far, including the one that just happened. */
  consecutiveFailures: number;
  /** Whether the poll that just ran succeeded. */
  succeeded: boolean;
  /** Whether an offline alert is currently outstanding for this device. */
  isOfflineAlertActive: boolean;
}

/**
 * Returns the transition to announce, or null when nothing changed.
 *
 * The four states this collapses:
 *
 *  - failing, past the threshold, not yet announced → `offline`
 *  - failing, already announced                     → null (silence)
 *  - failing, below the threshold                   → null (still a blip)
 *  - succeeding, an alert was outstanding           → `recovered`
 *  - succeeding, nothing outstanding                → null (normal life)
 */
export function decideReachability(input: ReachabilityInput): ReachabilityTransition {
  if (input.succeeded) {
    return input.isOfflineAlertActive ? 'recovered' : null;
  }

  if (input.isOfflineAlertActive) return null;
  return input.consecutiveFailures >= OFFLINE_AFTER_FAILURES ? 'offline' : null;
}

/**
 * Whether a device that has just failed a poll should still be recorded online.
 *
 * The same threshold as the alert, applied to the stored `is_online` column, so
 * the dashboard and the mail agree about when a device is down. Without it the
 * column flipped on the first failed cycle: a plotter waking from deep sleep
 * showed as unreachable for one cycle and recovered on the next, which is the
 * "offline/recovered" churn the alert threshold exists to prevent — just
 * rendered on a screen instead of mailed.
 *
 * `wasOnline` gates the grace cycle so it can only ever preserve a reachable
 * device's status, never invent one. A device that was already offline stays
 * offline, and a device that has never been reached at all — no status row, so
 * `wasOnline` is false — does not spend its first-ever failed poll pretending
 * otherwise.
 */
export function remainsOnlineAfterFailure(input: {
  wasOnline: boolean;
  /** Failures recorded so far, including the one that just happened. */
  consecutiveFailures: number;
}): boolean {
  return input.wasOnline && input.consecutiveFailures < OFFLINE_AFTER_FAILURES;
}

/** One rule key per device, so offline state cannot collide with a supply. */
export function offlineRuleKey(deviceSlug: string): string {
  return `device:${deviceSlug}:offline`;
}

export interface ReachabilityMessage {
  subject: string;
  text: string;
  lines: string[];
}

export function buildOfflineMail(
  device: { displayName: string; host: string },
  hubTitle: string,
  consecutiveFailures: number,
  lastError: string | null,
  lastSuccessAt: string | null,
): ReachabilityMessage {
  const lines = [
    `${device.displayName} (${device.host}) has not responded to ${consecutiveFailures} consecutive polls.`,
    ...(lastError !== null ? [`Last error: ${lastError}`] : []),
    ...(lastSuccessAt !== null ? [`Last successful reading: ${lastSuccessAt}`] : []),
  ];

  return {
    subject: `[${hubTitle}] ${device.displayName} is offline`,
    lines,
    text: [
      ...lines,
      '',
      'You will get one more message when it comes back, and nothing in between.',
    ].join('\n'),
  };
}

export function buildRecoveryMail(
  device: { displayName: string; host: string },
  hubTitle: string,
  downSince: string | null,
): ReachabilityMessage {
  const lines = [
    `${device.displayName} (${device.host}) is responding again.`,
    ...(downSince !== null ? [`It was unreachable since ${downSince}.`] : []),
  ];

  return {
    subject: `[${hubTitle}] ${device.displayName} is back online`,
    lines,
    text: lines.join('\n'),
  };
}
