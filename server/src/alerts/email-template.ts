/**
 * Branded HTML email bodies — pure, no database, no settings, no I/O.
 *
 * Everything the templates need is passed in, so the whole thing is testable
 * against fixed input the way `rules.ts` and `reachability.ts` are. The engine
 * and the mailer are the only callers, and they supply the branding, the device
 * facts, and whether there is an app URL to link to.
 *
 * Two constraints shape every choice here:
 *
 *  - **Self-contained.** Printers and the hub often sit on an isolated VLAN the
 *    recipient of an alert cannot reach, so the mail has to carry every fact
 *    needed to act — name, model, location, address, and what is wrong — in the
 *    body itself. The link back to the hub is a convenience, never the point,
 *    and is omitted entirely when the hub has no reachable URL.
 *  - **Email HTML, not web HTML.** Mail clients strip `<head>` styles, ignore
 *    flexbox, and disagree about everything else, so layout is tables and styles
 *    are inline on each element. The one `<style>` block carries a mobile media
 *    query only, as progressive enhancement over an already-working inline base.
 */

export interface EmailBranding {
  /** Organisation / hub name, used as the header text when there is no logo. */
  hubTitle: string;
  /**
   * Content-ID of the logo attached to this message, or null when there is no
   * usable logo. Non-null means the caller has attached the bytes and the header
   * can reference them as `cid:<logoCid>`; null renders a text header, never a
   * broken `<img>`. The logo is never an external URL — see `logo-attachment.ts`.
   */
  logoCid: string | null;
}

export interface AlertDevice {
  name: string;
  model: string | null;
  location: string | null;
  /** The device's address, shown as "IP Address" in the card. */
  host: string;
}

export type AlertSeverity = 'warning' | 'critical';

export interface AlertEmailInput {
  branding: EmailBranding;
  severity: AlertSeverity;
  /** The one-line summary, e.g. "Magenta Toner is low (1%)". */
  headline: string;
  /** Every condition this message covers; the card lists them all. */
  details: string[];
  device: AlertDevice;
  /** The device page on the hub, or null when no app URL is configured. */
  actionUrl: string | null;
  timestamp: Date;
}

/**
 * The worst severity among a batch of conditions.
 *
 * A running-low consumable is a warning — someone should reorder, nothing has
 * stopped. Everything else here has stopped the device or is about to: a full
 * waste tank halts printing, an empty tray halts printing, and an offline device
 * is not printing at all. A message that batches a warning and a critical takes
 * the critical: the reader needs the higher of the two, not the average.
 */
export function alertSeverity(observationTypes: readonly string[]): AlertSeverity {
  return observationTypes.every((type) => type === 'supply_low') ? 'warning' : 'critical';
}

const SEVERITY: Record<AlertSeverity, { label: string; bg: string; text: string }> = {
  warning: { label: 'Warning', bg: '#b45309', text: '#ffffff' },
  critical: { label: 'Critical', bg: '#b91c1c', text: '#ffffff' },
};

// A single light palette. Email dark-mode handling is inconsistent across
// clients, so a transactional mail commits to one legible look rather than
// chasing a theme it cannot reliably detect.
const COLOR = {
  page: '#f4f4f5',
  surface: '#ffffff',
  border: '#e4e4e7',
  text: '#18181b',
  muted: '#71717a',
  faint: '#a1a1aa',
  accent: '#2563eb',
  accentText: '#ffffff',
};

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const escapes: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes for both text nodes and double-quoted attribute values. */
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => escapes[char] as string);
}

/** One label/value row of the device card. */
function cardRow(label: string, valueHtml: string): string {
  return `
        <tr>
          <td style="padding:10px 16px;border-top:1px solid ${COLOR.border};vertical-align:top;width:120px;color:${COLOR.muted};font-size:13px;">${esc(
            label,
          )}</td>
          <td style="padding:10px 16px;border-top:1px solid ${COLOR.border};vertical-align:top;color:${COLOR.text};font-size:14px;font-weight:600;">${valueHtml}</td>
        </tr>`;
}

/**
 * A table-based "bulletproof" button.
 *
 * A styled `<a>` alone collapses to unstyled blue text in Outlook; wrapping it
 * in a table cell with the background and radius on the cell is what survives.
 */
