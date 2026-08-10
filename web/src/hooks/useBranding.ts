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

/** Last resort of the favicon fallback chain — the browser's default request. */
const DEFAULT_FAVICON = '/favicon.ico';

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
  faviconUrl: '',
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

/**
 * Points the browser tab icon at the operator's favicon.
 *
 * Fallback chain: an explicit `faviconUrl`, then the `logoUrl` so a hub that
 * only set a logo still gets a matching tab icon, then the static
 * `/favicon.ico`. Writes to a single `<link rel="icon">` — reusing one the page
 * already ships or creating it once — so a settings change repaints the tab in
 * place rather than leaving the browser to choose between stacked icons.
 *
 * Exported so the settings form can preview a pick live, before it is saved.
 */
export function applyFavicon(faviconUrl: string, logoUrl: string): void {
  const href = faviconUrl !== '' ? faviconUrl : logoUrl !== '' ? logoUrl : DEFAULT_FAVICON;

  let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
  if (link === null) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }

  // Only when it actually changed: rewriting an identical href makes some
  // browsers re-request the image and flicker the tab.
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
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
          faviconUrl: hub.faviconUrl ?? '',
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

  // No teardown: this hook lives for the app's lifetime, and reverting the tab
  // icon to the default on unmount would be wrong. The settings form applies its
  // own live preview on top of this and the two write to the same element.
  useEffect(() => {
    applyFavicon(branding.faviconUrl, branding.logoUrl);
  }, [branding.faviconUrl, branding.logoUrl]);

  return branding;
}
