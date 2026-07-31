/**
 * Webhook payload shaping — pure, no network and no database.
 *
 * Every destination here takes the same thing (an HTTPS POST) and differs only
 * in the body it will accept, so the format is the only variable. Keeping the
 * shaping separate from the sending means the awkward part — what Discord calls
 * an embed and Slack calls a block, and the fact that ntfy wants headers rather
 * than JSON at all — is testable without a server to post at.
 *
 * Field limits are enforced here rather than left to the receiver. A Discord
 * embed description over 4096 characters is rejected with a 400, which would
 * surface as "the alert silently stopped working" on the one device with
 * fourteen supplies.
 */

export type WebhookFormat = 'discord' | 'slack' | 'ntfy' | 'generic';

export const WEBHOOK_FORMATS: readonly WebhookFormat[] = [
  'discord',
  'slack',
  'ntfy',
  'generic',
];

export function isWebhookFormat(value: unknown): value is WebhookFormat {
  return WEBHOOK_FORMATS.includes(value as WebhookFormat);
}

/** Operator-facing labels, so the portal and the API agree on naming. */
export const WEBHOOK_FORMAT_LABELS: Record<WebhookFormat, string> = {
  discord: 'Discord',
  slack: 'Slack (or Mattermost)',
  ntfy: 'ntfy.sh',
  generic: 'Generic JSON POST',
};

/** What happened, in a shape every format can render. */
export interface WebhookNotification {
  /** `alert` is a real threshold crossing; `test` is the portal's test button. */
  event: 'alert' | 'test';
  hubTitle: string;
  subject: string;
  /** The plain-text body, identical to what the email carries. */
  text: string;
  deviceName: string;
  deviceHost: string;
  /** One line per supply that crossed, already phrased for a human. */
  lines: string[];
  /** Link back to the device page, when the hub knows its own address. */
  url?: string | null;
}

export interface WebhookRequest {
  body: string;
  headers: Record<string, string>;
}

/** Amber for a real alert, blue-grey for a test. Discord takes a decimal int. */
const DISCORD_COLOR = { alert: 0xf59e0b, test: 0x64748b } as const;

/** Discord rejects an embed whose description runs past this. */
const DISCORD_DESCRIPTION_LIMIT = 4096;
const DISCORD_TITLE_LIMIT = 256;

/** Slack truncates rather than rejecting, but a clipped alert reads as a bug. */
const SLACK_TEXT_LIMIT = 3000;

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

function bulleted(notification: WebhookNotification): string {
  // Falls back to the full text for a test, which has no supply lines.
  if (notification.lines.length === 0) return notification.text;
  return notification.lines.map((line) => `• ${line}`).join('\n');
}

function discordBody(notification: WebhookNotification): string {
  return JSON.stringify({
    username: notification.hubTitle,
    embeds: [
      {
        title: clip(notification.subject, DISCORD_TITLE_LIMIT),
        description: clip(bulleted(notification), DISCORD_DESCRIPTION_LIMIT),
        color: DISCORD_COLOR[notification.event],
        ...(notification.url != null && notification.url !== ''
          ? { url: notification.url }
          : {}),
        fields: [
          { name: 'Device', value: notification.deviceName, inline: true },
          { name: 'Address', value: notification.deviceHost, inline: true },
        ],
        footer: { text: notification.hubTitle },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

function slackBody(notification: WebhookNotification): string {
  return JSON.stringify({
    // `text` is both the notification preview and the fallback for any client
    // that cannot render blocks. Omitting it produces a silent push.
    text: clip(notification.subject, SLACK_TEXT_LIMIT),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: clip(notification.subject, 150), emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: clip(bulleted(notification), SLACK_TEXT_LIMIT) },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${notification.deviceName} · \`${notification.deviceHost}\` · ${notification.hubTitle}`,
          },
        ],
      },
    ],
  });
}

/**
 * ntfy takes the message as the raw request body and everything else as
 * headers — no JSON at all. Header values must be latin-1, so the title is
 * stripped of anything outside it rather than sent and rejected.
 */
function ntfyHeaders(notification: WebhookNotification): Record<string, string> {
  return {
    'content-type': 'text/plain; charset=utf-8',
    Title: latin1(clip(notification.subject, 250)),
    Priority: notification.event === 'alert' ? 'high' : 'default',
    Tags: notification.event === 'alert' ? 'warning,printer' : 'white_check_mark',
    ...(notification.url != null && notification.url !== ''
      ? { Click: notification.url }
      : {}),
  };
}

/**
 * Folds a string down to what an HTTP header can carry.
 *
 * `fetch` throws on a header value outside latin-1, so this cannot simply pass
 * text through. Dropping the offending characters is not enough either: hub
 * titles and alert subjects are full of typographic punctuation, and a subject
 * built as `Hub \u2014 webhook test` would arrive as "Hub  webhook test" with a
 * conspicuous double space. Common punctuation is transliterated first, and
 * only what survives that is dropped.
 *
 * Written with escapes rather than literals so this file stays ASCII.
 */
const TRANSLITERATIONS: [RegExp, string][] = [
  [/[\u2010-\u2015]/g, '-'],
  [/[\u2018\u2019\u201b]/g, "'"],
  [/[\u201c\u201d\u201f]/g, '"'],
  [/\u2026/g, '...'],
  [/\u00a0/g, ' '],
];

function latin1(value: string): string {
  let folded = value;
  for (const [pattern, replacement] of TRANSLITERATIONS) {
    folded = folded.replace(pattern, replacement);
  }

  return (
    folded
      .replace(/[^\u0020-\u00ff]/g, '')
      // Emoji and the like leave a gap behind; collapsing keeps the result from
      // reading as a typo.
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}

function genericBody(notification: WebhookNotification): string {
  return JSON.stringify({
    event: notification.event,
    hub: notification.hubTitle,
    subject: notification.subject,
    device: { name: notification.deviceName, host: notification.deviceHost },
    supplies: notification.lines,
    text: notification.text,
    ...(notification.url != null && notification.url !== ''
      ? { url: notification.url }
      : {}),
    timestamp: new Date().toISOString(),
  });
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/** Shapes a notification for one destination. */
export function buildWebhookRequest(
  format: WebhookFormat,
  notification: WebhookNotification,
): WebhookRequest {
  switch (format) {
    case 'discord':
      return { body: discordBody(notification), headers: { ...JSON_HEADERS } };
    case 'slack':
      return { body: slackBody(notification), headers: { ...JSON_HEADERS } };
    case 'ntfy':
      return {
        body:
          notification.lines.length === 0 ? notification.text : bulleted(notification),
        headers: ntfyHeaders(notification),
      };
    case 'generic':
      return { body: genericBody(notification), headers: { ...JSON_HEADERS } };
  }
}
