/**
 * Getting text out of the browser: to a file, or to the clipboard.
 *
 * Both have a wrinkle that matters specifically for this app. A KremboNet hub
 * is normally reached over plain HTTP at a LAN address, which is *not* a secure
 * context — so `navigator.clipboard` is simply undefined there. Code that
 * assumes it exists produces a button that does nothing on the deployment the
 * project is actually built for, and works perfectly on the developer's
 * localhost.
 */

/**
 * Saves text as a file.
 *
 * A Blob and an object URL rather than a `data:` URI: a fleet of a few hundred
 * supplies produces a CSV comfortably past the length some browsers accept in a
 * URL, and the failure mode there is a silently truncated download.
 */
/**
 * Byte-order mark.
 *
 * This is what makes Excel open a UTF-8 CSV as UTF-8. Without it a printer
 * named "Sótano" arrives as "SÃ³tano" on a Windows machine, which is the single
 * most common complaint about exported CSVs. Written as an escape rather than
 * the literal character, which is invisible in an editor and reads as a stray
 * space to anything scanning the source.
 */
const UTF8_BOM = '\uFEFF';

export function downloadText(filename: string, contents: string, type: string): void {
  const blob = new Blob([`${UTF8_BOM}${contents}`], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  // Firefox requires the anchor to be in the document for a programmatic click
  // to count as a user-initiated download.
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  // Deferred, because revoking synchronously can cancel the download in Safari
  // before it has read the blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Copies text, falling back to the deprecated path outside a secure context.
 *
 * `document.execCommand('copy')` is deprecated and still the only thing that
 * works over plain HTTP, which is how this hub is normally reached. It needs
 * real selected text in the document, hence the offscreen textarea.
 *
 * Returns whether it worked, so the caller can say so rather than leaving the
 * operator wondering whether the button did anything.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission refused, or the document was not focused. Fall through —
      // the legacy path often still succeeds.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Off-screen rather than hidden: a `display:none` element cannot be selected,
  // and `position:fixed` avoids scrolling the page to reach it.
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.opacity = '0';
  document.body.append(textarea);

  try {
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
