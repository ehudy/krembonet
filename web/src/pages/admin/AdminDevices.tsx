/**
 * Device management.
 *
 * The per-adapter portion of the form is generated from the adapter's declared
 * config schema, so adding an adapter is a server-side change.
 *
 * Probing before saving is the point of this screen. "It responded" and "it
 * reports anything useful" are different claims, and the probe result says
 * which — including the caveats, so an operator finds out that a printer's
 * trays only report low/OK here rather than a week later when an alert does not
 * arrive.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { api } from '../../api.js';
import { useTranslation } from '../../i18n/i18n.js';
import {
  AdapterConfigForm,
  defaultsFor,
  visibleValues,
  type ConfigValues,
} from '../../components/AdapterConfigForm.js';
import type { AdapterInfo, AdminDevice, ProbeResponse } from '../../types.js';
import { AutoDiscover } from './AutoDiscover.js';

interface Draft {
  id: number | null;
  displayName: string;
  location: string;
  host: string;
  adapter: string;
  enabled: boolean;
  config: ConfigValues;
  secretsSet: string[];
  isMuted: boolean;
  muteSupplyAlerts: boolean;
  muteMediaAlerts: boolean;
  muteOfflineAlerts: boolean;
}

type MuteKey = 'isMuted' | 'muteSupplyAlerts' | 'muteMediaAlerts' | 'muteOfflineAlerts';

/** The four suppression switches, broadest first. */
const MUTE_TOGGLES: { key: MuteKey; label: string }[] = [
  { key: 'isMuted', label: 'maintenanceMode' },
  { key: 'muteSupplyAlerts', label: 'muteSupply' },
  { key: 'muteMediaAlerts', label: 'muteMedia' },
  { key: 'muteOfflineAlerts', label: 'muteOffline' },
];

function blankDraft(adapters: AdapterInfo[]): Draft {
  const first = adapters[0];
  return {
    id: null,
    displayName: '',
    location: '',
    host: '',
    adapter: first?.id ?? '',
    enabled: true,
    config: first === undefined ? {} : defaultsFor(first.configSchema),
    secretsSet: [],
    isMuted: false,
    muteSupplyAlerts: false,
    muteMediaAlerts: false,
    muteOfflineAlerts: false,
  };
}

function draftFrom(device: AdminDevice): Draft {
  return {
    id: device.id,
    displayName: device.displayName,
    location: device.location ?? '',
    host: device.host,
    adapter: device.adapter,
    enabled: device.enabled,
    config: { ...device.config },
    secretsSet: device.secretsSet,
    isMuted: device.isMuted,
    muteSupplyAlerts: device.muteSupplyAlerts,
    muteMediaAlerts: device.muteMediaAlerts,
    muteOfflineAlerts: device.muteOfflineAlerts,
  };
}

