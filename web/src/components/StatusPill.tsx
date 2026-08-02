/**
 * The one-phrase summary of what is wrong with a device.
 *
 * Shared rather than written per page: the Overview, the devices table and the
 * action list all show this, and three copies of the precedence order is how
 * one of them ends up calling a jammed printer "Healthy" — which is exactly
 * what happened before the checks were ordered by what stops a job soonest.
 *
 * Order is unreachable, then a device-reported fault, then a supply past its
 * threshold, then a lesser fault. Nothing here re-derives severity; `attention`
 * is decided server-side by the same code that decides whether to send mail.
 */
import { CircleAlert, CircleCheck, TriangleAlert, WifiOff } from 'lucide-react';

import { useTranslation, type Translate } from '../i18n/i18n.js';
import type { DeviceSummary } from '../types.js';

/** Sized so the icon never outweighs the label beside it. */
const PILL_ICON = { size: 13, strokeWidth: 2, 'aria-hidden': true } as const;

/**
 * The headline condition, localised.
 *
 * The server sends English condition labels; they are looked up here so the
 * classification stays server-side and only the wording is translated. An
 * unmapped label falls through to itself, which is readable.
 */
export function attentionText(device: DeviceSummary, t: Translate): string {
  const [first, ...rest] = device.attentionReasons;
  if (first === undefined) return t('overview.needsAttention');

  const label = t(`attention.${first}`);
  return rest.length === 0 ? label : t('attention.more', { label, count: rest.length });
}

/** Every condition, for a tooltip. Empty when the device reported none. */
function conditionsTitle(device: DeviceSummary, t: Translate): string | undefined {
  if (device.attentionReasons.length === 0) return undefined;
  return device.attentionReasons.map((reason) => t(`attention.${reason}`)).join(', ');
}

export function StatusPill({ device }: { device: DeviceSummary }) {
  const { t } = useTranslation();

  if (!device.isOnline) {
    return (
      <span className="pill is-bad">
        <WifiOff {...PILL_ICON} />
        {t('overview.unreachable')}
      </span>
    );
  }

  if (device.attention === 'error') {
    return (
      <span className="pill is-bad" title={conditionsTitle(device, t)}>
        <CircleAlert {...PILL_ICON} />
        {attentionText(device, t)}
      </span>
    );
  }

  if (device.lowSupplies > 0) {
    return (
      <span className="pill is-warn">
        <TriangleAlert {...PILL_ICON} />
        {t('overview.suppliesLowPill', { count: device.lowSupplies })}
      </span>
    );
  }

  if (device.attention === 'warning') {
    return (
      <span className="pill is-warn" title={conditionsTitle(device, t)}>
        <TriangleAlert {...PILL_ICON} />
        {attentionText(device, t)}
      </span>
    );
  }

  return (
    <span className="pill is-good">
      <CircleCheck {...PILL_ICON} />
      {t('overview.healthy')}
    </span>
  );
}
