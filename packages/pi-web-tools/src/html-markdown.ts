import { Parser } from "htmlparser2";

/**
 * Turndown joins its output by re-reading the whole accumulated string for every sibling node, so
 * converting a node with N siblings costs O(N × output size), and a multi-MiB flat page runs for
 * minutes in synchronous code that a request timeout cannot interrupt. This module therefore never
 * hands Turndown a large input. A large level is split into pieces that convert separately and
 * join exactly as Turndown would join them:
 *
 * - block containers (`div`, `main`, `body`, ...) add only block separation, so each converts on
 *   its own from its contents;
 * - a long `ul`/`ol` splits between `li` items, each group re-wrapped in its list tag, with `<ol>`
 *   numbering continued through `start`;
 * - runs of other nodes split into groups only between two block elements, never inside an inline
 *   run or a list.
 *
 * A single piece that is still huge (a giant `table`, `blockquote`, or one enormous `li`) cannot be
 * split safely, so past `atomicBytes` it becomes the linear plain-text extraction of that piece
 * instead of Markdown. That backstop bounds the worst case; ordinary pages never reach it.
 */

/** Size and grouping thresholds; tests lower them to exercise every path with small input. */
export type HtmlChunkLimits = {
  /** Input at most this long converts in one Turndown call. */
  readonly directBytes: number;
  /** Most sibling nodes in one piece. */
  readonly groupSize: number;
  /** Most source bytes in a piece made of several siblings. */
  readonly groupBytes: number;
  /** A piece longer than this that cannot be split becomes plain text. */
  readonly atomicBytes: number;
};

const DEFAULT_LIMITS: HtmlChunkLimits = {
  directBytes: 32 * 1024,
  groupSize: 128,
  groupBytes: 64 * 1024,
  atomicBytes: 256 * 1024,
};

/** Deepest container nesting that is unwrapped before the rest converts as one piece. */
const MAX_UNWRAP_DEPTH = 32;

/** Containers whose own conversion adds only block separation, so their contents convert alone. */
const CONTAINER_ELEMENTS = new Set([
  "html",
  "body",
  "main",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "aside",
  "form",
]);

/** Elements Turndown treats as blocks, so a chunk boundary between two of them splits no paragraph. */
const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "html",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);

type TopLevelNode = {
  readonly name: string | undefined;
  readonly block: boolean;
  readonly start: number;
  readonly openEnd: number;
  /** Start of the end tag; undefined when the element was closed implicitly. */
  readonly closeStart: number | undefined;
  readonly end: number;
};

/** Top-level elements and non-blank text runs of `html`, in order. */
function topLevelNodes(html: string): TopLevelNode[] {
  const nodes: TopLevelNode[] = [];
  let depth = 0;
  let current: { name: string; start: number; openEnd: number } | undefined;
  const parser = new Parser({
    onopentag(name) {
      if (depth === 0) current = { name, start: parser.startIndex, openEnd: parser.endIndex + 1 };
      depth++;
    },
    onclosetag(name, isImplied) {
      depth--;
      if (depth !== 0 || current === undefined) return;
      nodes.push({
        name,
        block: BLOCK_ELEMENTS.has(name),
        start: current.start,
        openEnd: current.openEnd,
        closeStart: isImplied ? undefined : parser.startIndex,
        end: isImplied ? Math.max(parser.startIndex, current.openEnd) : parser.endIndex + 1,
      });
      current = undefined;
    },
    ontext(value) {
      if (depth !== 0 || value.trim().length === 0) return;
      const start = parser.startIndex;
      nodes.push({
        name: undefined,
        block: false,
        start,
        openEnd: start,
        end: parser.endIndex + 1,
        closeStart: undefined,
      });
    },
  });
  parser.write(html);
  parser.end();
  return nodes;
}

type Converters = {
  readonly convert: (html: string) => string;
  readonly plainText: (html: string) => string;
  readonly limits: HtmlChunkLimits;
};

/** Convert a piece that is not split further, or its plain text when it is too large to risk. */
function convertPiece(html: string, converters: Converters): string {
  return html.length > converters.limits.atomicBytes
    ? converters.plainText(html)
    : converters.convert(html);
}

/**
 * Split consecutive `nodes` into groups of at most `groupSize` nodes and `groupBytes` bytes. When
 * `anywhere` is false a group may end only between two block elements. Returns [first, last]
 * index pairs.
 */
