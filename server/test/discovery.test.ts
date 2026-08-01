/**
 * CIDR parsing for subnet discovery.
 *
 * All arithmetic, no sockets — which is exactly where the failures live. An
 * off-by-one at a subnet boundary means a device that never gets found; an
 * unsigned-shift mistake means `192.168.x` parses negative and the whole range
 * comes out empty; a missing size cap means someone types `/8` and the server
 * spends an hour connecting to sixteen million addresses.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MIN_PREFIX, parseCidr } from '../src/devices/discovery/cidr.js';

/** Non-null helper — these fixtures are all expected to parse. */
function parsed(input: string) {
  const result = parseCidr(input);
  assert.ok(!('error' in result), `expected ${input} to parse`);
  return result.subnet;
}

function rejected(input: string): string {
  const result = parseCidr(input);
  assert.ok('error' in result, `expected ${input} to be rejected`);
  return result.error;
}

describe('a typical /24', () => {
  const subnet = parsed('192.168.1.0/24');

  it('yields 254 usable hosts', () => {
    assert.equal(subnet.hosts.length, 254);
    assert.equal(subnet.hosts[0], '192.168.1.1');
    assert.equal(subnet.hosts.at(-1), '192.168.1.254');
  });

  it('excludes the network and broadcast addresses', () => {
    assert.ok(!subnet.hosts.includes('192.168.1.0'));
    assert.ok(!subnet.hosts.includes('192.168.1.255'));
    assert.equal(subnet.network, '192.168.1.0');
    assert.equal(subnet.broadcast, '192.168.1.255');
  });
});

describe('host bits in the input', () => {
  it('are masked off, so any address on the network works', () => {
    // What someone reading their own IP off a laptop will actually type.
    const subnet = parsed('192.168.1.34/24');

    assert.equal(subnet.cidr, '192.168.1.0/24');
    assert.equal(subnet.hosts.length, 254);
  });
});

describe('prefix boundaries', () => {
  it('handles a /30 — two usable hosts', () => {
    const subnet = parsed('10.0.0.0/30');
    assert.deepEqual(subnet.hosts, ['10.0.0.1', '10.0.0.2']);
  });

  it('treats /31 as RFC 3021 point-to-point, with both addresses usable', () => {
    const subnet = parsed('10.0.0.0/31');
    assert.deepEqual(subnet.hosts, ['10.0.0.0', '10.0.0.1']);
    assert.equal(subnet.broadcast, null);
  });

  it('treats /32 as a single host', () => {
    const subnet = parsed('10.1.2.3/32');
    assert.deepEqual(subnet.hosts, ['10.1.2.3']);
  });

  it('crosses an octet boundary correctly', () => {
    // The off-by-one that only shows up when the range spans .255 → .0.
    const subnet = parsed('192.168.0.0/23');

    assert.equal(subnet.hosts.length, 510);
    assert.ok(subnet.hosts.includes('192.168.0.255'));
    assert.ok(subnet.hosts.includes('192.168.1.0'));
    assert.equal(subnet.hosts.at(-1), '192.168.1.254');
  });

  it('handles the high addresses that a signed shift would break', () => {
    // 192.x and 10.x set the top bit once shifted; without `>>> 0` the
    // comparisons go negative and the range comes out empty.
    assert.equal(parsed('240.0.0.0/24').hosts.length, 254);
    assert.equal(parsed('255.255.255.0/24').hosts[0], '255.255.255.1');
  });
});

describe('size limits', () => {
  it(`refuses anything larger than a /${MIN_PREFIX}`, () => {
    for (const prefix of [0, 8, 16, MIN_PREFIX - 1]) {
      const error = rejected(`10.0.0.0/${prefix}`);
      assert.match(error, /addresses/);
    }
  });

  it(`accepts exactly /${MIN_PREFIX}`, () => {
    assert.equal(parsed(`10.0.0.0/${MIN_PREFIX}`).hosts.length, 4094);
  });
});

describe('malformed input', () => {
  it('is rejected with an example rather than a parser error', () => {
    for (const input of ['', '192.168.1.0', 'not a subnet', '192.168.1.0/', '/24']) {
      assert.match(rejected(input), /CIDR|valid/i);
    }
  });

  it('rejects out-of-range and oddly-written octets', () => {
    // `Number('01')` and `Number(' 1')` both succeed, which is how a typo
    // becomes a scan of the wrong network.
    for (const input of [
      '256.1.1.1/24',
      '192.168.1/24',
      '1.2.3.4.5/24',
      '192.168.01.0/24',
    ]) {
      assert.ok('error' in parseCidr(input), `accepted ${input}`);
    }
  });

  it('rejects a prefix beyond /32', () => {
    assert.match(rejected('10.0.0.0/33'), /greater than/);
  });
});

describe('private range detection', () => {
  it('recognises the ranges a LAN tool belongs on', () => {
    for (const input of [
      '10.0.0.0/24',
      '172.16.5.0/24',
      '172.31.255.0/24',
      '192.168.1.0/24',
      '169.254.1.0/24',
      '127.0.0.0/24',
      '100.64.0.0/24',
    ]) {
      assert.equal(parsed(input).isPrivate, true, `${input} should be private`);
    }
  });

  it('flags public space, including the near-misses', () => {
    // 172.15 and 172.32 sit either side of the RFC 1918 block, and 100.128 sits
    // just past the CGNAT range — all three are easy to get wrong.
    for (const input of [
      '8.8.8.0/24',
      '172.15.0.0/24',
      '172.32.0.0/24',
      '192.167.1.0/24',
      '100.128.0.0/24',
    ]) {
      assert.equal(parsed(input).isPrivate, false, `${input} should be public`);
    }
  });
});