function ProbeReport({
  probe,
  adapters,
}: {
  probe: ProbeResponse;
  adapters: AdapterInfo[];
}) {
  return (
    <div className="probe-report">
      {probe.results.map(({ adapter, label, result }) => {
        const known = adapters.some((entry) => entry.id === adapter);
        return (
          <div key={adapter} className={`probe-row${result.reachable ? ' is-good' : ''}`}>
            <div className="probe-head">
              <strong>{known ? label : adapter}</strong>
              <span className={`pill ${result.reachable ? 'is-good' : 'is-bad'}`}>
                {result.reachable
                  ? `Responded · ${Math.round(result.confidence * 100)}% confident`
                  : 'No answer'}
              </span>
            </div>

            {result.identity.makeAndModel !== null && (
              <p className="probe-identity">
                {result.identity.vendor !== null && `${result.identity.vendor} · `}
                {result.identity.makeAndModel}
                {result.identity.serial !== null && ` · ${result.identity.serial}`}
              </p>
            )}

            {result.capabilities.length > 0 && (
              <p className="probe-caps">
                Reports:{' '}
                {result.capabilities.filter((c) => c !== 'reachability').join(', ') ||
                  'nothing yet'}
              </p>
            )}

            {result.sample?.supplies !== undefined &&
              result.sample.supplies.length > 0 && (
                <ul className="probe-supplies">
                  {result.sample.supplies.slice(0, 8).map((supply) => (
                    <li key={supply.index}>
                      <span>{supply.label}</span>
                      <span className="muted">
                        {supply.level.kind === 'percent'
                          ? `${supply.level.percent}%`
                          : supply.level.kind === 'binary'
                            ? supply.level.state === 'attention'
                              ? 'low'
                              : 'ok'
                            : supply.level.kind === 'absolute'
                              ? `${supply.level.value} of ${supply.level.max}`
                              : 'not reported'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

            {result.notes.length > 0 && (
              <ul className="probe-notes">
                {result.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AdminDevices() {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<AdminDevice[] | null>(null);
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [probe, setProbe] = useState<ProbeResponse | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const [deviceList, adapterList] = await Promise.all([
        api.listAdminDevices(signal),
        api.listAdapters(signal),
      ]);
      setDevices(deviceList.devices);
      setAdapters(adapterList.adapters);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const schema =
    adapters.find((entry) => entry.id === draft?.adapter)?.configSchema ?? [];

  function updateConfig(key: string, value: unknown): void {
    setDraft((current) =>
      current === null
        ? null
        : { ...current, config: { ...current.config, [key]: value } },
    );
    setProbe(null);
  }

  function switchAdapter(adapterId: string): void {
    const next = adapters.find((entry) => entry.id === adapterId);
    setDraft((current) =>
      current === null
        ? null
        : {
            ...current,
            adapter: adapterId,
            // Defaults for the new adapter rather than the previous adapter's
            // leftovers, which would fail validation in a confusing way.
            config: next === undefined ? {} : defaultsFor(next.configSchema),
          },
    );
    setProbe(null);
  }

  async function runProbe(): Promise<void> {
    if (draft === null || draft.host.trim() === '') return;
    setIsProbing(true);
    setError(null);
    setProbe(null);

    try {
      const result = await api.probeDevice({
        host: draft.host.trim(),
        config: visibleValues(schema, draft.config),
      });
      setProbe(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsProbing(false);
    }
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (draft === null) return;

    setIsSaving(true);
    setError(null);

    const payload = {
      displayName: draft.displayName.trim(),
      location: draft.location.trim() === '' ? null : draft.location.trim(),
      host: draft.host.trim(),
      adapter: draft.adapter,
      enabled: draft.enabled,
      isMuted: draft.isMuted,
      muteSupplyAlerts: draft.muteSupplyAlerts,
      muteMediaAlerts: draft.muteMediaAlerts,
      muteOfflineAlerts: draft.muteOfflineAlerts,
      config: visibleValues(schema, draft.config),
      // Record what the probe actually found, so the dashboard renders panels
      // for what this device does rather than what its adapter might do.
      capabilities:
        probe?.results.find((entry) => entry.adapter === draft.adapter)?.result
          .capabilities ?? undefined,
    };

    try {
      if (draft.id === null) await api.createDevice(payload);
      else await api.updateDevice(draft.id, payload);

      setNotice(draft.id === null ? t('devices.added') : t('devices.updated'));
      setDraft(null);
      setProbe(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSaving(false);
    }
  }

  async function remove(device: AdminDevice): Promise<void> {
    // Deleting a device drops its supply history, which cannot be re-read.
    if (!window.confirm(t('devices.confirmDelete', { name: device.displayName }))) {
      return;
    }

    try {
      await api.deleteDevice(device.id);
      setNotice(t('devices.deleted', { name: device.displayName }));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (devices === null && error === null)
    return <p className="muted">{t('devices.loading')}</p>;

  return (
    <>
      {error !== null && <div className="banner is-error">{error}</div>}
      {notice !== null && <div className="banner is-good">{notice}</div>}

      {adapters.length === 0 && (
        <div className="banner is-warning">{t('devices.noAdapters')}</div>
      )}

      {/* Above the list: finding devices is the first thing someone does on a
          fresh hub, and it is the answer to an empty table. */}
      {adapters.length > 0 && (
        <AutoDiscover
          onAdded={async () => {
            setNotice(t('devices.addedFromDiscovery'));
            await load();
          }}
        />
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t('devices.title')}</h2>
          {draft === null && adapters.length > 0 && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setDraft(blankDraft(adapters));
                setProbe(null);
                setNotice(null);
              }}
            >
              {t('devices.addDevice')}
            </button>
          )}
        </div>

        {devices !== null && devices.length === 0 ? (
          <p className="muted">{t('devices.empty')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('devices.name')}</th>
                <th>{t('devices.address')}</th>
                <th>{t('devices.adapter')}</th>
                <th>{t('devices.reports')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(devices ?? []).map((device) => (
                <tr key={device.id} className={device.enabled ? '' : 'is-muted'}>
                  <td>
                    <strong>{device.displayName}</strong>
                    {device.location !== null && (
                      <small className="muted"> · {device.location}</small>
                    )}
                    {device.model !== null && (
                      <small className="muted"> · {device.model}</small>
                    )}
                    {!device.enabled && (
                      <span className="pill is-warn">{t('devices.disabled')}</span>
                    )}
                  </td>
                  <td>
                    <code>{device.host}</code>
                  </td>
                  <td>
                    {device.adapter}
                    {!device.adapterKnown && (
                      <span
                        className="pill is-bad"
                        title={t('devices.unknownAdapterTitle')}
                      >
                        {t('devices.unknownAdapter')}
                      </span>
                    )}
                  </td>
                  <td className="muted">
                    {(device.capabilities ?? [])
                      .filter((capability) => capability !== 'reachability')
                      .join(', ') || t('common.none')}
                  </td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        setDraft(draftFrom(device));
                        setProbe(null);
                        setNotice(null);
                      }}
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={() => void remove(device)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {draft !== null && (
        <form className="card" onSubmit={(event) => void save(event)}>
          <h2 className="card-title">
            {draft.id === null ? 'Add device' : `Edit ${draft.displayName}`}
          </h2>

          <div className="field-grid">
            <label className="field">
              <span>
                {t('devices.displayName')}
                <em className="field-required">{t('devices.required')}</em>
              </span>
              <input
                value={draft.displayName}
                autoFocus
                onChange={(event) =>
                  setDraft({ ...draft, displayName: event.target.value })
                }
              />
            </label>

            <label className="field">
              <span>{t('devices.location')}</span>
              <input
                value={draft.location}
                placeholder={t('devices.locationPlaceholder')}
                onChange={(event) => setDraft({ ...draft, location: event.target.value })}
              />
            </label>

            <label className="field">
              <span>
                {t('devices.address')}
                <em className="field-required">{t('devices.required')}</em>
              </span>
              <input
                value={draft.host}
                placeholder={t('devices.addressPlaceholder')}
                onChange={(event) => {
                  setDraft({ ...draft, host: event.target.value });
                  setProbe(null);
                }}
              />
            </label>

            <label className="field">
              <span>{t('devices.adapter')}</span>
              <select
                value={draft.adapter}
                onChange={(event) => switchAdapter(event.target.value)}
              >
                {adapters.map((adapter) => (
                  <option key={adapter.id} value={adapter.id}>
                    {adapter.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field field-check">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) =>
                  setDraft({ ...draft, enabled: event.target.checked })
                }
              />
              <span>
                {t('devices.enabled')}
                <small>{t('devices.enabledHint')}</small>
              </span>
            </label>
          </div>

          <h3 className="card-subtitle">{t('devices.connection')}</h3>
          <AdapterConfigForm
            schema={schema}
            values={draft.config}
            secretsSet={draft.secretsSet}
            onChange={updateConfig}
          />

          <h3 className="card-subtitle">{t('devices.suppression')}</h3>
          <p className="field-hint">{t('devices.suppressionHint')}</p>

          <div className="field-grid">
            {MUTE_TOGGLES.map((toggle) => (
              <label key={toggle.key} className="field field-check">
                <input
                  type="checkbox"
                  checked={draft[toggle.key]}
                  // Maintenance mode already covers every category, so the
                  // per-category switches are disabled rather than left
                  // clickable and inert — a switch that does nothing when you
                  // flip it is worse than one you cannot flip.
                  disabled={toggle.key !== 'isMuted' && draft.isMuted}
                  onChange={(event) =>
                    setDraft({ ...draft, [toggle.key]: event.target.checked })
                  }
                />
                <span>
                  {t(`devices.${toggle.label}`)}
                  <small>{t(`devices.${toggle.label}Hint`)}</small>
                </span>
              </label>
            ))}
          </div>

          <div className="inline-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void runProbe()}
              disabled={isProbing || draft.host.trim() === ''}
            >
              {isProbing ? t('devices.probing') : t('devices.testConnection')}
            </button>
            <button type="submit" className="btn-primary" disabled={isSaving}>
              {isSaving
                ? t('common.saving')
                : draft.id === null
                  ? t('devices.addDevice')
                  : t('devices.saveChanges')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setDraft(null);
                setProbe(null);
              }}
            >
              {t('common.cancel')}
            </button>
          </div>

          {probe !== null && (
            <>
              <h3 className="card-subtitle">
                {t('devices.whatAnswered', { host: probe.host })}
              </h3>
              {probe.suggested !== null && probe.suggested !== draft.adapter && (
                <div className="banner is-warning">
                  <strong>{probe.suggested}</strong> {t('devices.betterMatch')}{' '}
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => switchAdapter(probe.suggested as string)}
                  >
                    {t('devices.switchToIt')}
                  </button>
                </div>
              )}
              <ProbeReport probe={probe} adapters={adapters} />
            </>
          )}
        </form>
      )}
    </>
  );
}
