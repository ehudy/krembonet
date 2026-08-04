/**
 * What a webhook is allowed to point at.
 *
 * The cases that matter are the ones where the same address is spelled several
 * ways: a check that only recognises `169.254.169.254` and not `2852039166` is
 * a check that reads as protection and is not any.
 *
 * The permissive half is tested just as deliberately. A self-hosted receiver on
 * the LAN is the normal destination for this application, and a later tightening
 * that quietly broke it would break the feature for most of its users.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { expandIpv6, isBlockedHost, parseWebhookUrl } from '../src/alerts/webhook-url.js';

describe('parseWebhookUrl', () => {
  it('accepts the shapes a receiver actually has', () => {
    for (const url of [
      'https://discord.com/api/webhooks/123/abc',
      'https://ntfy.sh/my-topic',
      'http://192.168.1.50:8080/hook',
      'http://localhost:8000/notify',
      'http://[::1]:8000/notify',
      'http://nas.lan/api/webhook',
    ]) {
      const result = parseWebhookUrl(url);
      assert.ok('url' in result, `${url} was rejected: ${JSON.stringify(result)}`);
    }
  });

  it('refuses a scheme that is not an outbound POST', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'not a url']) {
      assert.ok('error' in parseWebhookUrl(url), url);
    }
  });

  it('refuses the cloud metadata endpoint, however it is spelled', () => {
    // Every one of these is 169.254.169.254. The URL parser normalises the
    // numeric forms, which is why the guard can check the dotted quad alone.
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://2852039166/latest/meta-data/',
      'http://0xA9FEA9FE/',
      'http://0251.0376.0251.0376/',
      'http://[::ffff:169.254.169.254]/',
      'http://[fd00:ec2::254]/',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]) {
      assert.ok('error' in parseWebhookUrl(url), `${url} was allowed`);
    }
  });

  it('refuses the unspecified address, which is not a destination', () => {
    assert.ok('error' in parseWebhookUrl('http://0.0.0.0:9000/hook'));
    assert.ok('error' in parseWebhookUrl('http://[::]:9000/hook'));
  });

  it('refuses a URL long enough to be a payload rather than an address', () => {
    assert.ok('error' in parseWebhookUrl(`https://example.com/${'a'.repeat(2100)}`));
  });

  it('takes anything, not just strings', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      assert.ok('error' in parseWebhookUrl(value), String(value));
    }
  });
});

describe('isBlockedHost', () => {
  it('leaves private and loopback addresses alone, deliberately', () => {
    // The application exists to watch hardware on a LAN, and its users run
    // their notification receivers there too.
    for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.50', '172.16.4.4', '[::1]']) {
      assert.equal(isBlockedHost(host), false, host);
    }
  });

  it('blocks the whole v4 link-local range, not just the metadata address', () => {
    assert.equal(isBlockedHost('169.254.1.1'), true);
    assert.equal(isBlockedHost('169.254.169.254'), true);
    assert.equal(isBlockedHost('169.253.169.254'), false);
  });

  it('blocks v6 link-local across the /10', () => {
    for (const host of ['[fe80::1]', '[febf::1]', '[fe80:0:0:0:0:0:0:1]']) {
      assert.equal(isBlockedHost(host), true, host);
    }
    assert.equal(isBlockedHost('[fec0::1]'), false);
  });

  it('is not fooled by a malformed literal', () => {
    assert.equal(isBlockedHost('[not:an:address]'), false);
    assert.equal(isBlockedHost('example.com'), false);
  });
});

describe('expandIpv6', () => {
  it('expands the compressed form to eight groups', () => {
    assert.deepEqual(expandIpv6('fd00:ec2::254'), [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x254]);
    assert.deepEqual(expandIpv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(expandIpv6('::'), [0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('folds an IPv4 tail into its two groups', () => {
    assert.deepEqual(
      expandIpv6('::ffff:169.254.169.254'),
      [0, 0, 0, 0, 0, 0xffff, 0xa9fe, 0xa9fe],
    );
  });

  it('rejects what is not an address', () => {
    assert.equal(expandIpv6('fd00::ec2::254'), null);
    assert.equal(expandIpv6('12345::1'), null);
    assert.equal(expandIpv6('fd00:ec2:0:0:0:0:0'), null);
  });
});
