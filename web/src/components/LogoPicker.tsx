/**
 * Logo input: a URL field plus a file picker that inlines the image.
 *
 * The picker converts the file to a `data:` URL in the browser and drops it
 * into the same field a URL would go in — nothing is uploaded, and the server
 * stores one string either way. That is the whole point: a hub on a LAN with no
 * web server has nowhere to host a logo, and asking an operator to stand one up
 * to change a graphic is a poor trade.
 *
 * The cost is bytes. Base64 inflates by about a third, the result lives in a
 * settings row, and it is served on every `/api/hub` call — which is
 * unauthenticated and hit on every page load. So the limit here is deliberately
 * well under what the server accepts, and it is checked against the *encoded*
 * length, since that is what actually gets stored and sent.
 */
import { useId, useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';

/**
 * 128KB of encoded output, roughly 96KB of source image.
 *
 * Generous for a logo — an SVG wordmark is usually a few KB — and far below the
 * server's ~512KB ceiling, so a file that passes here cannot then be rejected
 * on save.
 */
const MAX_ENCODED_BYTES = 128 * 1024;

const ACCEPTED = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** What the file input offers, including extensions for pickers that ignore MIME. */
const ACCEPT_ATTR = '.svg,.png,.jpg,.jpeg,.webp,.gif,image/*';

/**
 * Size of the stored string, in terms an operator can act on.
 *
 * Rounding to whole KB reports a 700-byte SVG as "0KB", which reads as a
 * failed upload rather than a very small file.
 */
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

interface LogoPickerProps {
  value: string;
  onChange: (value: string) => void;
}

export function LogoPicker({ value, onChange }: LogoPickerProps) {
  const inputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  async function pick(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    // Resets immediately so choosing the same file twice still fires a change,
    // which is what happens when someone re-exports and picks it again.
    event.target.value = '';
    if (file === undefined) return;

    setError(null);

    // Checked by type where the browser supplies one, and otherwise let
    // through: some systems report an empty type for .svg, and refusing a
    // legitimate file on that basis is worse than letting the img tag decide.
    if (file.type !== '' && !ACCEPTED.includes(file.type)) {
      setError(`${file.type} is not an image format this accepts.`);
      return;
    }

    try {
      const dataUrl = await readAsDataUrl(file);

      if (dataUrl.length > MAX_ENCODED_BYTES) {
        setError(
          `That image encodes to ${Math.round(dataUrl.length / 1024)}KB, over the ${
            MAX_ENCODED_BYTES / 1024
          }KB limit. Export it smaller — an SVG or a trimmed PNG is usually a few KB.`,
        );
        return;
      }

      setFileName(file.name);
      onChange(dataUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function clear(): void {
    setFileName(null);
    setError(null);
    onChange('');
  }

  // A pasted URL and an inlined file end up in the same field, so the hint has
  // to say which one is in there — a 40,000-character data URL in a text box
  // is unreadable and looks like something has gone wrong.
  const isInlined = value.startsWith('data:');

  return (
    <div className="field field-wide">
      <span>Logo</span>

      <div className="logo-input-row">
        <input
          value={isInlined ? '' : value}
          placeholder="/assets/logo.svg  ·  https://…"
          aria-label="Logo URL"
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
        {/* A label rather than a button wrapping the input: it is the one way
            to restyle a file picker that keeps the native click and keyboard
            behaviour intact. */}
        <label htmlFor={inputId} className="btn-secondary logo-upload">
          <Upload size={14} strokeWidth={2} aria-hidden="true" />
          Upload logo file
        </label>

        {value !== '' && (
          <button
            type="button"
            className="btn-secondary"
            onClick={clear}
            aria-label="Remove logo"
            title="Remove logo"
          >
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>

      {isInlined && (
        <small className="field-hint">
          <strong>Embedded image</strong>
          {fileName !== null && ` · ${fileName}`} · {describeSize(value)} stored in the
          database. Remove it to go back to a URL.
        </small>
      )}

      {!isInlined && (
        <small className="field-hint">
          Shown in place of the name and subtitle. Paste a URL, or upload a file to embed
          it — embedding needs no web server, which is usually the easiest option on a
          LAN. SVG, PNG, JPG, WebP or GIF, up to {MAX_ENCODED_BYTES / 1024}KB encoded.
        </small>
      )}

      {error !== null && <small className="field-error">{error}</small>}
    </div>
  );
}
