/**
 * Renders parsed Markdown blocks as React elements.
 *
 * Every string becomes a text node, so React escapes it — there is no
 * `dangerouslySetInnerHTML` here and a doc cannot smuggle in markup. The parser
 * (`lib/markdown.ts`) does the reading; this only chooses elements.
 *
 * Links are doc-aware: a `FILE.md` reference navigates within the Documentation
 * tab via `onInternalLink`, an http link opens in a new tab, and a bare repo
 * path is shown inert rather than sent through the SPA router to 404.
 */
import { AlertTriangle, Info, Lightbulb, TriangleAlert, type LucideIcon } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';

import {
  type Block,
  type CalloutVariant,
  type InlineToken,
} from '../lib/markdown.js';
import { resolveDocLink } from '../lib/docs.js';

interface MarkdownProps {
  blocks: readonly Block[];
  /** Called for an internal `FILE.md`/`#anchor` link; empty categoryId means "this doc". */
  onInternalLink?: (categoryId: string, anchor: string | null) => void;
  /** A search term to mark in body text, so a filtered hit is easy to spot. */
  query?: string;
}

const CALLOUT_ICON: Record<CalloutVariant, LucideIcon> = {
  note: Info,
  tip: Lightbulb,
  important: TriangleAlert,
  warning: AlertTriangle,
};

/** Shown when a callout has no title of its own. Capitalised, unlike the variant id. */
const CALLOUT_LABEL: Record<CalloutVariant, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
};

/** Wraps case-insensitive matches of `query` in a <mark>, leaving the rest as text. */
function markQuery(value: string, query: string | undefined): ReactNode {
  const needle = query?.trim() ?? '';
  if (needle.length < 2) return value;

  const parts: ReactNode[] = [];
  const lower = value.toLowerCase();
  const target = needle.toLowerCase();
  let from = 0;
  let at = lower.indexOf(target);

  while (at !== -1) {
    if (at > from) parts.push(value.slice(from, at));
    parts.push(
      <mark className="doc-hit" key={`${at}`}>
        {value.slice(at, at + target.length)}
      </mark>,
    );
    from = at + target.length;
    at = lower.indexOf(target, from);
  }
  if (parts.length === 0) return value;
  if (from < value.length) parts.push(value.slice(from));
  return <>{parts}</>;
}

function InlineLink({
  token,
  onInternalLink,
}: {
  token: Extract<InlineToken, { type: 'link' }>;
  onInternalLink?: MarkdownProps['onInternalLink'];
}) {
  const resolved = resolveDocLink(token.href);

  if (resolved.kind === 'internal') {
    return (
      <a
        href={`/admin/docs/${resolved.categoryId}${resolved.anchor ? `#${resolved.anchor}` : ''}`}
        className="doc-link"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.button !== 0) return;
          event.preventDefault();
          onInternalLink?.(resolved.categoryId, resolved.anchor);
        }}
      >
        {token.value}
      </a>
    );
  }

  if (resolved.kind === 'external') {
    return (
      <a
        href={resolved.href}
        className="doc-link"
        target="_blank"
        rel="noopener noreferrer"
      >
        {token.value}
      </a>
    );
  }

  // A repo path with no page here: shown, but not a live link.
  return (
    <span className="doc-reflink" title={resolved.href}>
      {token.value}
    </span>
  );
}

function Inline({
  tokens,
  onInternalLink,
  query,
}: {
  tokens: readonly InlineToken[];
  onInternalLink?: MarkdownProps['onInternalLink'];
  query?: string;
}) {
  return (
    <>
      {tokens.map((token, index) => {
        switch (token.type) {
          case 'text':
            return <Fragment key={index}>{markQuery(token.value, query)}</Fragment>;
          case 'code':
            return <code key={index}>{token.value}</code>;
          case 'strong':
            return <strong key={index}>{token.value}</strong>;
          case 'em':
            return <em key={index}>{token.value}</em>;
          case 'link':
            return (
              <InlineLink key={index} token={token} onInternalLink={onInternalLink} />
            );
        }
      })}
    </>
  );
}

// Light, deliberately conservative highlighting: comments and quoted strings
// only. It wraps matched spans and passes everything else through untouched, so
// it cannot mangle code it does not understand. The `(?<=^|\s)` guards stop a
// `//` inside `http://host` from being read as a comment.
const CODE_PATTERN =
  /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?<=^|\s)#.*$|(?<=^|\s)\/\/.*$)/gm;

function highlightCode(code: string): ReactNode {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of code.matchAll(CODE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(code.slice(last, start));
    const value = match[0];
    const cls = value.startsWith('#') || value.startsWith('//') ? 'doc-tok-comment' : 'doc-tok-str';
    nodes.push(
      <span className={cls} key={key++}>
        {value}
      </span>,
    );
    last = start + value.length;
  }
  if (last < code.length) nodes.push(code.slice(last));
  return nodes;
}

function BlockView({
  block,
  onInternalLink,
  query,
}: {
  block: Block;
  onInternalLink?: MarkdownProps['onInternalLink'];
  query?: string;
}) {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4';
      return (
        <Tag id={block.id} className={`doc-h doc-h${block.level}`}>
          {markQuery(block.text, query)}
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p className="doc-p">
          <Inline tokens={block.spans} onInternalLink={onInternalLink} query={query} />
        </p>
      );
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag className="doc-list">
          {block.items.map((item, index) => (
            <li key={index}>
              <Inline tokens={item} onInternalLink={onInternalLink} query={query} />
            </li>
          ))}
        </Tag>
      );
    }
    case 'code':
      return (
        <div className="doc-code">
          {block.lang !== null && <span className="doc-code-lang">{block.lang}</span>}
          <pre>
            <code>{highlightCode(block.code)}</code>
          </pre>
        </div>
      );
    case 'table':
      return (
        <div className="doc-table-scroll">
          <table className="doc-table">
            <thead>
              <tr>
                {block.headers.map((cell, index) => (
                  <th key={index}>
                    <Inline tokens={cell} onInternalLink={onInternalLink} query={query} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>
                      <Inline tokens={cell} onInternalLink={onInternalLink} query={query} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'callout': {
      const Icon = CALLOUT_ICON[block.variant];
      return (
        <div className={`doc-callout is-${block.variant}`}>
          <div className="doc-callout-head">
            <Icon size={15} strokeWidth={2} aria-hidden="true" />
            <span>{block.title ?? CALLOUT_LABEL[block.variant]}</span>
          </div>
          <div className="doc-callout-body">
            {block.blocks.map((child, index) => (
              <BlockView
                key={index}
                block={child}
                onInternalLink={onInternalLink}
                query={query}
              />
            ))}
          </div>
        </div>
      );
    }
    case 'hr':
      return <hr className="doc-hr" />;
  }
}

export function Markdown({ blocks, onInternalLink, query }: MarkdownProps) {
  return (
    <div className="doc-content">
      {blocks.map((block, index) => (
        <BlockView
          key={index}
          block={block}
          onInternalLink={onInternalLink}
          query={query}
        />
      ))}
    </div>
  );
}
