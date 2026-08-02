/**
 * The final word on what to call a loaded media, across all four tiers.
 *
 * The server has already applied tiers 1 and 2 — a device override, then the
 * global mapping — into `mediaTypeName`. This adds tier 3 (the built-in
 * standard dictionary, localised) and tier 4 (the raw code), and reports which
 * one answered so the UI can style it: a genuinely unknown vendor code is the
 * only thing that earns the "unmapped" badge.
 *
 * Every media surface goes through here so they cannot disagree about what
 * counts as unmapped — the same drift the supply thresholds had before they
 * were centralised.
 */
import type { Translate } from '../i18n/i18n.js';
import { standardMediaKey } from './standardMedia.js';

export interface MediaLabel {
  /** The name to show, or null when only the raw code is known. */
  name: string | null;
  /** The raw code, shown when `name` is null. */
  code: string | null;
  /** True only for an unknown vendor code — the one case that is "unmapped". */
  isUnmapped: boolean;
  /** True when the name came from the standard dictionary rather than a mapping. */
  isStandard: boolean;
}

/** A media source reduced to the two fields resolution needs. */
export interface ResolvableMedia {
  mediaTypeName: string | null;
  mediaTypeCode: string | null;
}

export function resolveMediaLabel(source: ResolvableMedia, t: Translate): MediaLabel {
  // Tiers 1–2: the server already resolved a device or global custom name.
  if (source.mediaTypeName !== null) {
    return {
      name: source.mediaTypeName,
      code: source.mediaTypeCode,
      isUnmapped: false,
      isStandard: false,
    };
  }

  // No code at all — an empty source. Not unmapped; there is simply nothing to
  // name.
  if (source.mediaTypeCode === null) {
    return { name: null, code: null, isUnmapped: false, isStandard: false };
  }

  // Tier 3: a standard PWG/IPP keyword, named from the built-in dictionary.
  const key = standardMediaKey(source.mediaTypeCode);
  if (key !== null) {
    return {
      name: t(`standardMedia.${key}`),
      code: source.mediaTypeCode,
      isUnmapped: false,
      isStandard: true,
    };
  }

  // Tier 4: a vendor code nobody has named. This is the only "unmapped" case.
  return {
    name: null,
    code: source.mediaTypeCode,
    isUnmapped: true,
    isStandard: false,
  };
}
