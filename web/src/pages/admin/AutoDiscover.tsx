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
import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';

import { api } from '../../api.js';
import { useTranslation } from '../../i18n/i18n.js';
import type { DiscoveredDevice, DiscoveryResponse } from '../../types.js';

const PORT_LABELS: Record<number, string> = { 631: 'IPP', 161: 'SNMP' };

/**
 * What answered, with the SNMP dialect named.
 *
 * "SNMP" alone is not enough once v1 is in play: an operator looking at a
 * device that only answered v1 wants to know that, both because it says
 * something about the age of the firmware and because it is what got written
 * into the device's config.
 */
function describePorts(device: DiscoveredDevice): string {
  return device.ports
    .map((port) => {
      const label = PORT_LABELS[port] ?? String(port);
      if (port !== 161 || device.snmpVersion === null) return label;
      return `${label} (v${device.snmpVersion})`;
    })
    .join(' + ');
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
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [subnet, setSubnet] = useState('');
  const [detected, setDetected] = useState<string | null>(null);
  const [community, setCommunity] = useState('');
  const [result, setResult] = useState<DiscoveryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [addingHost, setAddingHost] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  const controllerRef = useRef<AbortController | null>(null);

  /*
   * The hub is already on the network the printers are on, so it can propose
   * the range rather than making someone go and look theirs up. Fetched when
   * the panel opens rather than on mount — a closed panel should not be asking
   * the server about network interfaces.
   *
   * Only ever pre-filled, and only into a field the operator has not typed in:
   * a hub with several interfaces may well be offering the wrong one, and they
   * are the authority on which network their printers are actually on.
   */
  useEffect(() => {
    if (!isOpen) return;

    const controller = new AbortController();
    api
      // The address this browser reached the hub on. Inside a container it is
      // the only party that knows the real LAN — the server sees a bridge.
      .defaultSubnet(window.location.hostname, controller.signal)
      .then(({ subnet: local }) => {
        if (local === null) return;
        setDetected(local.cidr);
        setSubnet((current) => (current === '' ? local.cidr : current));
      })
      .catch(() => {
        // A hub that cannot report its own interfaces is not worth an error
        // banner — the field keeps its placeholder and can be typed into.
      });

    return () => controller.abort();
  }, [isOpen]);

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
          <h2 className="card-title">{t('discover.title')}</h2>
          <button type="button" className="btn-secondary" onClick={() => setIsOpen(true)}>
            {t('discover.open')}
          </button>
        </div>
        <p className="muted">{t('discover.intro')}</p>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t('discover.title')}</h2>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            cancel();
            setIsOpen(false);
          }}
        >
          {t('common.close')}
        </button>
      </div>

      <form onSubmit={scan}>
        <div className="field-grid">
          <label className="field">
            <span>{t('discover.subnet')}</span>
            <input
              value={subnet}
              placeholder={detected ?? '192.168.1.0/24'}
              onChange={(event) => setSubnet(event.target.value)}
            />
            {/* Says where the pre-filled value came from, so a hub with several
                interfaces does not look like it guessed at random. */}
            {detected !== null && (
              <small className="field-hint">
                {t('discover.detectedSubnet', { subnet: detected })}
              </small>
            )}
            <small className="field-hint">
              {t('discover.subnetHint')
                .split('<example>')
                .map((part, index) => (
                  <span key={index}>
                    {part}
                    {index === 0 && <code>192.168.1.34/24</code>}
                  </span>
                ))}
            </small>
          </label>

          <label className="field">
            <span>{t('discover.community')}</span>
            <input
              value={community}
              placeholder="public"
              autoComplete="off"
              onChange={(event) => setCommunity(event.target.value)}
            />
            <small className="field-hint">{t('discover.communityHint')}</small>
          </label>
        </div>

        <div className="inline-actions">
          <button type="submit" className="btn-primary" disabled={isScanning}>
            {isScanning ? t('discover.scanning') : t('discover.start')}
          </button>
          {isScanning && (
            <button type="button" className="btn-secondary" onClick={cancel}>
              {t('common.cancel')}
            </button>
          )}
          {isScanning && <span className="muted">{t('discover.inProgress')}</span>}
        </div>
      </form>

      {error !== null && <div className="banner is-error">{error}</div>}

      {result !== null && (
        <>
          <p className="field-hint">
            {t('discover.summary', {
              subnet: result.subnet,
              scanned: result.scanned,
              total: result.hostCount,
              seconds: (result.elapsedMs / 1000).toFixed(1),
              responsive: result.responsive,
            })}
          </p>

          {result.timedOut && (
            <div className="banner is-warning">{t('discover.timedOut')}</div>
          )}
          {result.truncated && (
            <div className="banner is-warning">{t('discover.truncated')}</div>
          )}

          {result.devices.length === 0 ? (
            <p className="muted">{t('discover.nothingFound')}</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t('devices.address')}</th>
                    <th scope="col">{t('discover.identifiedAs')}</th>
                    <th scope="col">{t('discover.answersOn')}</th>
                    <th scope="col">{t('devices.reports')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('common.actions')}</span>
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
                          {identity ?? (
                            <span className="muted">{t('discover.notIdentified')}</span>
                          )}
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
                        <td className="muted">
                          {describePorts(device)}
                          {/* An SNMP-only device works — supplies and status
                              are the bulk of what this hub shows — but it will
                              never have a queue or paper trays. Said once,
                              here, rather than leaving someone to notice the
                              empty panels later and wonder what broke. */}
                          {device.protocols.snmp && !device.protocols.ipp && (
                            <span
                              className="protocol-note"
                              title={t('discover.snmpOnlyTip')}
                            >
                              <Info size={12} strokeWidth={2.5} aria-hidden="true" />
                              {t('discover.snmpOnlyBadge')}
                            </span>
                          )}
                        </td>
                        <td className="muted">
                          {device.capabilities
                            .filter((capability) => capability !== 'reachability')
                            .join(', ') || t('common.none')}
                        </td>
                        <td className="row-actions">
                          {isAdded ? (
                            <span className="pill is-good">
                              {device.alreadyAdded
                                ? t('discover.alreadyAdded')
                                : t('discover.addedLabel')}
                            </span>
                          ) : device.adapter === null ? (
                            <span className="muted" title={t('discover.addByHandTitle')}>
                              {t('discover.addByHand')}
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn-primary"
                              disabled={addingHost === device.host}
                              onClick={() => void add(device)}
                            >
                              {addingHost === device.host
                                ? t('discover.adding')
                                : t('common.add')}
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
