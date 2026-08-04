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
import { CircleAlert, CircleCheck, Info, Radar } from 'lucide-react';

import { api } from '../../api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { SortableHeader } from '../../components/SortableHeader.js';
import { ToggleSwitch } from '../../components/ToggleSwitch.js';
import { useTranslation } from '../../i18n/i18n.js';
import { compareText, toggleSort, type SortState } from '../../lib/tableSort.js';
import {
  AdapterConfigForm,
  defaultsFor,
  visibleValues,
  type ConfigValues,
} from '../../components/AdapterConfigForm.js';
import type {
  AdapterInfo,
  AdminDevice,
  ProbeResponse,
  SmartProbeResponse,
} from '../../types.js';
import { AutoDiscover } from './AutoDiscover.js';

type SortField = 'name' | 'address' | 'adapter' | 'reports';

/**
 * What each column sorts on.
 *
 * Every one is text, so they all share `compareText` — which matters most for
 * the address column, where a character-by-character comparison files
 * `192.168.1.10` above `192.168.1.9`. `Reports` is a list, joined in the same
 * order the cell renders it so what sorts is what is read.
 */
function sortValue(device: AdminDevice, field: SortField): string | null {
  switch (field) {
    case 'name':
      return device.displayName;
    case 'address':
      return device.host;
    case 'adapter':
      return device.adapter;
    case 'reports':
      return (device.capabilities ?? [])
        .filter((capability) => capability !== 'reachability')
        .join(', ');
  }
}

/** Ties fall through to the name, so rows do not shuffle between renders. */
function compareDevices(
  a: AdminDevice,
  b: AdminDevice,
  sort: SortState<SortField>,
): number {
  const ordered = compareText(
    sortValue(a, sort.field),
    sortValue(b, sort.field),
    sort.direction,
  );
  if (sort.field === 'name') return ordered;
  return ordered || compareText(a.displayName, b.displayName, 'asc');
}

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
}

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

/**
 * What the smart probe found, and what to do about it.
 *
 * Three outcomes worth distinguishing, because the next action differs for
 * each: IPP answered and everything works; only SNMP answered, which polls
 * fine but will never show a queue; nothing pollable answered, which is either
 * a device with its protocols off or the wrong address entirely.
 */
/** True when either community version answered. */
function hasSnmp(result: SmartProbeResponse): boolean {
  return result.protocols.snmpV2c || result.protocols.snmpV1;
}

function SmartProbeTip({ result }: { result: SmartProbeResponse }) {
  const { t } = useTranslation();

  const answered = [
    result.protocols.ipp ? 'IPP' : null,
    result.protocols.snmpV2c ? 'SNMP v2c' : null,
    result.protocols.snmpV1 ? 'SNMP v1' : null,
    result.protocols.http ? 'HTTP' : null,
  ].filter((entry): entry is string => entry !== null);

  if (!result.reachable) {
    return (
      <div className="probe-tip is-bad">
        <CircleAlert size={14} strokeWidth={2} aria-hidden="true" />
        <span>{t('devices.probeNothing')}</span>
      </div>
    );
  }

  if (result.adapter === null) {
    // Two different situations wear the same "nothing to configure" hat, and
    // they need different advice: a device answering only on the web ports has
    // its pollable protocols switched off, while one that answered on IPP or
    // SNMP and still identified as nothing is reachable but not speaking a
    // dialect this hub recognised. Calling the second one "a web interface"
    // would be plainly wrong.
    const webOnly = result.protocols.http && !result.protocols.ipp && !hasSnmp(result);

    return (
      <div className="probe-tip is-warn">
        <Info size={14} strokeWidth={2} aria-hidden="true" />
        <span>
          {webOnly
            ? t('devices.probeHttpOnly', { protocols: answered.join(', ') })
            : t('devices.probeUnidentified', { protocols: answered.join(', ') })}
        </span>
      </div>
    );
  }

  const snmpOnly = result.adapter === 'snmp';

  return (
    <div className={`probe-tip${snmpOnly ? ' is-warn' : ' is-good'}`}>
      {snmpOnly ? (
        <Info size={14} strokeWidth={2} aria-hidden="true" />
      ) : (
        <CircleCheck size={14} strokeWidth={2} aria-hidden="true" />
      )}
      <span>
        {t('devices.probeApplied', {
          adapter: result.adapterLabel ?? result.adapter,
          protocols: answered.join(', '),
        })}
        {/* The advisory only belongs on an SNMP answer: it is the case where
            the device works but is missing the queue and tray telemetry that
            switching IPP on would add. */}
        {snmpOnly && <> {t('devices.probeSnmpOnlyTip')}</>}
      </span>
    </div>
  );
}

