/**
 * The in-app documentation renderer's parser.
 *
 * It only has to handle the Markdown our own docs use, so the tests are the
 * spec for that subset: anything the docs rely on has a case here, and anything
 * without a case is fair game to not support. The safety property worth guarding
 * is that parsing yields data, never HTML — so a heading id is a slug, a link is
 * a value plus an href, and nothing carries raw markup through.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseInline,
  parseMarkdown,
  sectionize,
  slugify,
  tableOfContents,
  type Block,
} from '../lib/markdown.js';

describe('slugify', () => {
  it('matches GitHub-style anchors the docs link to', () => {
    assert.equal(
      slugify('Print queues and IPP status refusals'),
      'print-queues-and-ipp-status-refusals',
    );
    assert.equal(
      slugify('Poller loop and capability management'),
      'poller-loop-and-capability-management',
    );
  });

  it('drops punctuation and collapses whitespace', () => {
    assert.equal(slugify('  SNMP & supply levels!  '), 'snmp-supply-levels');
  });
});

describe('parseInline', () => {
  it('keeps plain text as one token', () => {
    assert.deepEqual(parseInline('just words'), [{ type: 'text', value: 'just words' }]);
  });

  it('takes a code span before emphasis inside it', () => {
    assert.deepEqual(parseInline('`a * b`'), [{ type: 'code', value: 'a * b' }]);
  });

  it('reads bold before italic', () => {
    assert.deepEqual(parseInline('**bold** and *soft*'), [
      { type: 'strong', value: 'bold' },
      { type: 'text', value: ' and ' },
      { type: 'em', value: 'soft' },
    ]);
  });

  it('parses a link into value and href, not markup', () => {
    assert.deepEqual(parseInline('see [the guide](TROUBLESHOOTING.md)'), [
      { type: 'text', value: 'see ' },
      { type: 'link', value: 'the guide', href: 'TROUBLESHOOTING.md' },
    ]);
  });

  it('leaves a mid-word underscore alone', () => {
    assert.deepEqual(parseInline('data_krembonet_db'), [
      { type: 'text', value: 'data_krembonet_db' },
    ]);
  });
});

describe('parseMarkdown', () => {
  it('reads headings with a slug id', () => {
    assert.deepEqual(parseMarkdown('## SNMP and supply levels')[0], {
      type: 'heading',
      level: 2,
      text: 'SNMP and supply levels',
      id: 'snmp-and-supply-levels',
    });
  });

  it('keeps a fenced code block verbatim, with its language', () => {
    const block = parseMarkdown('```nginx\nproxy_buffering off;\n# ok\n```')[0];
    assert.deepEqual(block, {
      type: 'code',
      lang: 'nginx',
      code: 'proxy_buffering off;\n# ok',
    });
  });

  it('does not treat markup inside a code fence as blocks', () => {
    const blocks = parseMarkdown('```\n## not a heading\n- not a list\n```');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.type, 'code');
  });

  it('groups a run of bullets into one list', () => {
    const block = parseMarkdown('- one\n- two\n- three')[0] as Extract<
      Block,
      { type: 'list' }
    >;
    assert.equal(block.type, 'list');
    assert.equal(block.ordered, false);
    assert.equal(block.items.length, 3);
    assert.deepEqual(block.items[1], [{ type: 'text', value: 'two' }]);
  });

  it('marks a numbered list ordered', () => {
    const block = parseMarkdown('1. first\n2. second')[0] as Extract<
      Block,
      { type: 'list' }
    >;
    assert.equal(block.ordered, true);
    assert.equal(block.items.length, 2);
  });

  it('parses a pipe table into headers and rows', () => {
    const block = parseMarkdown(
      '| Port | Use |\n| --- | --- |\n| `631` | IPP |\n| `161` | SNMP |',
    )[0] as Extract<Block, { type: 'table' }>;

    assert.equal(block.type, 'table');
    assert.deepEqual(block.headers[0], [{ type: 'text', value: 'Port' }]);
    assert.equal(block.rows.length, 2);
    assert.deepEqual(block.rows[0]?.[0], [{ type: 'code', value: '631' }]);
  });

  it('reads a GitHub callout marker into a variant', () => {
    const block = parseMarkdown('> [!WARNING]\n> A soft reboot is required.')[0] as Extract<
      Block,
      { type: 'callout' }
    >;
    assert.equal(block.type, 'callout');
    assert.equal(block.variant, 'warning');
    assert.equal(block.blocks[0]?.type, 'paragraph');
  });

  it('falls back to a note for a plain blockquote', () => {
    const block = parseMarkdown('> just a quote')[0] as Extract<
      Block,
      { type: 'callout' }
    >;
    assert.equal(block.variant, 'note');
    assert.equal(block.title, null);
  });

  it('reads a thematic break, and not as a table', () => {
    assert.deepEqual(parseMarkdown('---'), [{ type: 'hr' }]);
  });

  it('joins wrapped paragraph lines', () => {
    const block = parseMarkdown('one two\nthree four')[0] as Extract<
      Block,
      { type: 'paragraph' }
    >;
    assert.deepEqual(block.spans, [{ type: 'text', value: 'one two three four' }]);
  });
});

describe('sectionize', () => {
  const doc = parseMarkdown(
    '# Title\n\nlead in\n\n## First\n\nalpha\n\n## Second\n\nbravo `code`',
  );

  it('splits at headings and keeps the lead under the title', () => {
    const sections = sectionize(doc);
    assert.deepEqual(
      sections.map((s) => s.title),
      ['Title', 'First', 'Second'],
    );
  });

  it('builds a lowercased search haystack per section', () => {
    const sections = sectionize(doc);
    assert.match(sections[2]?.text ?? '', /bravo code/);
    assert.doesNotMatch(sections[1]?.text ?? '', /bravo/);
  });
});

describe('tableOfContents', () => {
  it('lists the H2 headings only', () => {
    const toc = tableOfContents(
      parseMarkdown('# Title\n\n## One\n\n### Deep\n\n## Two'),
    );
    assert.deepEqual(toc, [
      { id: 'one', title: 'One' },
      { id: 'two', title: 'Two' },
    ]);
  });
});
