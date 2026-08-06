/**
 * Adding or editing one printer.
 *
 * The per-adapter portion of the form is generated from the adapter's declared
 * config schema, so adding an adapter is a server-side change.
 *
 * Probing before saving is the point of this dialog. "It responded" and "it
 * reports anything useful" are different claims, and the probe result says
 * which — including the caveats, so an operator finds out that a printer's
 * trays only report low/OK here rather than a week later when an alert does not
 * arrive. The probe stays beside the connection fields it is testing rather than
 * down in the footer with Save, because its answer is what those fields are
 * for.
 */
import { useState, type FormEvent } from 'react';
import { BookOpen, CircleAlert, CircleCheck, Info, Radar } from 'lucide-react';

import { api } from '../../api.js';
import { Modal } from '../../components/Modal.js';
import { ToggleSwitch } from '../../components/ToggleSwitch.js';
import { useTranslation } from '../../i18n/i18n.js';
import { useRouter } from '../../router.js';
import { DOC_LINKS, navigateToDoc } from '../../lib/docs.js';
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

interface Draft {
  displayName: string;
  location: string;
  host: string;
  adapter: string;
  enabled: boolean;
  config: ConfigValues;
  secretsSet: string[];
  isMuted: boolean;
}

function blankDraft(adapters: readonly AdapterInfo[]): Draft {
  const first = adapters[0];
  return {
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
  adapters: readonly AdapterInfo[];
}) {
  const { t } = useTranslation();
  const { navigate } = useRouter();

  return (
    <div className="probe-report">
      {probe.results.map(({ adapter, label, result }) => {
        const known = adapters.some((entry) => entry.id === adapter);
        // The queue is the one thing only IPP reports, and a refusal is a
        // security-policy setting on the device — worth a pointer to the fix
        // rather than leaving the operator to wonder why the panel is missing.
        const jobsRefused =
          result.reachable && result.notes.some((note) => /Get-Jobs/i.test(note));
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

            {jobsRefused && (
              <button
                type="button"
                className="doc-help-link"
                onClick={() =>
                  navigateToDoc(navigate, DOC_LINKS.ippRefused.category, DOC_LINKS.ippRefused.anchor)
                }
              >
                <BookOpen size={13} strokeWidth={2} aria-hidden="true" />
                {t('docs.ippHelpLink')}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** True when either community version answered. */
function hasSnmp(result: SmartProbeResponse): boolean {
  return result.protocols.snmpV2c || result.protocols.snmpV1;
}

/**
 * What the smart probe found, and what to do about it.
 *
 * Three outcomes worth distinguishing, because the next action differs for
 * each: IPP answered and everything works; only SNMP answered, which polls
 * fine but will never show a queue; nothing pollable answered, which is either
 * a device with its protocols off or the wrong address entirely.
 */
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

export interface DeviceFormModalProps {
  /** The device being edited; null when adding. */
  device: AdminDevice | null;
  adapters: readonly AdapterInfo[];
  onClose: () => void;
  /** The page reloads the list and shows this; the dialog only reports. */
  onSaved: (message: string) => void;
}

export function DeviceFormModal({
  device,
  adapters,
  onClose,
  onSaved,
}: DeviceFormModalProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(() =>
    device === null ? blankDraft(adapters) : draftFrom(device),
  );
  const [probe, setProbe] = useState<ProbeResponse | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const [smart, setSmart] = useState<SmartProbeResponse | null>(null);
  const [isSmartProbing, setIsSmartProbing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const schema = adapters.find((entry) => entry.id === draft.adapter)?.configSchema ?? [];

  function updateConfig(key: string, value: unknown): void {
    setDraft((current) => ({ ...current, config: { ...current.config, [key]: value } }));
    setProbe(null);
  }

  function switchAdapter(adapterId: string): void {
    const next = adapters.find((entry) => entry.id === adapterId);
    setDraft((current) => ({
      ...current,
      adapter: adapterId,
      // Defaults for the new adapter rather than the previous adapter's
      // leftovers, which would fail validation in a confusing way.
      config: next === undefined ? {} : defaultsFor(next.configSchema),
    }));
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
    if (draft.host.trim() === '') return;

    setIsSmartProbing(true);
    setError(null);
    setSmart(null);
    setProbe(null);

    try {
      const result = await api.smartProbe({ address: draft.host.trim() });
      setSmart(result);

      if (result.adapter !== null) {
        const next = adapters.find((entry) => entry.id === result.adapter);
        setDraft((current) => ({
          ...current,
          adapter: result.adapter as string,
          // The adapter's defaults underneath, so any field the probe did not
          // speak to still has a sensible value rather than blank.
          config: {
            ...(next === undefined ? {} : defaultsFor(next.configSchema)),
            ...result.config,
          },
        }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSmartProbing(false);
    }
  }

  async function runProbe(): Promise<void> {
    if (draft.host.trim() === '') return;
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
    if (isSaving) return;

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
      if (device === null) await api.createDevice(payload);
      else await api.updateDevice(device.id, payload);

      onSaved(device === null ? t('devices.added') : t('devices.updated'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal
      title={
        device === null
          ? t('devices.addDevice')
          : t('devices.editTitle', { name: device.displayName })
      }
      size="wide"
      onClose={onClose}
      onSubmit={(event) => void save(event)}
      footerLayout="split"
      // Whether the printer is polled at all sits in the header, next to its
      // name, rather than as the fifth field down. It is the switch that
      // decides whether any of the settings below it run.
      headerAction={
        <ToggleSwitch
          checked={draft.enabled}
          label={draft.enabled ? t('devices.enabledOn') : t('devices.enabledOff')}
          hint={t('devices.enabledHint')}
          onChange={(next) => setDraft({ ...draft, enabled: next })}
        />
      }
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="btn-primary"
            disabled={
              isSaving || draft.displayName.trim() === '' || draft.host.trim() === ''
            }
          >
            {isSaving
              ? t('common.saving')
              : device === null
                ? t('devices.addDevice')
                : t('devices.saveChanges')}
          </button>
        </>
      }
    >
      {error !== null && <div className="banner is-error">{error}</div>}

      <div className="field-grid">
        <label className="field">
          <span>
            {t('devices.displayName')}
            <em className="field-required">{t('devices.required')}</em>
          </span>
          <input
            value={draft.displayName}
            autoFocus
            onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
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
      </div>

      <h3 className="card-subtitle">{t('devices.connection')}</h3>
      <AdapterConfigForm
        schema={schema}
        values={draft.config}
        secretsSet={draft.secretsSet}
        onChange={updateConfig}
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

      <h3 className="card-subtitle">{t('devices.suppression')}</h3>

      {/* One switch. The three per-category companions went when notification
          became rule-driven: silencing one kind of alert for one printer is a
          question of how a rule is scoped, and having a second place to answer
          it meant two screens to check when a printer went quiet. */}
      <ToggleSwitch
        checked={draft.isMuted}
        label={t('devices.maintenanceMode')}
        hint={t('devices.maintenanceModeHint')}
        onChange={(next) => setDraft({ ...draft, isMuted: next })}
      />
    </Modal>
  );
}
