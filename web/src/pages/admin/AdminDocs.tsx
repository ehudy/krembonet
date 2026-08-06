/**
 * The Admin → Documentation tab.
 *
 * Renders the repo's guides in-app: a category picker, a filter bar, an on-page
 * contents list, and the rendered Markdown. The guides are the same files that
 * live in `docs/`, imported at build time — so what an operator reads here and
 * what a contributor reads in the repo are one and the same.
 *
 * Deep links work both ways: another page can send someone straight to a heading
 * (the contextual help links do), and the contents list and in-doc links scroll
 * without a full navigation.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';

import { Markdown } from '../../components/Markdown.js';
import { useTranslation } from '../../i18n/i18n.js';
import { useRouter } from '../../router.js';
import {
  DOC_CATEGORIES,
  DEFAULT_DOC_CATEGORY,
  docPath,
  findDocCategory,
} from '../../lib/docs.js';
import { parseMarkdown, sectionize } from '../../lib/markdown.js';

function scrollToAnchor(id: string): void {
  const element = document.getElementById(id);
  if (element === null) return;
  element.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function AdminDocs({ categoryId }: { categoryId: string | undefined }) {
  const { t } = useTranslation();
  const { navigate } = useRouter();

  const category = findDocCategory(categoryId) ?? findDocCategory(DEFAULT_DOC_CATEGORY);
  const [query, setQuery] = useState('');

  // Set by a cross-category jump so the scroll can wait for the new doc to mount.
  const pendingAnchor = useRef<string | null>(null);

  const blocks = useMemo(
    () => (category === undefined ? [] : parseMarkdown(category.source)),
    [category],
  );
  const sections = useMemo(() => sectionize(blocks), [blocks]);

  const needle = query.trim().toLowerCase();
  const visibleSections = useMemo(
    () => (needle === '' ? sections : sections.filter((section) => section.text.includes(needle))),
    [sections, needle],
  );

  const visibleBlocks = useMemo(
    () => visibleSections.flatMap((section) => section.blocks),
    [visibleSections],
  );

  const toc = useMemo(
    () =>
      visibleSections
        .filter((section) => section.level === 2 && section.id !== '')
        .map((section) => ({ id: section.id, title: section.title })),
    [visibleSections],
  );

  // On arrival, and whenever the category changes, honour a pending or URL hash.
  useEffect(() => {
    const anchor = pendingAnchor.current ?? window.location.hash.slice(1);
    pendingAnchor.current = null;
    if (anchor === '') return;
    // A frame later, so the freshly rendered headings exist to scroll to.
    const raf = window.requestAnimationFrame(() => scrollToAnchor(anchor));
    return () => window.cancelAnimationFrame(raf);
  }, [categoryId]);

  function jump(targetCategory: string, anchor: string | null): void {
    setQuery('');
    const resolved = targetCategory === '' ? (category?.id ?? DEFAULT_DOC_CATEGORY) : targetCategory;

    if (resolved !== category?.id) {
      // Different guide: let it mount, then scroll.
      pendingAnchor.current = anchor;
      navigate(docPath(resolved));
      if (anchor !== null) {
        window.history.replaceState(null, '', `${docPath(resolved)}#${anchor}`);
      }
      return;
    }

    if (anchor !== null) {
      window.history.replaceState(null, '', `${docPath(resolved)}#${anchor}`);
      window.requestAnimationFrame(() => scrollToAnchor(anchor));
    }
  }

  if (category === undefined) return null;

  return (
    <div className="docs">
      <nav className="tabs is-sub" aria-label={t('docs.categoriesLabel')}>
        {DOC_CATEGORIES.map((entry) => (
          <a
            key={entry.id}
            href={docPath(entry.id)}
            className={`tab${entry.id === category.id ? ' is-active' : ''}`}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.button !== 0) return;
              event.preventDefault();
              jump(entry.id, null);
            }}
          >
            {t(entry.titleKey)}
          </a>
        ))}
      </nav>

      <p className="docs-blurb muted">{t(category.blurbKey)}</p>

      <div className="docs-search">
        <Search size={15} strokeWidth={2} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder={t('docs.searchPlaceholder')}
          aria-label={t('docs.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="docs-layout">
        {toc.length > 0 && (
          <aside className="docs-toc" aria-label={t('docs.onThisPage')}>
            <span className="docs-toc-title">{t('docs.onThisPage')}</span>
            <ul>
              {toc.map((entry) => (
                <li key={entry.id}>
                  <a
                    href={`${docPath(category.id)}#${entry.id}`}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.button !== 0) return;
                      event.preventDefault();
                      jump('', entry.id);
                    }}
                  >
                    {entry.title}
                  </a>
                </li>
              ))}
            </ul>
          </aside>
        )}

        <div className="docs-main">
          {visibleBlocks.length === 0 ? (
            <div className="banner is-warning">{t('docs.noResults', { query })}</div>
          ) : (
            <Markdown blocks={visibleBlocks} query={query} onInternalLink={jump} />
          )}
        </div>
      </div>
    </div>
  );
}
