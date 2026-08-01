/**
 * Translation, hand-rolled.
 *
 * This exists instead of react-i18next for the same reason the router in
 * router.tsx exists instead of react-router: the app needs a small, known
 * subset, and the library brings roughly 15KB gzipped plus a dependency tree to
 * audit for lookup, interpolation, and plurals — which is all of it. Backends,
 * namespaces, lazy loading, context, and the ICU message format are not used
 * here and would not be used later; two locales ship as JSON in the bundle.
 *
 * Scope is deliberately small: dotted key lookup, `{{name}}` interpolation, and
 * plural selection via `Intl.PluralRules`. Anything beyond that — gendered
 * forms, nested selects, per-route bundles — is a signal to reconsider a real
 * i18n library rather than to grow this file.
 *
 * Plurals go through `Intl.PluralRules` rather than a hand-written `n === 1`
 * check, because that check is only correct for English by accident. Spanish
 * agrees with it; Polish, Russian, and Arabic do not, and the first
 * contributor adding one of those should not have to rewrite this.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import en from './locales/en.json';
import es from './locales/es.json';

/** A locale the UI ships translations for. */
export type Locale = 'en' | 'es';

/** What an operator can choose. `system` follows the browser. */
export type LanguagePreference = 'system' | Locale;

export const LOCALES: readonly Locale[] = ['en', 'es'];

export const LANGUAGE_PREFERENCES: readonly LanguagePreference[] = ['system', 'en', 'es'];

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return LANGUAGE_PREFERENCES.includes(value as LanguagePreference);
}

/**
 * Endonyms — each language named in itself.
 *
 * Someone who has landed on a UI they cannot read is looking for the word they
 * recognise, and "Spanish" is not that word for them.
 */
export const LANGUAGE_LABELS: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
};

/**
 * A dictionary is nested JSON; values are strings, or an object of plural
 * categories keyed by CLDR category name (`one`, `other`, …).
 */
type Leaf = string | Record<string, string>;
interface Dictionary {
  [key: string]: Leaf | Dictionary;
}

const DICTIONARIES: Record<Locale, Dictionary> = {
  en: en as Dictionary,
  es: es as Dictionary,
};

export const FALLBACK_LOCALE: Locale = 'en';

/** Values substituted into `{{placeholders}}`. */
export type TranslationValues = Record<string, string | number>;

export type Translate = (key: string, values?: TranslationValues) => string;

function lookup(dictionary: Dictionary, key: string): Leaf | undefined {
  let node: Leaf | Dictionary | undefined = dictionary;

  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Dictionary)[segment];
    if (node === undefined) return undefined;
  }

  return typeof node === 'string' || (typeof node === 'object' && node !== null)
    ? (node as Leaf)
    : undefined;
}

/**
 * Substitutes `{{name}}` placeholders.
 *
 * A placeholder with no matching value is left as-is rather than blanked: a
 * visible `{{count}}` is a bug report, and an empty gap is a mystery.
 */
function interpolate(template: string, values: TranslationValues | undefined): string {
  if (values === undefined) return template;

  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Picks a plural form.
 *
 * `count` selects the CLDR category for the active locale; `other` is the
 * fallback, since every locale defines it and a missing category should degrade
 * to an understandable string rather than to the key.
 */
function selectPlural(
  forms: Record<string, string>,
  locale: Locale,
  count: number,
): string | undefined {
  const category = new Intl.PluralRules(locale).select(count);
  return forms[category] ?? forms['other'];
}

export function translate(
  locale: Locale,
  key: string,
  values?: TranslationValues,
): string {
  // The active locale first, then English. A key that a translator has not
  // reached yet shows the English string rather than a dotted path — untranslated
  // is a smaller failure than unreadable.
  const entry =
    lookup(DICTIONARIES[locale], key) ??
    (locale === FALLBACK_LOCALE ? undefined : lookup(DICTIONARIES[FALLBACK_LOCALE], key));

  if (entry === undefined) {
    // Returning the key makes a missing string obvious in the UI and searchable
    // in the source, which beats rendering nothing at all.
    return key;
  }

  if (typeof entry === 'string') return interpolate(entry, values);

  const count = values?.['count'];
  if (typeof count !== 'number') {
    // A plural entry used without a count is a mistake at the call site.
    return interpolate(entry['other'] ?? key, values);
  }

  return interpolate(selectPlural(entry, locale, count) ?? key, values);
}

/** Resolves a preference against what the browser asks for. */
export function resolveLocale(
  preference: LanguagePreference,
  languages: readonly string[] = typeof navigator === 'undefined'
    ? []
    : navigator.languages,
): Locale {
  if (preference !== 'system') return preference;

  for (const tag of languages) {
    // Matches on the primary subtag, so `es-419` and `es-MX` both find Spanish
    // rather than falling through to English on a technicality.
    const base = tag.toLowerCase().split('-')[0] as Locale;
    if (LOCALES.includes(base)) return base;
  }

  return FALLBACK_LOCALE;
}

interface I18nValue {
  locale: Locale;
  preference: LanguagePreference;
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

/**
 * Remembers the last resolved locale so a reload renders in the right language
 * immediately.
 *
 * The authoritative preference is a hub setting fetched from `/api/hub`, which
 * takes a moment. Without this the whole shell renders in English and then
 * flips, which is worse for the person who set it to Spanish than a brief delay
 * would be.
 */
const STORAGE_KEY = 'krembonet.locale';

export function readCachedLocale(): Locale | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored !== null && LOCALES.includes(stored as Locale)
      ? (stored as Locale)
      : null;
  } catch {
    // Private browsing, or storage disabled entirely. Costs a flash, nothing more.
    return null;
  }
}

function cacheLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // As above.
  }
}

export function I18nProvider({
  preference,
  children,
}: {
  preference: LanguagePreference;
  children: ReactNode;
}) {
  const [locale, setLocale] = useState<Locale>(() => resolveLocale(preference));

  useEffect(() => {
    const resolved = resolveLocale(preference);
    setLocale(resolved);
    cacheLocale(resolved);
    // Screen readers and `lang`-scoped CSS both depend on this being right.
    document.documentElement.lang = resolved;
  }, [preference]);

  const t = useCallback<Translate>(
    (key, values) => translate(locale, key, values),
    [locale],
  );

  const value = useMemo<I18nValue>(
    () => ({ locale, preference, t }),
    [locale, preference, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation(): I18nValue {
  const value = useContext(I18nContext);
  if (value === null) throw new Error('useTranslation must be used inside I18nProvider');
  return value;
}
