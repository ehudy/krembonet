/**
 * A small, dependency-free Markdown parser for the in-app documentation.
 *
 * The web workspace ships three runtime dependencies on purpose (see the note in
 * `router.tsx`), and a Markdown library — plus a highlighter, plus their audit
 * churn — is a poor trade for rendering a handful of repo docs we author
 * ourselves. So this parses the subset those docs actually use: ATX headings,
 * paragraphs, ordered/unordered lists, fenced code, GitHub-style callouts and
 * pipe tables, thematic breaks, and inline code/bold/italic/links.
 *
 * It produces a data structure, never HTML. The renderer turns that into React
 * elements, so every string ends up as a text node React escapes — there is no
 * `dangerouslySetInnerHTML` anywhere in the path, and a doc cannot inject markup.
 *
 * Pure and self-contained, which is what lets `test/markdown.test.ts` exercise it
 * directly.
 */

export type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; value: string }
  | { type: 'em'; value: string }
  | { type: 'link'; value: string; href: string };

export type CalloutVariant = 'note' | 'tip' | 'important' | 'warning';

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string; id: string }
  | { type: 'paragraph'; spans: InlineToken[] }
  | { type: 'list'; ordered: boolean; items: InlineToken[][] }
  | { type: 'code'; lang: string | null; code: string }
  | { type: 'table'; headers: InlineToken[][]; rows: InlineToken[][][] }
  | { type: 'callout'; variant: CalloutVariant; title: string | null; blocks: Block[] }
  | { type: 'hr' };

/** A run of blocks under one heading, for the table of contents and search. */
export interface DocSection {
  id: string;
  title: string;
  level: number;
  blocks: Block[];
  /** All text in the section, lowercased — the haystack the search bar filters on. */
  text: string;
}

/** GitHub heading anchors: lowercase, spaces to hyphens, drop the rest. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const CALLOUT_VARIANTS: Record<string, CalloutVariant> = {
  NOTE: 'note',
  TIP: 'tip',
  IMPORTANT: 'important',
  WARNING: 'warning',
  CAUTION: 'warning',
};

// --- inline --------------------------------------------------------------

/**
 * Splits a line of text into inline tokens.
 *
 * Order matters: code spans are taken first so `*` inside backticks stays
 * literal, and `**` before `*` so bold is not misread as two italics.
 */
