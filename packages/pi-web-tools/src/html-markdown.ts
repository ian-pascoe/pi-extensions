import { Parser } from "htmlparser2";

/**
 * Turndown joins its output by re-reading the whole accumulated string for every sibling node, so
 * converting a node with N siblings costs O(N × output size) and a multi-MiB flat page runs for
 * minutes in synchronous code that a request timeout cannot interrupt. Converting groups of at most
 * this many block siblings keeps every call small, and block elements convert the same alone.
 */
const MAX_SIBLINGS_PER_CONVERSION = 128;

/** How many wrapper levels or chunk groups are unwrapped before converting what is left directly. */
const MAX_UNWRAP_DEPTH = 16;

/** Containers whose own conversion adds only block separation, so their children convert alone. */
const WRAPPER_ELEMENTS = new Set(["html", "body", "main", "div", "section", "article"]);

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
  readonly end: number;
  readonly closed: boolean;
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
        end: isImplied ? Math.max(parser.startIndex, current.openEnd) : parser.endIndex + 1,
        closed: !isImplied,
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
        closed: true,
      });
    },
  });
  parser.write(html);
  parser.end();
  return nodes;
}

function convertChunked(html: string, convert: (html: string) => string, depth: number): string {
  if (depth >= MAX_UNWRAP_DEPTH) return convert(html);
  const nodes = topLevelNodes(html);
  const only = nodes.length === 1 ? nodes[0] : undefined;
  if (only?.name !== undefined && only.closed && WRAPPER_ELEMENTS.has(only.name)) {
    const closeStart = html.lastIndexOf("</", only.end);
    if (closeStart >= only.openEnd) {
      return convertChunked(html.slice(only.openEnd, closeStart), convert, depth + 1);
    }
  }
  if (nodes.length <= MAX_SIBLINGS_PER_CONVERSION) return convert(html);

  const chunks: string[] = [];
  let chunkStart = 0;
  let count = 0;
  nodes.forEach((node, index) => {
    count++;
    const next = nodes[index + 1];
    if (count < MAX_SIBLINGS_PER_CONVERSION || next === undefined) return;
    if (!node.block || !next.block) return;
    chunks.push(html.slice(chunkStart, node.end));
    chunkStart = node.end;
    count = 0;
  });
  chunks.push(html.slice(chunkStart));
  if (chunks.length === 1) return convert(html);
  return chunks
    .map((chunk) => convertChunked(chunk, convert, depth + 1))
    .filter((markdown) => markdown.length > 0)
    .join("\n\n");
}

/**
 * Convert HTML with `convert` (Turndown), splitting a page with many block siblings into groups so
 * conversion time stays linear in the page size.
 */
export function convertHtmlInChunks(html: string, convert: (html: string) => string): string {
  return convertChunked(html, convert, 0);
}
