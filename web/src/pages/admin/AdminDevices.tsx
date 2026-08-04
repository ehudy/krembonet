/**
 * Device management: the list, and what can be done to a row from it.
 *
 * The form itself is a dialog — see `DeviceFormModal`. It used to be a card
 * appended below the table, which meant that clicking Edit on the fourth row
 * scrolled the thing being edited out of sight of the row that opened it, and
 * that a page carrying a table, a discovery panel and an open form had no
 * obvious answer to "what am I looking at".
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';

import { api } from '../../api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { SortableHeader } from '../../components/SortableHeader.js';
import { ToggleSwitch } from '../../components/ToggleSwitch.js';
import { useTranslation } from '../../i18n/i18n.js';
import { compareText, toggleSort, type SortState } from '../../lib/tableSort.js';
import type { AdapterInfo, AdminDevice } from '../../types.js';
import { AutoDiscover } from './AutoDiscover.js';
import { DeviceFormModal } from './DeviceFormModal.js';

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
  /** `null` is closed; `{ device: null }` is adding; `{ device }` is editing. */
  const [editor, setEditor] = useState<{ device: AdminDevice | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminDevice | null>(null);
  /** The device whose switch is mid-flight, so only its own row shows busy. */
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
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

  const sorted = [...(devices ?? [])].sort((a, b) => compareDevices(a, b, sort));

  function sortBy(field: SortField): void {
    // Every column here is text, so ascending is the useful first click on all
    // four — no per-column natural direction to look up.
    setSort((current) => toggleSort(current, field));
  }

  /**
   * Pauses or resumes polling from the table, without opening the form.
   *
   * A one-field patch: the update route leaves every column the body does not
   * mention alone, so this cannot disturb a config or a mute flag on its way
   * past. Reloads rather than patching the row in place — the server clears and
   * rehydrates its cache on a device update, and a row that disagreed with what
   * the next poll will do is worse than a moment's wait.
   */
  async function toggleEnabled(device: AdminDevice): Promise<void> {
    setTogglingId(device.id);
    setError(null);
    setNotice(null);

    try {
      await api.updateDevice(device.id, { enabled: !device.enabled });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTogglingId(null);
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
          {adapters.length > 0 && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setEditor({ device: null });
                setNotice(null);
              }}
            >
              <Plus size={15} strokeWidth={2} aria-hidden="true" />
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
                {/* No visible header: the column is a row of switches, and any
                    word over them would be wider than the control itself. */}
                <th scope="col" className="enabled-column">
                  <span className="visually-hidden">{t('devices.enabled')}</span>
                </th>
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
                  <td className="enabled-column">
                    {/* Takes effect on the click. The row dims when it goes
                        off, which is the badge this replaces — a pill saying
                        "Disabled" beside a switch that is visibly off says the
                        same thing twice. */}
                    <ToggleSwitch
                      checked={device.enabled}
                      disabled={togglingId !== null}
                      ariaLabel={t('devices.pollingAria', { name: device.displayName })}
                      onChange={() => void toggleEnabled(device)}
                    />
                  </td>
                  <td>
                    <strong>{device.displayName}</strong>
                    {device.location !== null && (
                      <small className="muted"> · {device.location}</small>
                    )}
                    {device.model !== null && (
                      <small className="muted"> · {device.model}</small>
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
                        setEditor({ device });
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

      {editor !== null && (
        <DeviceFormModal
          device={editor.device}
          adapters={adapters}
          onClose={() => setEditor(null)}
          onSaved={(message) => {
            setEditor(null);
            setNotice(message);
            void load();
          }}
        />
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