function actionButton(url: string, label: string): string {
  return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 4px;">
        <tr>
          <td align="center" style="border-radius:6px;background:${COLOR.accent};">
            <a href="${esc(
              url,
            )}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:14px;font-weight:600;line-height:1;color:${COLOR.accentText};text-decoration:none;border-radius:6px;">${esc(
              label,
            )}</a>
          </td>
        </tr>
      </table>`;
}

/** Header, body, footer — the frame every message shares. */
function documentShell(options: {
  branding: EmailBranding;
  timestamp: Date;
  bodyHtml: string;
  footerNote: string | null;
}): string {
  const { branding, timestamp, bodyHtml, footerNote } = options;

  // The image is referenced by Content-ID, so it is only ever rendered when the
  // caller has actually attached the bytes. With no logo we emit a styled text
  // header and no `<img>` at all — a broken image with alt text is precisely the
  // failure this whole change exists to remove.
  const header =
    branding.logoCid !== null
      ? `<img src="cid:${esc(
          branding.logoCid,
        )}" alt="${esc(branding.hubTitle)}" height="32" style="max-height:32px;border:0;line-height:1;" />`
      : `<h1 style="margin:0;font-size:18px;font-weight:700;line-height:1.2;color:${COLOR.text};">${esc(
          branding.hubTitle,
        )}</h1>`;

  const footerLines = [
    esc(branding.hubTitle),
    esc(timestamp.toLocaleString()),
    ...(footerNote !== null ? [esc(footerNote)] : []),
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <title>${esc(branding.hubTitle)}</title>
  <style>
    @media only screen and (max-width: 600px) {
      .email-container { width: 100% !important; }
      .email-pad { padding-left: 20px !important; padding-right: 20px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${COLOR.page};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLOR.page};">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" class="email-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${COLOR.surface};border:1px solid ${COLOR.border};border-radius:10px;overflow:hidden;">
          <tr>
            <td class="email-pad" style="padding:20px 28px;border-bottom:1px solid ${COLOR.border};">${header}</td>
          </tr>
          <tr>
            <td class="email-pad" style="padding:28px;font-family:${FONT};color:${COLOR.text};">${bodyHtml}</td>
          </tr>
          <tr>
            <td class="email-pad" style="padding:18px 28px;border-top:1px solid ${COLOR.border};font-family:${FONT};font-size:12px;line-height:1.6;color:${COLOR.faint};">
              ${footerLines.join(' &middot; ')}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * A branded, self-contained alert email.
 *
 * The action button is present only when `actionUrl` is set — on an isolated
 * VLAN there is nothing for it to point at, and a dead button reads as a broken
 * mail. Everything needed to act without it is in the card above.
 */
export function renderAlertEmail(input: AlertEmailInput): string {
  const badge = SEVERITY[input.severity];

  const deviceValue =
    input.device.model !== null && input.device.model !== ''
      ? `${esc(input.device.name)}<div style="font-weight:400;color:${COLOR.muted};font-size:13px;margin-top:2px;">${esc(
          input.device.model,
        )}</div>`
      : esc(input.device.name);

  const detailValue =
    input.details.length <= 1
      ? esc(input.details[0] ?? input.headline)
      : input.details.map((line) => esc(line)).join(`<br />`);

  const card = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${COLOR.border};border-radius:8px;border-collapse:separate;overflow:hidden;">
        <tr>
          <td style="padding:10px 16px;vertical-align:top;width:120px;color:${COLOR.muted};font-size:13px;">Device</td>
          <td style="padding:10px 16px;vertical-align:top;color:${COLOR.text};font-size:14px;font-weight:600;">${deviceValue}</td>
        </tr>${cardRow('Location', esc(input.device.location ?? '—'))}${cardRow(
          'IP Address',
          esc(input.device.host),
        )}${cardRow('Alert Detail', detailValue)}
      </table>`;

  const body = `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
        <tr><td style="border-radius:4px;background:${badge.bg};padding:4px 10px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${badge.text};">${esc(
          badge.label,
        )}</td></tr>
      </table>
      <div style="font-size:18px;font-weight:700;line-height:1.35;color:${COLOR.text};margin:0 0 20px;">${esc(
        input.headline,
      )}</div>
      ${card}
      ${input.actionUrl !== null ? actionButton(input.actionUrl, 'Open Device in Krembonet') : ''}`;

  return documentShell({
    branding: input.branding,
    timestamp: input.timestamp,
    bodyHtml: body,
    footerNote: 'Manage alert preferences in Admin → Alert Rules',
  });
}

export interface TestEmailInput {
  branding: EmailBranding;
  timestamp: Date;
}

/** The branded confirmation sent by the "send test email" button. */
export function renderTestEmail(input: TestEmailInput): string {
  const body = `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
        <tr><td style="border-radius:4px;background:#15803d;padding:4px 10px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#ffffff;">Success</td></tr>
      </table>
      <div style="font-size:18px;font-weight:700;line-height:1.35;color:${COLOR.text};margin:0 0 16px;">SMTP Configuration Successful</div>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${COLOR.text};">This is a test message confirming that Krembonet's email delivery settings are configured correctly.</p>
      <p style="margin:0;font-size:14px;line-height:1.6;color:${COLOR.text};"><strong>Next Step:</strong> To set up automated notifications for low supply levels, waste containers, paper jams, or offline status, go to <strong>Admin → Alert Rules</strong>.</p>`;

  return documentShell({
    branding: input.branding,
    timestamp: input.timestamp,
    bodyHtml: body,
    footerNote: null,
  });
}
