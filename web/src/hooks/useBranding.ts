/**
 * Applies operator-owned branding to the live document.
 *
 * Two things reach outside React here, both deliberately:
 *
 *  - the theme lands on `<html data-theme>` rather than a wrapper class, so the
 *    variables in global.css cascade to everything including the scrollbar and
 *    the browser's own form controls via `color-scheme`;
 *  - the custom stylesheet is a single `<style>` element in `<head>`, appended
 *    after the bundled CSS so an operator's rule wins a specificity tie without
 *    needing `!important` on every line.
 *
 * Both are torn down on unmount and both are written to the same element every
 * time, so a settings change repaints in place instead of stacking a second
 * stylesheet on top of the first.
 */
import { useEffect, useState } from 'react';

import { api } from '../api.js';
import { readCachedLocale } from '../i18n/i18n.js';
import type { HubBranding, ThemeName } from '../types.js';

export const DEFAULT_HUB_TITLE = 'KremboNet';

const STYLE_ELEMENT_ID = 'krembonet-custom-css';

const DEFAULT_BRANDING: HubBranding = {
  title: DEFAULT_HUB_TITLE,
  // Until the fetch resolves the hub has no opinion about its own version, and
  // certainly none about updates.
  currentVersion: '',
  latestVersion: null,
  updateAvailable: false,
  releaseUrl: null,
  releaseName: null,
  releaseNotes: null,
  publishedAt: null,
  checkedAt: null,
  // Blank rather than the server's default string: this is what renders before
  // the fetch resolves, and a subtitle that appears and then vanishes on a hub
  // that has none is worse than one that arrives a moment late.
  subtitle: '',
  logoUrl: '',
  theme: 'system',
  // Seeded from the last resolved locale so the first paint is already in the
  // right language. Without it the whole shell renders in English and then
  // flips, which is worse for a Spanish operator than a brief delay would be.
  language: readCachedLocale() ?? 'system',
  customCss: '',
};

function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset['theme'] = theme;
}

function applyCustomCss(css: string): void {
  const existing = document.getElementById(STYLE_ELEMENT_ID);

  if (css === '') {
    existing?.remove();
    return;
  }

  const element = existing ?? document.createElement('style');
  if (existing === null) {
    element.id = STYLE_ELEMENT_ID;
    document.head.append(element);
  }
  // textContent, never innerHTML: the string is stored sanitised, but a
  // stylesheet is text and parsing it as markup is how a CSS box becomes an
  // injection point.
  element.textContent = css;
}

/**
 * Fetches branding once and keeps the document in sync with it.
 *
 * A failed fetch keeps the defaults rather than blanking the shell: an
 * unreachable server should surface as the connection error the pages already
 * render, not as an unnamed, unstyled hub.
 */
export function useBranding(): HubBranding {
  const [branding, setBranding] = useState<HubBranding>(DEFAULT_BRANDING);

  useEffect(() => {
    const controller = new AbortController();

    api
      .getHub(controller.signal)
      .then((hub) => {
        setBranding({
          ...hub,
          title: hub.title === '' ? DEFAULT_HUB_TITLE : hub.title,
          // Not defaulted: blank is the operator saying "no subtitle".
          subtitle: hub.subtitle ?? '',
          logoUrl: hub.logoUrl ?? '',
          theme: hub.theme,
          customCss: hub.customCss,
        });
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, []);

  useEffect(() => {
    applyTheme(branding.theme);
  }, [branding.theme]);

  useEffect(() => {
    applyCustomCss(branding.customCss);
    return () => applyCustomCss('');
  }, [branding.customCss]);

  useEffect(() => {
    document.title = branding.title;
  }, [branding.title]);

  return branding;
}
