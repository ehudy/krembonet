/**
 * Naming a paper code, and deciding where the name applies.
 *
 * One dialog behind three doors — "Add paper mapping", Edit on a saved mapping,
 * and "Map code" on something a printer is reporting — because all three are the
 * same three questions and only the starting values differ. The inline forms
 * they replace lived in table cells, which is where the scope picker had to be a
 * single dropdown: naming one code across three plotters meant filling the same
 * row in three times.
 *
 * Saving is planned rather than performed field by field, so that unticking a
 * printer removes its row instead of leaving an override in place that quietly
 * outranks the mapping the operator thinks they just edited. See
 * `lib/mediaScopes.ts` for the plan.
 */
import { useState } from 'react';
import { Sparkles } from 'lucide-react';

import { api } from '../../api.js';
import { Modal } from '../../components/Modal.js';
import { useTranslation } from '../../i18n/i18n.js';
import { COMMON_MEDIA_LIST_ID, suggestMediaName } from '../../lib/mediaSuggestions.js';
import { planMappingSave, type MediaMapping } from '../../lib/mediaScopes.js';

/** Just the fields the scope picker and the "Applies to" column need. */
export interface ScopeDevice {
  id: number;
  displayName: string;
  location?: string | null;
}

export interface PaperMappingModalProps {
  /** The mapping being edited; null when adding a new one. */
  original: MediaMapping | null;
  /** Pre-fills for the "Map code" route, where the code is already known. */
  initialCode?: string;
  initialName?: string;
  devices: readonly ScopeDevice[];
  onClose: () => void;
  /** The page reloads and says so; the dialog only reports what it saved. */
  onSaved: (code: string) => void;
}

export function PaperMappingModal({
  original,
  initialCode = '',
  initialName = '',
  devices,
  onClose,
  onSaved,
}: PaperMappingModalProps) {
  const { t } = useTranslation();

  const [code, setCode] = useState(original?.code ?? initialCode);
  const [name, setName] = useState(original?.friendlyName ?? initialName);
  const [scope, setScope] = useState<'all' | 'selected'>(
    original !== null && !original.isGlobal ? 'selected' : 'all',
  );
  const [deviceIds, setDeviceIds] = useState<number[]>(original?.deviceIds ?? []);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A proposal, not an answer: it fills the field and stops there, so a name is
  // only ever stored because a person read it and pressed Save. The vendor table
  // it comes from is a convention rather than a standard, and can be wrong for a
  // given firmware. Hidden once the field has text, so it never looks like it
  // will overwrite typing.
  const suggestion = name.trim() === '' ? suggestMediaName(code) : null;

  const scopeChosen = scope === 'all' || deviceIds.length > 0;
  const isComplete = code.trim() !== '' && name.trim() !== '' && scopeChosen;

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!isComplete || isSaving) return;

    setIsSaving(true);
    setError(null);

    const plan = planMappingSave(
      {
        code,
        friendlyName: name,
        deviceIds: scope === 'all' ? null : deviceIds,
      },
      original,
    );

    try {
      // Writes first, then the rows they replace: a failure part way through
      // leaves the new mapping in place rather than nothing at all.
      for (const write of plan.writes) {
        await api.saveMediaType(write.code, write.friendlyName, write.deviceId);
      }
      for (const id of plan.deleteIds) {
        await api.deleteMediaType(id);
      }

      onSaved(plan.writes[0]?.code ?? code.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal
      title={
        original === null ? t('paperTypes.addModalTitle') : t('paperTypes.editModalTitle')
      }
      onClose={onClose}
      onSubmit={(event) => void save(event)}
      footerLayout="split"
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="btn-primary"
            disabled={!isComplete || isSaving}
          >
            {isSaving ? t('common.saving') : t('common.save')}
          </button>
        </>
      }
    >
      {error !== null && <div className="banner is-error">{error}</div>}

      <div className="field-grid">
        <label className="field">
          <span>
            {t('paperTypes.mediaCode')}
            <em className="field-required">{t('devices.required')}</em>
          </span>
          <input
            value={code}
            // Only when the code is not already known: arriving from "Map code"
            // or from Edit, the answer that needs typing is the name.
            autoFocus={code === ''}
            placeholder={t('paperTypes.codePlaceholder')}
            onChange={(event) => setCode(event.target.value)}
          />
          <small className="field-hint">{t('paperTypes.codeHint')}</small>
        </label>

        <label className="field">
          <span>
            {t('paperTypes.friendlyName')}
            <em className="field-required">{t('devices.required')}</em>
          </span>
          <input
            list={COMMON_MEDIA_LIST_ID}
            value={name}
            autoFocus={code !== ''}
            placeholder={t('paperTypes.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
          />
          {suggestion !== null && (
            <button
              type="button"
              className="suggest-button"
              title={t('paperTypes.suggestTitle')}
              onClick={() => setName(suggestion)}
            >
              <Sparkles size={13} strokeWidth={2} aria-hidden="true" />
              {t('paperTypes.suggest', { name: suggestion })}
            </button>
          )}
        </label>
      </div>

      <h3 className="card-subtitle">{t('paperTypes.appliesTo')}</h3>

      <div className="choice-row">
        {(['all', 'selected'] as const).map((option) => (
          <label
            key={option}
            className={`choice${scope === option ? ' is-selected' : ''}`}
          >
            <input
              type="radio"
              name="mappingScope"
              checked={scope === option}
              onChange={() => setScope(option)}
            />
            <span>
              {option === 'all'
                ? t('paperTypes.scopeGlobalOption')
                : t('paperTypes.scopeSelectedOption')}
              <small>
                {option === 'all'
                  ? t('paperTypes.scopeGlobalHint')
                  : t('paperTypes.scopeSelectedHint')}
              </small>
            </span>
          </label>
        ))}
      </div>

      {scope === 'selected' &&
        (devices.length === 0 ? (
          <small className="field-hint">{t('paperTypes.noPrinters')}</small>
        ) : (
          <div className="field">
            <div className="checkbox-list">
              {devices.map((device) => (
                <label key={device.id} className="field field-check">
                  <input
                    type="checkbox"
                    checked={deviceIds.includes(device.id)}
                    onChange={(event) =>
                      setDeviceIds((current) =>
                        event.target.checked
                          ? [...current, device.id]
                          : current.filter((id) => id !== device.id),
                      )
                    }
                  />
                  <span>
                    {device.displayName}
                    {device.location != null && device.location !== '' && (
                      <small>{device.location}</small>
                    )}
                  </span>
                </label>
              ))}
            </div>
            {/* Says why Save is unavailable, rather than leaving a disabled
                button to be stared at. */}
            {deviceIds.length === 0 && (
              <small className="field-hint">{t('paperTypes.pickPrinter')}</small>
            )}
          </div>
        ))}
    </Modal>
  );
}
