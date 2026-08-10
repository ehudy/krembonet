/**
 * Favicon input: a URL field plus a file picker that inlines the image.
 *
 * A sibling of `LogoPicker` with the same "paste a URL or embed a file" model,
 * differing in three ways that are specific to a tab icon: it accepts `.ico`
 * (and drops the photographic formats that make no sense at 16px), it shows a
 * small live preview of the actual icon, and it says plainly that leaving it
 * blank falls back to the logo.
 *
 * Like the logo, an embedded file becomes a `data:` URL stored in one settings
 * string, so a LAN hub with no web server can still set an icon. The encoded
 * limit is deliberately well under the server's ceiling so a file that passes
 * here cannot be rejected on save.
 */
import { useId, useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';

import { useTranslation } from '../i18n/i18n.js';

/** 128KB encoded, roughly 96KB of source — ample for a tab icon. */
const MAX_ENCODED_BYTES = 128 * 1024;

const ACCEPTED = [
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/png',
  'image/svg+xml',
  'image/webp',
];

/** What the file input offers, including extensions for pickers that ignore MIME. */
const ACCEPT_ATTR = '.ico,.png,.svg,.webp,image/*';

function describeSize(value: string): string {
  return value.length < 1024 ? '<1KB' : `${Math.round(value.length / 1024)}KB`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Forces a `.ico` file to a recognised MIME.
 *
 * Browsers frequently report an empty or `application/octet-stream` type for
 * `.ico`, which `FileReader` then bakes into the data URL — and the server's
 * favicon validator, rightly, only accepts image types. When the picked file is
 * a `.ico`, rewrite the prefix to `image/x-icon` so an embed round-trips.
 */
function normalizeIcoDataUrl(dataUrl: string, file: File): string {
  const isIco = /\.ico$/i.test(file.name) || /icon/i.test(file.type);
  if (!isIco) return dataUrl;
  if (/^data:image\/(x-icon|vnd\.microsoft\.icon)/i.test(dataUrl)) return dataUrl;
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return dataUrl;
  return `data:image/x-icon;base64,${dataUrl.slice(comma + 1)}`;
}

interface FaviconPickerProps {
  value: string;
  onChange: (value: string) => void;
}

export function FaviconPicker({ value, onChange }: FaviconPickerProps) {
  const { t } = useTranslation();
  const inputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  async function pick(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    // Reset so re-picking the same file still fires a change.
    event.target.value = '';
    if (file === undefined) return;

    setError(null);

    // Checked where the browser supplies a type, otherwise let through: `.ico`
    // and `.svg` are commonly reported with an empty type, and refusing a
    // legitimate icon on that basis is worse than embedding it.
    if (file.type !== '' && !ACCEPTED.includes(file.type)) {
      setError(t('settings.faviconWrongType', { type: file.type }));
      return;
    }

    try {
      const dataUrl = normalizeIcoDataUrl(await readAsDataUrl(file), file);

      if (dataUrl.length > MAX_ENCODED_BYTES) {
        setError(
          t('settings.faviconTooBig', {
            size: Math.round(dataUrl.length / 1024),
            limit: MAX_ENCODED_BYTES / 1024,
          }),
        );
        return;
      }

      setFileName(file.name);
      onChange(dataUrl);
    } catch {
      setError(t('settings.faviconUnreadable'));
    }
  }

  function clear(): void {
    setFileName(null);
    setError(null);
    onChange('');
  }

  const isInlined = value.startsWith('data:');

  return (
    <div className="field field-wide">
      <span>{t('settings.favicon')}</span>

      <div className="logo-input-row">
        {/* The preview sits in the row so an operator sees the actual tab icon
            at tab size, not scaled up in a card. */}
        {value !== '' && (
          <img className="favicon-preview" src={value} alt={t('settings.faviconPreviewAlt')} />
        )}

        <input
          value={isInlined ? '' : value}
          placeholder="/favicon.ico  ·  https://…"
          aria-label={t('settings.faviconUrlLabel')}
          disabled={isInlined}
          onChange={(event) => onChange(event.target.value)}
        />

        <input
          ref={fileRef}
          id={inputId}
          type="file"
          className="visually-hidden"
          accept={ACCEPT_ATTR}
          onChange={(event) => void pick(event)}
        />
        <label htmlFor={inputId} className="btn-secondary logo-upload">
          <Upload size={14} strokeWidth={2} aria-hidden="true" />
          {t('settings.faviconUpload')}
        </label>

        {value !== '' && (
          <button
            type="button"
            className="btn-secondary"
            onClick={clear}
            aria-label={t('settings.faviconRemove')}
            title={t('settings.faviconRemove')}
          >
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>

      {isInlined && (
        <small className="field-hint">
          <strong>{t('settings.faviconEmbedded')}</strong>
          {fileName !== null && ` · ${fileName}`} ·{' '}
          {t('settings.faviconEmbeddedHint', { size: describeSize(value) })}
        </small>
      )}

      {!isInlined && (
        <small className="field-hint">
          {t('settings.faviconHint', { limit: MAX_ENCODED_BYTES / 1024 })}
        </small>
      )}

      {value === '' && <small className="field-hint">{t('settings.faviconFallback')}</small>}

      {error !== null && <small className="field-error">{error}</small>}
    </div>
  );
}