export function parseInline(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let text = '';
  let i = 0;

  const flush = (): void => {
    if (text !== '') {
      tokens.push({ type: 'text', value: text });
      text = '';
    }
  };

  while (i < input.length) {
    const rest = input.slice(i);

    const code = /^`([^`]+)`/.exec(rest);
    if (code && code[1] !== undefined) {
      flush();
      tokens.push({ type: 'code', value: code[1] });
      i += code[0].length;
      continue;
    }

    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link && link[1] !== undefined && link[2] !== undefined) {
      flush();
      tokens.push({ type: 'link', value: link[1], href: link[2] });
      i += link[0].length;
      continue;
    }

    const strong = /^\*\*([^*]+)\*\*/.exec(rest);
    if (strong && strong[1] !== undefined) {
      flush();
      tokens.push({ type: 'strong', value: strong[1] });
      i += strong[0].length;
      continue;
    }

    // Asterisk emphasis.
    const emStar = /^\*([^*]+)\*/.exec(rest);
    if (emStar && emStar[1] !== undefined) {
      flush();
      tokens.push({ type: 'em', value: emStar[1] });
      i += emStar[0].length;
      continue;
    }

    // Underscore emphasis, but never mid-word: `file_name` and `data_db` must
    // stay literal, so the opener may not follow a word character and the
    // closer may not precede one.
    const emUnderscore = /^_([^_]+)_/.exec(rest);
    const prev = i > 0 ? input[i - 1] : '';
    const after = input[i + (emUnderscore?.[0].length ?? 0)] ?? '';
    if (
      emUnderscore &&
      emUnderscore[1] !== undefined &&
      !/\w/.test(prev ?? '') &&
      !/\w/.test(after)
    ) {
      flush();
      tokens.push({ type: 'em', value: emUnderscore[1] });
      i += emUnderscore[0].length;
      continue;
    }

    text += input[i];
    i += 1;
  }

  flush();
  return tokens;
}

/** The plain text of an inline run, for building the search haystack. */
function inlineText(tokens: InlineToken[]): string {
  return tokens.map((token) => token.value).join('');
}

// --- blocks --------------------------------------------------------------

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableDelimiter(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

/**
 * Parses Markdown into a flat block list.
 *
 * Line-oriented: it walks the lines once, and each block type knows how to
 * consume its own run, which keeps the control flow readable at the cost of a
 * little repetition.
 */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Blank
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Fenced code
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] !== undefined && fence[1] !== '' ? fence[1] : null;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // closing fence
      blocks.push({ type: 'code', lang, code: body.join('\n') });
      continue;
    }

    // Heading
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading && heading[1] !== undefined && heading[2] !== undefined) {
      const level = heading[1].length as 1 | 2 | 3 | 4;
      const text = heading[2].trim();
      blocks.push({ type: 'heading', level, text, id: slugify(text) });
      i += 1;
      continue;
    }

    // Thematic break (a line of dashes, but not a table delimiter, which has pipes)
    if (/^-{3,}$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // Blockquote / callout
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? '')) {
        quoted.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i += 1;
      }

      let variant: CalloutVariant = 'note';
      let title: string | null = null;
      const marker = /^\[!(\w+)\]\s*(.*)$/.exec(quoted[0] ?? '');
      if (marker && marker[1] !== undefined) {
        const found = CALLOUT_VARIANTS[marker[1].toUpperCase()];
        if (found !== undefined) {
          variant = found;
          title = (marker[2] ?? '').trim() || null;
          quoted.shift();
        }
      }

      blocks.push({
        type: 'callout',
        variant,
        title,
        blocks: parseMarkdown(quoted.join('\n')),
      });
      continue;
    }

    // Table: a header row immediately followed by a delimiter row
    if (line.includes('|') && isTableDelimiter(lines[i + 1] ?? '')) {
      const headers = splitRow(line).map(parseInline);
      i += 2; // header + delimiter
      const rows: InlineToken[][][] = [];
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        rows.push(splitRow(lines[i] ?? '').map(parseInline));
        i += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // List (a whole run of - / * / n. items)
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: InlineToken[][] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? '')) {
        const itemMarker = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
        let content = (lines[i] ?? '').replace(itemMarker, '');
        i += 1;
        // Fold a wrapped continuation line into the same item.
        while (
          i < lines.length &&
          (lines[i] ?? '').trim() !== '' &&
          !/^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? '') &&
          !/^(#{1,4})\s+/.test(lines[i] ?? '')
        ) {
          content += ` ${(lines[i] ?? '').trim()}`;
          i += 1;
        }
        items.push(parseInline(content.trim()));
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Paragraph: gather until a blank line or the start of another block.
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !/^(#{1,4})\s+/.test(lines[i] ?? '') &&
      !/^```/.test(lines[i] ?? '') &&
      !/^>\s?/.test(lines[i] ?? '') &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? '') &&
      !/^-{3,}$/.test((lines[i] ?? '').trim())
    ) {
      para.push(lines[i] ?? '');
      i += 1;
    }
    blocks.push({ type: 'paragraph', spans: parseInline(para.join(' ').trim()) });
  }

  return blocks;
}

// --- sections (TOC + search) ---------------------------------------------

/** Flattened text of one block, lowercased, for the search haystack. */
function blockText(block: Block): string {
  switch (block.type) {
    case 'heading':
      return block.text;
    case 'paragraph':
      return inlineText(block.spans);
    case 'list':
      return block.items.map(inlineText).join(' ');
    case 'code':
      return block.code;
    case 'table':
      return [...block.headers, ...block.rows.flat()].map(inlineText).join(' ');
    case 'callout':
      return `${block.title ?? ''} ${block.blocks.map(blockText).join(' ')}`;
    case 'hr':
      return '';
  }
}

/**
 * Splits a block list into sections at every heading of `level` or shallower
 * (H1 and H2 by default). Content before the first heading becomes a lead
 * section so nothing is dropped.
 */
export function sectionize(blocks: Block[], maxLevel = 2): DocSection[] {
  const sections: DocSection[] = [];
  let current: DocSection | null = null;

  for (const block of blocks) {
    // A new section starts at each heading of `maxLevel` or shallower, and once
    // at the top so any lead content before the first heading has a home.
    if ((block.type === 'heading' && block.level <= maxLevel) || current === null) {
      current = {
        id: block.type === 'heading' ? block.id : '',
        title: block.type === 'heading' ? block.text : '',
        level: block.type === 'heading' ? block.level : maxLevel,
        blocks: [],
        text: '',
      };
      sections.push(current);
    }
    current.blocks.push(block);
  }

  for (const section of sections) {
    section.text = section.blocks.map(blockText).join(' ').toLowerCase();
  }

  return sections;
}

/** The H2 (and shallower) headings of a document, for the on-page contents nav. */
export function tableOfContents(blocks: Block[]): { id: string; title: string }[] {
  return blocks
    .filter(
      (block): block is Extract<Block, { type: 'heading' }> =>
        block.type === 'heading' && block.level === 2,
    )
    .map((block) => ({ id: block.id, title: block.text }));
}
