/**
 * Choosing the subnet to pre-fill the discovery form with.
 *
 * All arithmetic and selection, no sockets — which is where the failures live.
 * A netmask turned into the wrong prefix offers a sweep range that does not
 * correspond to any real network; picking a Docker bridge offers one where the
 * only thing to find is the hub's own network stack; and a `>>` instead of
 * `>>>` makes every 192.x address come out negative and vanish.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  netmaskToPrefix,
  pickLocalSubnet,
  toCidr,
  type InterfaceAddress,
} from '../src/devices/discovery/local-subnet.js';

function entry(overrides: Partial<InterfaceAddress> = {}): InterfaceAddress {
  return {
    address: '192.168.1.34',
    netmask: '255.255.255.0',
    family: 'IPv4',
    internal: false,
    ...overrides,
  };
}

describe('netmaskToPrefix', () => {
  it('converts the masks a real machine reports', () => {
    assert.equal(netmaskToPrefix('255.255.255.0'), 24);
    assert.equal(netmaskToPrefix('255.255.0.0'), 16);
    assert.equal(netmaskToPrefix('255.255.255.252'), 30);
    assert.equal(netmaskToPrefix('255.255.255.255'), 32);
    assert.equal(netmaskToPrefix('0.0.0.0'), 0);
  });

  it('rejects a mask whose ones are not contiguous', () => {
    // Plausible-looking and not a netmask. Turning it into a prefix anyway
    // would produce a range that is not this device's network.
    assert.equal(netmaskToPrefix('255.255.0.255'), null);
    assert.equal(netmaskToPrefix('255.0.255.0'), null);
  });

  it('rejects malformed input rather than coercing it', () => {
    for (const value of ['', '255.255.255', 'not.a.mask.x', '255.255.255.256']) {
      assert.equal(netmaskToPrefix(value), null, value);
    }
  });
});

describe('toCidr', () => {
  it('masks host bits off to give the network address', () => {
    assert.equal(toCidr('192.168.1.34', 24), '192.168.1.0/24');
    assert.equal(toCidr('10.1.50.7', 24), '10.1.50.0/24');
    assert.equal(toCidr('172.16.30.200', 16), '172.16.0.0/16');
  });

  it('handles the high addresses a signed shift would break', () => {
    // 10.x and 192.x set the top bit once shifted; `>>` instead of `>>>` here
    // makes the result negative and the address unusable.
    assert.equal(toCidr('192.168.255.10', 24), '192.168.255.0/24');
    assert.equal(toCidr('255.255.255.254', 31), '255.255.255.254/31');
  });

  it('handles a /0 without shifting by 32, which is a no-op in JS', () => {
    assert.equal(toCidr('192.168.1.34', 0), '0.0.0.0/0');
  });
});

describe('pickLocalSubnet', () => {
  it('returns null when there is nothing usable', () => {
    assert.equal(pickLocalSubnet({}), null);
    assert.equal(pickLocalSubnet({ lo0: [entry({ internal: true })] }), null);
  });

  it('picks a plain LAN interface', () => {
    const picked = pickLocalSubnet({ en0: [entry()] });
    assert.equal(picked?.cidr, '192.168.1.0/24');
    assert.equal(picked?.interfaceName, 'en0');
    assert.equal(picked?.address, '192.168.1.34');
  });

  it('accepts the numeric family some runtimes report', () => {
    const picked = pickLocalSubnet({ en0: [entry({ family: 4 })] });
    assert.equal(picked?.cidr, '192.168.1.0/24');
  });

  it('skips loopback and IPv6', () => {
    const picked = pickLocalSubnet({
      lo0: [entry({ address: '127.0.0.1', netmask: '255.0.0.0', internal: true })],
      en0: [
        entry({ address: 'fe80::1', netmask: 'ffff::', family: 'IPv6' }),
        entry({ address: '10.1.50.7', netmask: '255.255.255.0' }),
      ],
    });
    assert.equal(picked?.cidr, '10.1.50.0/24');
  });

  it('skips container bridges and VPN tunnels', () => {
    // These carry real private addresses, so neither "private" nor "internal"
    // excludes them — but sweeping a Docker bridge finds only the hub itself.
    const picked = pickLocalSubnet({
      docker0: [entry({ address: '172.17.0.1', netmask: '255.255.0.0' })],
      'br-a1b2c3': [entry({ address: '172.18.0.1', netmask: '255.255.0.0' })],
      utun3: [entry({ address: '10.99.0.2', netmask: '255.255.255.0' })],
      en0: [entry({ address: '10.1.50.7' })],
    });
    assert.equal(picked?.interfaceName, 'en0');
    assert.equal(picked?.cidr, '10.1.50.0/24');
  });

  it('prefers the smallest network, which is the likeliest office LAN', () => {
    const picked = pickLocalSubnet({
      en0: [entry({ address: '172.16.4.9', netmask: '255.255.0.0' })],
      en1: [entry({ address: '10.1.50.7', netmask: '255.255.255.0' })],
    });
    assert.equal(picked?.cidr, '10.1.50.0/24');
  });

  it('ignores a network too large for the sweep to accept anyway', () => {
    // The sweep refuses anything wider than a /20, so offering a /8 would
    // pre-fill a value the form rejects the moment Scan is pressed.
    assert.equal(
      pickLocalSubnet({ en0: [entry({ address: '10.0.0.5', netmask: '255.0.0.0' })] }),
      null,
    );
  });

  it('ignores an interface whose netmask is not a real mask', () => {
    assert.equal(
      pickLocalSubnet({ en0: [entry({ netmask: '255.255.0.255' })] }),
      null,
    );
  });
});
