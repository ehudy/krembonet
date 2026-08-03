/**
 * Where one device's alerts go — pure, no database and no network.
 *
 * The hub-wide destinations are the default and stay the default: a fleet is
 * configured once, not once per printer. What this adds is an override for the
 * handful of machines where "everyone on the IT list" is the wrong audience —
 * the second floor's plotter paging the second floor's support address, the
 * production room's press posting to the production room's channel.
 *
 * The override is opt-in in the most literal sense: an empty override is not an
 * instruction to send nowhere, it is the absence of an instruction, and the
 * global destinations apply. That asymmetry is deliberate. An operator who
 * clears a field expects to go back to the default, and a device that silently
 * stopped alerting because a field was blanked is the exact failure this whole
 * subsystem exists to prevent. Silencing a device is what the mute flags in
 * `mute.ts` are for, and they say so on the tin.
 */

/** The routing columns carried on a device row. */
export interface RoutingFields {
  /** Comma-separated addresses, or null when the device has no opinion. */
  alertEmailRecipients: string | null;
  /** JSON array of webhook ids, or null when the device has no opinion. */
  alertWebhookIds: string | null;
}

export interface DeviceRouting {
  /** Addresses this device overrides with. Empty means "use the global list". */
  emailRecipients: string[];
  /** Webhook ids this device restricts to. Empty means "use every enabled one". */
  webhookIds: number[];
}

/**
 * Splits an address list the way a person types one.
 *
 * Commas, semicolons and plain whitespace all separate, because every operator
 * has a different habit and none of them is wrong.
 */
export function parseRecipients(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  return raw
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** Deliberately permissive — enough to catch typos, not to police RFC 5322. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Normalises a submitted webhook selection to a stored id list.
 *
 * Anything that is not a positive integer is dropped rather than rejected: the
 * selection comes from a checkbox list generated from the destinations that
 * exist, so a stray value means a stale page, not an operator to argue with.
 */
export function parseWebhookIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];

  const ids = value
    .map((entry) =>
      typeof entry === 'number' ? entry : Number.parseInt(String(entry), 10),
    )
    .filter((id) => Number.isInteger(id) && id > 0);

  return [...new Set(ids)].sort((a, b) => a - b);
}

/** Reads the two stored columns into something the engine can act on. */
export function parseDeviceRouting(row: RoutingFields): DeviceRouting {
  let webhookIds: number[] = [];
  if (row.alertWebhookIds !== null && row.alertWebhookIds.trim() !== '') {
    try {
      webhookIds = parseWebhookIds(JSON.parse(row.alertWebhookIds));
    } catch {
      // A hand-edited or half-written blob costs this device its routing
      // override, not its alerts — the global destinations still apply.
      webhookIds = [];
    }
  }

  return {
    emailRecipients: parseRecipients(row.alertEmailRecipients),
    webhookIds,
  };
}

/** Serialises a selection for storage. Null when there is nothing to say. */
export function serializeWebhookIds(ids: readonly number[]): string | null {
  return ids.length === 0 ? null : JSON.stringify([...ids]);
}

/** Serialises an address list for storage. Null when there is nothing to say. */
export function serializeRecipients(recipients: readonly string[]): string | null {
  return recipients.length === 0 ? null : recipients.join(', ');
}

/** The device's own addresses when it has any, otherwise the hub's. */
export function resolveEmailRecipients(
  routing: DeviceRouting,
  globalRecipients: readonly string[],
): string[] {
  return routing.emailRecipients.length > 0
    ? [...routing.emailRecipients]
    : [...globalRecipients];
}

/**
 * The enabled destinations this device routes to.
 *
 * A selection is filtered against what actually exists, so a webhook deleted
 * out from under a device narrows its routing rather than breaking dispatch.
 * If every selected destination has gone the result is empty, which is the
 * honest answer — the operator picked destinations, and none of them are there.
 * Webhook deletion prunes the ids it leaves behind (see webhooks.ts), so this
 * only arises for a row edited outside the portal.
 */
export function resolveWebhookTargets<T extends { id: number }>(
  routing: DeviceRouting,
  enabled: readonly T[],
): T[] {
  if (routing.webhookIds.length === 0) return [...enabled];

  const selected = new Set(routing.webhookIds);
  return enabled.filter((target) => selected.has(target.id));
}
