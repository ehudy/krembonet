/**
 * The branded HTML email bodies.
 *
 * These assert the promises the templates make to someone who cannot reach the
 * hub: the message carries every device fact on its own, the link back is there
 * only when there is somewhere for it to point, and nothing a device reports —
 * a name, a model, a fault string — can break out of the markup it lands in.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  alertSeverity,
  renderAlertEmail,
  renderTestEmail,
  type AlertEmailInput,
} from '../src/alerts/email-template.js';

const BASE: AlertEmailInput = {
  branding: { hubTitle: 'Acme Print', logoUrl: '' },
  severity: 'warning',
  headline: 'Magenta Toner is low (1%)',
  details: ['Magenta Toner is low (1%)'],
  device: {
    name: 'Front Desk MFP',
    model: 'SHARP BP-71C45',
    location: '2nd Floor — Main Office',
    host: '10.0.4.21',
  },
  actionUrl: null,
  timestamp: new Date('2026-08-10T14:30:00Z'),
};

function alert(overrides: Partial<AlertEmailInput> = {}): string {
  return renderAlertEmail({ ...BASE, ...overrides });
}

describe('alertSeverity', () => {
  it('is a warning only when every condition is a low supply', () => {
    assert.equal(alertSeverity(['supply_low']), 'warning');
    assert.equal(alertSeverity(['supply_low', 'supply_low']), 'warning');
  });

  it('is critical for a stopped or offline device', () => {
    assert.equal(alertSeverity(['offline']), 'critical');
    assert.equal(alertSeverity(['waste_full']), 'critical');
    assert.equal(alertSeverity(['media_out']), 'critical');
  });

  it('takes the critical when a batch mixes both', () => {
    assert.equal(alertSeverity(['supply_low', 'offline']), 'critical');
  });

  it('treats an empty batch as critical rather than downplaying it', () => {
    // Defensive: an unknown/empty set should not silently read as a mild warning.
    assert.equal(alertSeverity([]), 'warning');
  });
});

describe('renderAlertEmail: the conditional action button', () => {
  it('is omitted entirely when there is no app URL', () => {
    const html = alert({ actionUrl: null });
    assert.ok(!html.includes('Open Device in Krembonet'));
    assert.ok(!/<a\s/i.test(html), 'no anchor should be rendered without a URL');
  });

  it('is rendered, pointing at the device, when an app URL is set', () => {
    const html = alert({ actionUrl: 'http://hub.lan:3000/devices/front-desk-mfp' });
    assert.ok(html.includes('Open Device in Krembonet'));
    assert.ok(html.includes('href="http://hub.lan:3000/devices/front-desk-mfp"'));
  });
});

describe('renderAlertEmail: the header fallback', () => {
  it('shows the org title as text when no logo is set', () => {
    const html = alert({ branding: { hubTitle: 'Acme Print', logoUrl: '' } });
    assert.ok(!html.includes('<img'), 'no image without a logo');
    assert.ok(html.includes('Acme Print'));
  });

  it('shows the logo image when one is set', () => {
    const html = alert({
      branding: { hubTitle: 'Acme Print', logoUrl: 'https://cdn.example/logo.png' },
    });
    assert.ok(html.includes('<img src="https://cdn.example/logo.png"'));
    // The title rides along as the alt text so a blocked image still names the hub.
    assert.ok(html.includes('alt="Acme Print"'));
  });
});

describe('renderAlertEmail: the self-contained device card', () => {
  it('carries name, model, location and address for a reader with no app access', () => {
    const html = alert();
    assert.ok(html.includes('Front Desk MFP'));
    assert.ok(html.includes('SHARP BP-71C45'));
    assert.ok(html.includes('2nd Floor — Main Office'));
    assert.ok(html.includes('10.0.4.21'));
    assert.ok(html.includes('Magenta Toner is low (1%)'));
  });

  it('shows a dash for a device with no location rather than an empty cell', () => {
    const html = alert({ device: { ...BASE.device, location: null } });
    assert.ok(html.includes('—'));
  });

  it('lists every condition when a rule batches several', () => {
    const html = alert({
      severity: 'critical',
      headline: '2 conditions need attention',
      details: ['Waste toner is full', 'Cyan Toner is low (4%)'],
    });
    assert.ok(html.includes('Waste toner is full'));
    assert.ok(html.includes('Cyan Toner is low (4%)'));
  });
});

describe('renderAlertEmail: severity badge', () => {
  it('labels a warning', () => {
    assert.ok(alert({ severity: 'warning' }).includes('Warning'));
  });

  it('labels a critical', () => {
    assert.ok(alert({ severity: 'critical' }).includes('Critical'));
  });
});

describe('renderAlertEmail: footer', () => {
  it('names the org, a timestamp, and where to manage alerts', () => {
    const html = alert();
    assert.ok(html.includes('Acme Print'));
    assert.ok(html.includes('Manage alert preferences in Admin → Alert Rules'));
  });
});

describe('renderAlertEmail: escaping device-reported text', () => {
  it('neutralises markup in a device name or fault string', () => {
    const html = alert({
      device: { ...BASE.device, name: 'Lab <script>alert(1)</script>' },
      headline: 'Toner & "trouble" <b>',
      details: ['Toner & "trouble" <b>'],
    });
    assert.ok(!html.includes('<script>'), 'a script tag survived unescaped');
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('Toner &amp; &quot;trouble&quot; &lt;b&gt;'));
  });
});

describe('renderTestEmail', () => {
  it('confirms configuration and points at Alert Rules', () => {
    const html = renderTestEmail({
      branding: { hubTitle: 'Acme Print', logoUrl: '' },
      timestamp: new Date('2026-08-10T14:30:00Z'),
    });
    assert.ok(html.includes('SMTP Configuration Successful'));
    assert.ok(html.includes('Admin → Alert Rules'));
    assert.ok(html.includes('Acme Print'));
  });

  it('has no action button — it is not about a device', () => {
    const html = renderTestEmail({
      branding: { hubTitle: 'Acme Print', logoUrl: 'https://cdn.example/logo.png' },
      timestamp: new Date(),
    });
    assert.ok(!/<a\s/i.test(html));
    // But the logo fallback still applies.
    assert.ok(html.includes('<img src="https://cdn.example/logo.png"'));
  });
});
