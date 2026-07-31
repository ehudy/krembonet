/**
 * Webhook payload shaping.
 *
 * These assert the parts each receiver actually rejects or silently drops:
 * Discord 400s on an over-length embed description, Slack pushes a silent
 * notification when `text` is missing, and ntfy takes the message as the body
 * with everything else in headers rather than as JSON. All three fail in ways
 * that look like "alerts just stopped working" months later.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildWebhookRequest,
  isWebhookFormat,
  WEBHOOK_FORMATS,
  type WebhookNotification,
} from '../src/alerts/webhook-format.js';

const NOTIFICATION: WebhookNotification = {
  event: 'alert',
  hubTitle: 'KremboNet',
  subject: '[KremboNet] Matte Black needs attention',
  text: 'Test Plotter (printer.example) has supplies past their alert threshold:\n\n  - Matte Black is at 10%',
  deviceName: 'Test Plotter',
  deviceHost: 'printer.example',
  lines: ['Matte Black is at 10% (alerts at 15%)', 'Maintenance Cartridge is 90% full'],
  url: 'http://hub.lan:3000/devices/plotter',
};

const parse = (
  format: Parameters<typeof buildWebhookRequest>[0],
): Record<string, unknown> =>
  JSON.parse(buildWebhookRequest(format, NOTIFICATION).body) as Record<string, unknown>;

describe('format registry', () => {
  it('recognises exactly the four supported formats', () => {
    assert.deepEqual([...WEBHOOK_FORMATS], ['discord', 'slack', 'ntfy', 'generic']);
    for (const format of WEBHOOK_FORMATS) assert.equal(isWebhookFormat(format), true);
  });

  it('rejects anything else, so a hand-edited row degrades rather than crashing', () => {
    for (const value of ['teams', '', null, undefined, 42]) {
      assert.equal(isWebhookFormat(value), false);
    }
  });

  it('produces valid JSON for every JSON format', () => {
    for (const format of ['discord', 'slack', 'generic'] as const) {
      assert.doesNotThrow(() => parse(format), `${format} produced unparseable JSON`);
    }
  });
});

describe('discord', () => {
  it('sends one embed carrying the subject and every supply line', () => {
    const body = parse('discord') as { embeds: { title: string; description: string }[] };
    const embed = body.embeds[0] as { title: string; description: string };

    assert.equal(embed.title, NOTIFICATION.subject);
    for (const line of NOTIFICATION.lines) {
      assert.ok(embed.description.includes(line), `missing: ${line}`);
    }
  });

  it('clips a description that would be rejected as too long', () => {
    // Discord 400s past 4096, which surfaces as a silently missing alert on the
    // one device with fourteen supplies.
    const many: WebhookNotification = {
      ...NOTIFICATION,
      lines: Array.from(
        { length: 400 },
        (_, i) => `Supply ${i} is at 4% (alerts at 15%)`,
      ),
    };
    const body = JSON.parse(buildWebhookRequest('discord', many).body) as {
      embeds: { description: string }[];
    };

    assert.ok((body.embeds[0] as { description: string }).description.length <= 4096);
  });

  it('colours an alert differently from a test', () => {
    const alert = parse('discord') as { embeds: { color: number }[] };
    const test = JSON.parse(
      buildWebhookRequest('discord', { ...NOTIFICATION, event: 'test' }).body,
    ) as { embeds: { color: number }[] };

    assert.notEqual(
      (alert.embeds[0] as { color: number }).color,
      (test.embeds[0] as { color: number }).color,
    );
  });

  it('posts JSON', () => {
    assert.equal(
      buildWebhookRequest('discord', NOTIFICATION).headers['content-type'],
      'application/json',
    );
  });
});

describe('slack', () => {
  it('always sets top-level text, which is the push preview and the fallback', () => {
    // Omitting it produces a notification with no content on mobile.
    const body = parse('slack') as { text: string };
    assert.ok(typeof body.text === 'string' && body.text.length > 0);
  });

  it('renders the supply lines in a block', () => {
    const body = parse('slack') as {
      blocks: { type: string; text?: { text: string } }[];
    };
    const rendered = JSON.stringify(body.blocks);

    for (const line of NOTIFICATION.lines) assert.ok(rendered.includes(line));
  });
});

describe('ntfy', () => {
  it('sends the message as the body, not as JSON', () => {
    const { body, headers } = buildWebhookRequest('ntfy', NOTIFICATION);

    assert.ok(body.includes('Matte Black is at 10%'));
    assert.match(headers['content-type'] as string, /text\/plain/);
    assert.doesNotMatch(body, /^\{/, 'ntfy received a JSON body');
  });

  it('puts the title and priority in headers', () => {
    const { headers } = buildWebhookRequest('ntfy', NOTIFICATION);

    assert.ok((headers['Title'] as string).includes('needs attention'));
    assert.equal(headers['Priority'], 'high');
    assert.equal(headers['Click'], NOTIFICATION.url);
  });

  it('folds characters a header cannot carry', () => {
    // `fetch` throws on a non-latin-1 header value, which would turn a device
    // named with a curly apostrophe into a failed alert rather than a plain one.
    const { headers } = buildWebhookRequest('ntfy', {
      ...NOTIFICATION,
      subject: 'Plotter — ‘ink’ low ✅',
    });

    const title = headers['Title'] as string;
    for (const code of [...title].map((char) => char.codePointAt(0) ?? 0)) {
      assert.ok(code >= 0x20 && code <= 0xff, `header carried U+${code.toString(16)}`);
    }

    // Transliterated rather than merely dropped: stripping the dash and quotes
    // would leave "Plotter  ink low" with the gaps still in it.
    assert.equal(title, "Plotter - 'ink' low");
  });

  it('lowers the priority for a test', () => {
    const { headers } = buildWebhookRequest('ntfy', { ...NOTIFICATION, event: 'test' });
    assert.equal(headers['Priority'], 'default');
  });
});

describe('generic', () => {
  it('exposes the facts as fields rather than only as prose', () => {
    const body = parse('generic') as {
      event: string;
      hub: string;
      device: { name: string; host: string };
      supplies: string[];
    };

    assert.equal(body.event, 'alert');
    assert.equal(body.hub, 'KremboNet');
    assert.deepEqual(body.device, { name: 'Test Plotter', host: 'printer.example' });
    assert.deepEqual(body.supplies, NOTIFICATION.lines);
  });
});

describe('a notification with no supply lines', () => {
  it('falls back to the text body rather than sending an empty message', () => {
    // This is what the portal's test button produces.
    const test: WebhookNotification = {
      ...NOTIFICATION,
      event: 'test',
      lines: [],
      text: 'This is a test notification.',
    };

    for (const format of WEBHOOK_FORMATS) {
      const { body } = buildWebhookRequest(format, test);
      assert.ok(body.includes('This is a test notification.'), `${format} lost the body`);
    }
  });
});

describe('an omitted url', () => {
  it('is left out entirely rather than sent as null or empty', () => {
    const { url: _dropped, ...withoutUrl } = NOTIFICATION;

    const discord = JSON.parse(buildWebhookRequest('discord', withoutUrl).body) as {
      embeds: Record<string, unknown>[];
    };
    assert.ok(!('url' in (discord.embeds[0] as Record<string, unknown>)));

    const { headers } = buildWebhookRequest('ntfy', withoutUrl);
    assert.ok(!('Click' in headers));
  });
});
