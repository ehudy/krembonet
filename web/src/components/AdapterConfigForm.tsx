/**
 * Renders an adapter's config form from its declared schema.
 *
 * This is what makes adding an adapter a server-side change. Nothing here knows
 * what SNMP or IPP is; it knows about field types, conditional visibility, and
 * that secret values are never sent to the browser.
 */
import { useTranslation } from '../i18n/i18n.js';
import type { ConfigField } from '../types.js';

export type ConfigValues = Record<string, unknown>;

/** Defaults from the schema, for a device that does not exist yet. */
export function defaultsFor(schema: ConfigField[]): ConfigValues {
  const values: ConfigValues = {};
  for (const field of schema) {
    if (field.default !== undefined) values[field.key] = field.default;
  }
  return values;
}

/** A field is hidden when its `visibleWhen` condition is not met. */
export function isVisible(field: ConfigField, values: ConfigValues): boolean {
  if (field.visibleWhen === undefined) return true;
  return field.visibleWhen.values.includes(String(values[field.visibleWhen.key] ?? ''));
}

/**
 * Strips values belonging to hidden fields.
 *
 * Without this, switching SNMP v3 back to v2c would still submit the v3
 * username and keys, and the adapter would validate rules that no longer apply.
 */
export function visibleValues(schema: ConfigField[], values: ConfigValues): ConfigValues {
  const result: ConfigValues = {};
  for (const field of schema) {
    if (!isVisible(field, values)) continue;
    if (values[field.key] !== undefined) result[field.key] = values[field.key];
  }
  return result;
}

interface Props {
  schema: ConfigField[];
  values: ConfigValues;
  /** Secret keys already stored, so the field can say so instead of looking empty. */
  secretsSet?: string[];
  onChange: (key: string, value: unknown) => void;
}

export function AdapterConfigForm({ schema, values, secretsSet = [], onChange }: Props) {
  const { t } = useTranslation();

  const visible = schema.filter((field) => isVisible(field, values));

  if (visible.length === 0) {
    return <p className="muted">{t('devices.noConfig')}</p>;
  }

  return (
    <div className="field-grid">
      {visible.map((field) => {
        const value = values[field.key];
        const stored = secretsSet.includes(field.key);

        if (field.type === 'boolean') {
          return (
            <label key={field.key} className="field field-check">
              <input
                type="checkbox"
                checked={value === true}
                onChange={(event) => onChange(field.key, event.target.checked)}
              />
              <span>
                {field.label}
                {field.help !== undefined && <small>{field.help}</small>}
              </span>
            </label>
          );
        }

        if (field.type === 'select') {
          return (
            <label key={field.key} className="field">
              <span>{field.label}</span>
              <select
                value={String(value ?? field.default ?? '')}
                onChange={(event) => onChange(field.key, event.target.value)}
              >
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {field.help !== undefined && (
                <small className="field-hint">{field.help}</small>
              )}
            </label>
          );
        }

        return (
          <label key={field.key} className="field">
            <span>
              {field.label}
              {field.required === true && <em className="field-required"> *</em>}
            </span>
            <input
              type={
                field.secret === true
                  ? 'password'
                  : field.type === 'number'
                    ? 'number'
                    : 'text'
              }
              value={String(value ?? '')}
              autoComplete={field.secret === true ? 'new-password' : 'off'}
              placeholder={
                field.secret === true && stored
                  ? '•••••••• (stored)'
                  : field.default === undefined
                    ? ''
                    : String(field.default)
              }
              onChange={(event) =>
                onChange(
                  field.key,
                  field.type === 'number' && event.target.value !== ''
                    ? Number(event.target.value)
                    : event.target.value,
                )
              }
            />
            {field.secret === true && stored ? (
              <small className="field-hint">{t('devices.secretStored')}</small>
            ) : (
              field.help !== undefined && (
                <small className="field-hint">{field.help}</small>
              )
            )}
          </label>
        );
      })}
    </div>
  );
}