function groupNodes(
  nodes: readonly TopLevelNode[],
  limits: HtmlChunkLimits,
  anywhere: boolean,
): [number, number][] {
  const groups: [number, number][] = [];
  let first = 0;
  nodes.forEach((node, index) => {
    const next = nodes[index + 1];
    if (next === undefined) return;
    const firstNode = nodes[first];
    const full =
      index - first + 1 >= limits.groupSize ||
      (firstNode !== undefined && node.end - firstNode.start >= limits.groupBytes);
    // A node too large to convert is a piece of its own, so the plain-text backstop stays local.
    const isolate =
      node.end - node.start > limits.atomicBytes || next.end - next.start > limits.atomicBytes;
    if (!(full || isolate) || (!anywhere && !(node.block && next.block))) return;
    groups.push([first, index]);
    first = index + 1;
  });
  if (first < nodes.length) groups.push([first, nodes.length - 1]);
  return groups;
}

function convertRun(
  html: string,
  start: number,
  end: number,
  nodes: readonly TopLevelNode[],
  converters: Converters,
): string[] {
  const groups = groupNodes(nodes, converters.limits, false);
  return groups.map(([first, last], index) => {
    const from = index === 0 ? start : (nodes[first]?.start ?? start);
    const to = index === groups.length - 1 ? end : (nodes[last]?.end ?? end);
    return convertPiece(html.slice(from, to), converters);
  });
}

function startAttribute(openTag: string): string | undefined {
  const match = /\sstart\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(openTag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

/** A long list as groups of `li` items, or undefined when it holds anything but `li` elements. */
function convertList(html: string, list: TopLevelNode, converters: Converters): string | undefined {
  const { closeStart, name } = list;
  if (closeStart === undefined || name === undefined) return undefined;
  const inner = html.slice(list.openEnd, closeStart);
  const items = topLevelNodes(inner);
  if (items.length === 0 || items.some((item) => item.name !== "li")) return undefined;
  const openTag = html.slice(list.start, list.openEnd);
  const startRaw = name === "ol" ? startAttribute(openTag) : undefined;
  const firstNumber = startRaw === undefined || startRaw === "" ? 1 : Number(startRaw);
  if (!Number.isFinite(firstNumber)) return undefined;
  const pieces = groupNodes(items, converters.limits, true).map(([first, last]) => {
    const body = inner.slice(items[first]?.start ?? 0, items[last]?.end ?? inner.length);
    // Turndown numbers an <ol> item as start + its index among the list's items.
    const tag = name === "ol" ? `<ol start="${firstNumber + first}">` : openTag;
    return convertPiece(`${tag}${body}</${name}>`, converters);
  });
  return pieces.filter((piece) => piece.length > 0).join("\n");
}

function convertLevel(html: string, converters: Converters, depth: number): string {
  if (html.length <= converters.limits.directBytes) return converters.convert(html);
  if (depth >= MAX_UNWRAP_DEPTH) return convertPiece(html, converters);
  const nodes = topLevelNodes(html);
  const parts: string[] = [];
  let run: TopLevelNode[] = [];
  let cursor = 0;
  const flushRun = (end: number): void => {
    if (run.length > 0) parts.push(...convertRun(html, cursor, end, run, converters));
    run = [];
  };
  for (const node of nodes) {
    const isContainer =
      node.name !== undefined && CONTAINER_ELEMENTS.has(node.name) && node.closeStart !== undefined;
    const isList =
      (node.name === "ul" || node.name === "ol") &&
      node.end - node.start > converters.limits.directBytes;
    const list = isList ? convertList(html, node, converters) : undefined;
    if (!isContainer && list === undefined) {
      run.push(node);
      continue;
    }
    flushRun(node.start);
    cursor = node.end;
    if (list !== undefined) parts.push(list);
    else if (node.closeStart !== undefined) {
      parts.push(convertLevel(html.slice(node.openEnd, node.closeStart), converters, depth + 1));
    }
  }
  flushRun(html.length);
  return parts.filter((part) => part.length > 0).join("\n\n");
}

/**
 * Convert HTML to Markdown with `convert` (Turndown), splitting large input so conversion time stays
 * linear in the page size. `plainText` converts a piece that is too large to split, as described in
 * this module's header.
 */
export function convertHtmlInChunks(
  html: string,
  convert: (html: string) => string,
  plainText: (html: string) => string,
  limits: HtmlChunkLimits = DEFAULT_LIMITS,
): string {
  return convertLevel(html, { convert, plainText, limits }, 0);
}
