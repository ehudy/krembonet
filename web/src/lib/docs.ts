/**
 * The documentation registry.
 *
 * The three guides live in the repo's `docs/` folder — that is the single source
 * of truth — and are pulled in at build time with Vite's `?raw` suffix, so the
 * hub ships them without a runtime file read or a docs-serving endpoint. Editing
 * a guide and rebuilding is all it takes; there is no second copy to keep in
 * sync.
 */
import troubleshooting from '../../../docs/TROUBLESHOOTING.md?raw';
import deviceSetup from '../../../docs/DEVICE-SETUP.md?raw';
import architecture from '../../../docs/ARCHITECTURE.md?raw';

export interface DocCategory {
  id: string;
  /** Dictionary key for the sidebar label, resolved at render. */
  titleKey: string;
  /** Dictionary key for the one-line description under the title. */
  blurbKey: string;
  source: string;
  /** The doc's own filename, so in-doc `FILE.md` links resolve back to it. */
  file: string;
}

export const DOC_CATEGORIES: readonly DocCategory[] = [
  {
    id: 'troubleshooting',
    titleKey: 'docs.categories.troubleshooting',
    blurbKey: 'docs.blurbs.troubleshooting',
    source: troubleshooting,
    file: 'TROUBLESHOOTING.md',
  },
  {
    id: 'device-setup',
    titleKey: 'docs.categories.deviceSetup',
    blurbKey: 'docs.blurbs.deviceSetup',
    source: deviceSetup,
    file: 'DEVICE-SETUP.md',
  },
  {
    id: 'architecture',
    titleKey: 'docs.categories.architecture',
    blurbKey: 'docs.blurbs.architecture',
    source: architecture,
    file: 'ARCHITECTURE.md',
  },
];

export const DEFAULT_DOC_CATEGORY = 'troubleshooting';

export function findDocCategory(id: string | undefined): DocCategory | undefined {
  return DOC_CATEGORIES.find((category) => category.id === id);
}

/** Where the Documentation tab lives, so links point at one place. */
export function docPath(categoryId: string): string {
  return `/admin/docs/${categoryId}`;
}

/**
 * Sends the user to a guide, optionally at a heading, from anywhere in the app.
 *
 * The custom router tracks the pathname only, so the fragment is set directly
 * rather than through `navigate` — `AdminDocs` reads it on mount to scroll —
 * which keeps the router's path state a clean pathname.
 */
export function navigateToDoc(
  navigate: (to: string) => void,
  categoryId: string,
  anchor?: string | null,
): void {
  navigate(docPath(categoryId));
  if (anchor !== undefined && anchor !== null) {
    window.history.replaceState(null, '', `${docPath(categoryId)}#${anchor}`);
  }
}

/**
 * Stable pointers for the contextual help links, so a heading rename that
 * changes a slug is a one-line fix here rather than a hunt through components.
 * The anchor must match `slugify()` of the heading it targets.
 */
export const DOC_LINKS = {
  ippRefused: { category: 'troubleshooting', anchor: 'print-queues-and-ipp-status-refusals' },
  offline: { category: 'troubleshooting', anchor: 'network-and-connectivity' },
} as const;

/**
 * Resolves a link href found inside a doc.
 *
 * A bare `FILE.md` (optionally with `#anchor`) is another guide in this hub, so
 * it navigates within the Documentation tab. An `http(s)`/`mailto` link is
 * external. Anything else — a repo path like `docs/canon-….md` — is left as a
 * plain, inert reference, since it has no page here.
 */
export type ResolvedDocLink =
  | { kind: 'internal'; categoryId: string; anchor: string | null }
  | { kind: 'external'; href: string }
  | { kind: 'inert'; href: string };

export function resolveDocLink(href: string): ResolvedDocLink {
  if (/^(https?:|mailto:)/i.test(href)) return { kind: 'external', href };

  if (href.startsWith('#')) {
    // A same-page anchor: keep the current category, jump to the heading.
    return { kind: 'internal', categoryId: '', anchor: href.slice(1) };
  }

  const [file, anchor] = href.split('#');
  const category = DOC_CATEGORIES.find((entry) => entry.file === file);
  if (category !== undefined) {
    return { kind: 'internal', categoryId: category.id, anchor: anchor ?? null };
  }

  return { kind: 'inert', href };
}