export function AdminDevices() {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<AdminDevice[] | null>(null);
  // A-Z by name. The endpoint already orders by display name, but that is its
  // choice rather than the operator's, and a table you cannot reorder is one
  // you scroll to find something in.
  const [sort, setSort] = useState<SortState<SortField>>({
    field: 'name',
    direction: 'asc',
  });
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [probe, setProbe] = useState<ProbeResponse | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const [smart, setSmart] = useState<SmartProbeResponse | null>(null);
  const [isSmartProbing, setIsSmartProbing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AdminDevice | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
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

  const sorted = [...(devices ?? [])].sort((a, b) => compareDevices(a, b, sort));

  function sortBy(field: SortField): void {
    // Every column here is text, so ascending is the useful first click on all
    // four — no per-column natural direction to look up.
    setSort((current) => toggleSort(current, field));
  }

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

  /**
   * Works out what the address speaks, then fills the form in from the answer.
   *
   * The point is to spare an operator the guesswork the form otherwise demands:
   * which adapter, which SNMP version, which URI. If something pollable
   * answered, its adapter and config are applied outright — they came from a
   * connection that actually worked, so there is nothing to confirm.
   *
   * The result is kept either way, because the useful case includes finding
   * nothing pollable: an address with only a web UI is a live device with its
   * protocols switched off, which is a different problem from a wrong IP.
   */
  async function runSmartProbe(): Promise<void> {
    if (draft === null || draft.host.trim() === '') return;

    setIsSmartProbing(true);
    setError(null);
    setSmart(null);
    setProbe(null);

    try {
      const result = await api.smartProbe({ address: draft.host.trim() });
      setSmart(result);

      if (result.adapter !== null) {
        const next = adapters.find((entry) => entry.id === result.adapter);
        setDraft((current) =>
          current === null
            ? null
            : {
                ...current,
                adapter: result.adapter as string,
                // The adapter's defaults underneath, so any field the probe did
                // not speak to still has a sensible value rather than blank.
                config: {
                  ...(next === undefined ? {} : defaultsFor(next.configSchema)),
                  ...result.config,
                },
              },
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSmartProbing(false);
    }
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

  /**
   * Deletes the device the dialog is currently asking about.
   *
   * The confirmation is a real dialog rather than `window.confirm` because this
   * drops supply history that cannot be re-read from the device — a consequence
   * worth stating in the app's own words, with the destructive button named and
   * coloured as such.
   */
  async function confirmRemove(): Promise<void> {
    const device = pendingDelete;
    if (device === null) return;

    setIsDeleting(true);
    try {
      await api.deleteDevice(device.id);
      setPendingDelete(null);
      setNotice(t('devices.deleted', { name: device.displayName }));
      await load();
    } catch (cause) {
      setPendingDelete(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsDeleting(false);
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
                <SortableHeader
                  field="name"
                  sort={sort}
                  onSort={sortBy}
                  label={t('devices.name')}
                />
                <SortableHeader
                  field="address"
                  sort={sort}
                  onSort={sortBy}
                  label={t('devices.address')}
                />
                <SortableHeader
                  field="adapter"
                  sort={sort}
                  onSort={sortBy}
                  label={t('devices.adapter')}
                />
                <SortableHeader
                  field="reports"
                  sort={sort}
                  onSort={sortBy}
                  label={t('devices.reports')}
                />
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((device) => (
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
                      onClick={() => setPendingDelete(device)}
                    >
                      {t('common.delete')}
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

            <div className="field">
              <span>
                {t('devices.address')}
                <em className="field-required">{t('devices.required')}</em>
              </span>
              {/* A div rather than a label wrapping both: a label containing a
                  button would make clicking the button focus the input too. */}
              <div className="address-row">
                <input
                  aria-label={t('devices.address')}
                  value={draft.host}
                  placeholder={t('devices.addressPlaceholder')}
                  onChange={(event) => {
                    setDraft({ ...draft, host: event.target.value });
                    setProbe(null);
                    setSmart(null);
                  }}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={draft.host.trim() === '' || isSmartProbing}
                  onClick={() => void runSmartProbe()}
                >
                  <Radar size={14} strokeWidth={2} aria-hidden="true" />
                  {isSmartProbing ? t('devices.probingIp') : t('devices.probeIp')}
                </button>
              </div>
              <small className="field-hint">{t('devices.probeIpHint')}</small>

              {smart !== null && <SmartProbeTip result={smart} />}
            </div>

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

          {/* One switch. The three per-category companions went when
              notification became rule-driven: silencing one kind of alert for
              one printer is a question of how a rule is scoped, and having a
              second place to answer it meant two screens to check when a
              printer went quiet. */}
          <ToggleSwitch
            checked={draft.isMuted}
            label={t('devices.maintenanceMode')}
            hint={t('devices.maintenanceModeHint')}
            onChange={(next) => setDraft({ ...draft, isMuted: next })}
          />

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

      {pendingDelete !== null && (
        <ConfirmDialog
          title={t('devices.deleteTitle')}
          body={t('devices.deleteBody', { name: pendingDelete.displayName })}
          confirmLabel={isDeleting ? t('devices.deleting') : t('devices.deleteConfirm')}
          isBusy={isDeleting}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );
}
