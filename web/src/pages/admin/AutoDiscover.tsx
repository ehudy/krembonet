/**
 * Subnet sweep and one-click add.
 *
 * A sweep takes seconds, not milliseconds, and the operator has no way to know
 * whether it is working — so the button reports what it is doing and stays
 * cancellable throughout. An abortable request matters more than usual here:
 * navigating away mid-sweep should stop the server hammering a network, not
 * leave it running for another minute.
 *
 * Adding is deliberately one click and no form. Discovery already knows the
 * address, the adapter, and the config that made the probe succeed; asking the
 * operator to retype any of it would be asking them to introduce a typo. What
 * they get instead is Edit, right afterwards, on a device that already works.
 */
import { useRef, useState } from 'react';

import { api } from '../../api.js';
import type { DiscoveredDevice, DiscoveryResponse } from '../../types.js';

const PORT_LABELS: Record<number, string> = { 631: 'IPP', 161: 'SNMP' };

function describePorts(ports: number[]): string {
  return ports.map((port) => PORT_LABELS[port] ?? String(port)).join(' + ');
}

/** Vendor and model, whichever the device was willing to give. */
function describeIdentity(device: DiscoveredDevice): string | null {
  const { vendor, makeAndModel } = device.identity;
  if (makeAndModel !== null && makeAndModel.trim() !== '') return makeAndModel;
  if (vendor !== null && vendor.trim() !== '') return vendor;
  return null;
}

interface AutoDiscoverProps {
  /** Reloads the device list after a successful add. */
  onAdded: () => Promise<void> | void;
}

export function AutoDiscover({ onAdded }: AutoDiscoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [subnet, setSubnet] = useState('192.168.1.0/24');
  const [community, setCommunity] = useState('');
  const [result, setResult] = useState<DiscoveryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [addingHost, setAddingHost] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  const controllerRef = useRef<AbortController | null>(null);

  async function scan(event: React.FormEvent): Promise<void> {
    event.preventDefault();

    const controller = new AbortController();
    controllerRef.current = controller;

    setIsScanning(true);
    setError(null);
    setResult(null);
    setAdded(new Set());

    try {
      const body =
        community.trim() === ''
          ? { subnet: subnet.trim() }
          : { subnet: subnet.trim(), community: community.trim() };

      setResult(await api.discoverDevices(body, controller.signal));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsScanning(false);
      controllerRef.current = null;
    }
  }

  function cancel(): void {
    controllerRef.current?.abort();
    setIsScanning(false);
  }

  async function add(device: DiscoveredDevice): Promise<void> {
    if (device.adapter === null) return;

    setAddingHost(device.host);
    setError(null);

    try {
      await api.createDevice({
        displayName: device.suggestedName,
        host: device.host,
        adapter: device.adapter,
        enabled: true,
        config: device.config,
        // What the probe actually found, so the dashboard renders panels for
        // what this device does rather than what its adapter might do.
        capabilities: device.capabilities,
      });

      setAdded((current) => new Set(current).add(device.host));
      await onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAddingHost(null);
    }
  }

  if (!isOpen) {
    return (
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Auto-discover</h2>
          <button type="button" className="btn-secondary" onClick={() => setIsOpen(true)}>
            Scan a subnet
          </button>
        </div>
        <p className="muted">
          Sweeps a range of addresses for printers answering on IPP or SNMP and identifies
          what it finds.
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Auto-discover</h2>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            cancel();
            setIsOpen(false);
          }}
        >
          Close
        </button>
      </div>

      <form onSubmit={scan}>
        <div className="field-grid">
          <label className="field">
            <span>Subnet</span>
            <input
              value={subnet}
              placeholder="192.168.1.0/24"
              onChange={(event) => setSubnet(event.target.value)}
            />
            <small className="field-hint">
              CIDR notation, /20 or smaller. Any address on the network works —{' '}
              <code>192.168.1.34/24</code> scans the whole /24 it sits on.
            </small>
          </label>

          <label className="field">
            <span>SNMP community</span>
            <input
              value={community}
              placeholder="public"
              autoComplete="off"
              onChange={(event) => setCommunity(event.target.value)}
            />
            <small className="field-hint">
              Only used to detect SNMP devices during the sweep. Devices using a different
              community will not answer and will not be found.
            </small>
          </label>
        </div>

        <div className="inline-actions">
          <button type="submit" className="btn-primary" disabled={isScanning}>
            {isScanning ? 'Scanning…' : 'Start scan'}
          </button>
          {isScanning && (
            <button type="button" className="btn-secondary" onClick={cancel}>
              Cancel
            </button>
          )}
          {isScanning && (
            <span className="muted">
              Connecting to every address in the range. This takes a few seconds.
            </span>
          )}
        </div>
      </form>

      {error !== null && <div className="banner is-error">{error}</div>}

      {result !== null && (
        <>
          <p className="field-hint">
            Swept {result.subnet} — {result.scanned} of {result.hostCount} addresses in{' '}
            {(result.elapsedMs / 1000).toFixed(1)}s. {result.responsive} answered.
          </p>

          {result.timedOut && (
            <div className="banner is-warning">
              The scan hit its time limit, so this list may be incomplete. Try a smaller
              range.
            </div>
          )}
          {result.truncated && (
            <div className="banner is-warning">
              More addresses answered than could be identified in one pass. The rest are
              not shown — add these, then scan again.
            </div>
          )}

          {result.devices.length === 0 ? (
            <p className="muted">
              Nothing answered on IPP (631) or SNMP (161). If you expected a device here,
              check that it is powered on, and that SNMP is enabled with the community
              string above.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Address</th>
                    <th scope="col">Identified as</th>
                    <th scope="col">Answers on</th>
                    <th scope="col">Reports</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.devices.map((device) => {
                    const identity = describeIdentity(device);
                    const isAdded = added.has(device.host) || device.alreadyAdded;

                    return (
                      <tr key={device.host}>
                        <td>
                          <code>{device.host}</code>
                        </td>
                        <td>
                          {identity ?? <span className="muted">Not identified</span>}
                          {device.adapterLabel !== null && (
                            <small className="muted"> · {device.adapterLabel}</small>
                          )}
                          {/* The probe's own caveats — "responded but reported no
                              usable levels" is the difference between a device
                              worth adding and one that will never alert. */}
                          {device.notes.length > 0 && (
                            <span className="state-reason">{device.notes.join(' ')}</span>
                          )}
                        </td>
                        <td className="muted">{describePorts(device.ports)}</td>
                        <td className="muted">
                          {device.capabilities
                            .filter((capability) => capability !== 'reachability')
                            .join(', ') || '—'}
                        </td>
                        <td className="row-actions">
                          {isAdded ? (
                            <span className="pill is-good">
                              {device.alreadyAdded ? 'Already added' : 'Added'}
                            </span>
                          ) : device.adapter === null ? (
                            <span
                              className="muted"
                              title="Nothing here identified itself as a supported device. Add it by hand if you know what it is."
                            >
                              Add by hand
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn-primary"
                              disabled={addingHost === device.host}
                              onClick={() => void add(device)}
                            >
                              {addingHost === device.host ? 'Adding…' : 'Add'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
