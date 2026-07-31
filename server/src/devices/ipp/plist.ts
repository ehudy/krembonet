/**
 * Converts the XML property list that `ipptool -X` emits into plain JS values.
 *
 * Why this exists: the obvious alternative is regex over `ipptool -tv` text
 * output (as the original Python prototype did), but that loses types, cannot
 * represent nested collections like `media-col-ready`, and breaks on any value
 * containing a comma or quote — job names routinely do. The plist output is
 * already typed and structured, so parsing it removes an entire class of bug.
 */
import { XMLParser } from 'fast-xml-parser';

export type PlistValue =
  | string
  | number
  | boolean
  | Date
  | Uint8Array
  | PlistValue[]
  | { [key: string]: PlistValue };

interface OrderedNode {
  [tag: string]: OrderedNode[] | string | number | boolean;
}

const parser = new XMLParser({
  preserveOrder: true, // plist pairs <key> with the element that follows it
  ignoreAttributes: true,
  parseTagValue: false, // we do our own numeric parsing, per plist element type
  trimValues: true,
});

export class PlistParseError extends Error {
  override readonly name = 'PlistParseError';
}

function tagOf(node: OrderedNode): string | undefined {
  for (const key of Object.keys(node)) {
    if (key !== '#text' && key !== ':@') return key;
  }
  return undefined;
}

function childrenOf(node: OrderedNode, tag: string): OrderedNode[] {
  const value = node[tag];
  return Array.isArray(value) ? value : [];
}

function textOf(children: OrderedNode[]): string {
  let out = '';
  for (const child of children) {
    const text = child['#text'];
    if (text !== undefined) out += String(text);
  }
  return out;
}

function toNumber(raw: string, kind: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new PlistParseError(`Invalid <${kind}> value: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function convertNode(node: OrderedNode): PlistValue {
  const tag = tagOf(node);
  if (tag === undefined) {
    throw new PlistParseError('Encountered a plist node with no element tag');
  }
  const children = childrenOf(node, tag);

  switch (tag) {
    case 'string':
      return textOf(children);
    case 'integer':
      return toNumber(textOf(children), 'integer');
    case 'real':
      return toNumber(textOf(children), 'real');
    case 'true':
      return true;
    case 'false':
      return false;
    case 'date':
      return new Date(textOf(children));
    case 'data':
      return Uint8Array.from(Buffer.from(textOf(children), 'base64'));
    case 'array':
      return children.map(convertNode);
    case 'dict':
      return convertDict(children);
    default:
      throw new PlistParseError(`Unsupported plist element: <${tag}>`);
  }
}

function convertDict(children: OrderedNode[]): Record<string, PlistValue> {
  const result: Record<string, PlistValue> = {};

  for (let i = 0; i < children.length; i += 1) {
    const keyNode = children[i];
    if (keyNode === undefined) continue;
    if (tagOf(keyNode) !== 'key') {
      throw new PlistParseError(
        `Expected <key> in <dict>, found <${tagOf(keyNode) ?? '?'}>`,
      );
    }

    const name = textOf(childrenOf(keyNode, 'key'));
    const valueNode = children[i + 1];
    if (valueNode === undefined) {
      throw new PlistParseError(`<key>${name}</key> has no matching value element`);
    }

    result[name] = convertNode(valueNode);
    i += 1; // consume the value we just paired with this key
  }

  return result;
}

/** Parses a full plist document and returns its root value. */
export function parsePlist(xml: string): PlistValue {
  let roots: OrderedNode[];
  try {
    roots = parser.parse(xml) as OrderedNode[];
  } catch (cause) {
    throw new PlistParseError(`Malformed XML: ${(cause as Error).message}`);
  }

  const plistNode = roots.find((node) => tagOf(node) === 'plist');
  if (plistNode === undefined) {
    // ipptool writes diagnostics to stdout on some failures, so the caller
    // benefits from seeing what actually came back.
    const preview = xml.trim().slice(0, 200);
    throw new PlistParseError(
      `No <plist> root element found. Output began: ${JSON.stringify(preview)}`,
    );
  }

  const body = childrenOf(plistNode, 'plist').filter(
    (node) => tagOf(node) !== undefined,
  );
  const first = body[0];
  if (first === undefined) {
    throw new PlistParseError('<plist> element is empty');
  }

  return convertNode(first);
}

/** Narrows an unknown plist value to a dictionary. */
export function asDict(value: PlistValue | undefined): Record<string, PlistValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  if (value instanceof Date || value instanceof Uint8Array) return {};
  return value;
}

/**
 * IPP `1setOf` attributes collapse to a bare value when the printer returns
 * exactly one member, so every multi-valued read has to tolerate both shapes.
 */
export function asArray(value: PlistValue | undefined): PlistValue[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function asString(value: PlistValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: PlistValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
