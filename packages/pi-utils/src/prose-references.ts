import {
  Marked,
  type AutocompleteItem,
  type AutocompleteProvider,
  type Token,
  type Tokens,
} from "@earendil-works/pi-tui";

interface ProseSpan {
  text: string;
  positions: number[];
}

const markdown = new Marked();

// Container text removes line prefixes. Project its characters back onto the source.
function projectSource(source: string, target: string, positions: number[]): number[] | undefined {
  const sourceLines = source.split("\n");
  const targetLines = target.split("\n");
  const result: number[] = [];
  let offset = 0;
  for (const [index, line] of targetLines.entries()) {
    const sourceLine = sourceLines[index];
    if (sourceLine === undefined) return undefined;
    let start = sourceLine.lastIndexOf(line);
    let linePositions = positions.slice(offset, offset + sourceLine.length);
    if (start < 0 && sourceLine.includes("\t")) {
      let expanded = "";
      linePositions = [];
      for (let column = 0; column < sourceLine.length; column++) {
        const character = sourceLine[column] ?? "";
        const replacement = character === "\t" ? " ".repeat(4 - (expanded.length % 4)) : character;
        expanded += replacement;
        const position = positions[offset + column];
        if (position !== undefined) for (const _ of replacement) linePositions.push(position);
      }
      start = expanded.lastIndexOf(line);
    }
    if (start < 0) return undefined;
    for (const position of linePositions.slice(start, start + line.length)) result.push(position);
    const newline = positions[offset + sourceLine.length];
    if (index < targetLines.length - 1 && newline !== undefined) result.push(newline);
    offset += sourceLine.length + 1;
  }
  return result;
}

function collectProse(
  tokens: Token[],
  source: string,
  positions: number[],
  spans: ProseSpan[],
): void {
  let offset = 0;
  for (const token of tokens) {
    const start = source.indexOf(token.raw, offset);
    if (start < 0) return;
    const tokenPositions = positions.slice(start, start + token.raw.length);
    if (token.type === "text" && token.tokens === undefined && !token.escaped) {
      spans.push({ text: token.raw, positions: tokenPositions });
    } else if (token.type === "list") {
      collectProse(token.items, token.raw, tokenPositions, spans);
    } else if (token.type === "table") {
      let rowOffset = 0;
      for (const [rowIndex, row] of token.raw.split("\n").entries()) {
        const cells: Tokens.TableCell[] | undefined =
          rowIndex === 0 ? token.header : token.rows[rowIndex - 2];
        const characters: string[] = [];
        const rowPositions: number[] = [];
        let backslashes = 0;
        // Marked removes the escape before a cell's literal pipe, but not a separator.
        for (let index = 0; index < row.length; index++) {
          const character = row[index] ?? "";
          if (character === "|" && backslashes % 2 === 1) {
            characters.pop();
            rowPositions.pop();
          }
          characters.push(character);
          const position = tokenPositions[rowOffset + index];
          if (position !== undefined) rowPositions.push(position);
          backslashes = character === "\\" ? backslashes + 1 : 0;
        }
        const normalizedRow = characters.join("");
        let cellOffset = 0;
        for (const cell of cells ?? []) {
          const content = cell.tokens.map((child) => child.raw).join("");
          const cellStart = normalizedRow.indexOf(content, cellOffset);
          if (cellStart < 0) break;
          collectProse(
            cell.tokens,
            content,
            rowPositions.slice(cellStart, cellStart + content.length),
            spans,
          );
          cellOffset = cellStart + content.length;
        }
        rowOffset += row.length + 1;
      }
    } else if (
      token.type === "blockquote" ||
      token.type === "list_item" ||
      token.type === "paragraph" ||
      token.type === "heading" ||
      token.type === "text" ||
      token.type === "em" ||
      token.type === "strong" ||
      token.type === "del"
    ) {
      const children = token.tokens ?? [];
      const content = children.map((child) => child.raw).join("");
      const projection = projectSource(token.raw, content, tokenPositions);
      // ponytail: uncommon lexer whitespace rewrites stay literal; extend projection if needed.
      if (projection !== undefined) collectProse(children, content, projection, spans);
    }
    offset = start + token.raw.length;
  }
}

function proseSpans(text: string): ProseSpan[] {
  const positions: number[] = [];
  let normalized = "";
  for (let index = 0; index < text.length; index++) {
    positions.push(index);
    normalized += text[index] === "\r" ? "\n" : text[index];
    if (text[index] === "\r" && text[index + 1] === "\n") index++;
  }
  const spans: ProseSpan[] = [];
  collectProse(markdown.lexer(normalized), normalized, positions, spans);
  return spans;
}

const regexSpecials = /[.*+?^${}()|[\]\\]/g;
const escapeRegex = (text: string): string => text.replace(regexSpecials, "\\$&");

function assertSigil(sigil: string): void {
  if (sigil.length !== 1 || /[\s\\]/u.test(sigil)) {
    throw new TypeError(`A Reference Sigil is one visible character, got ${JSON.stringify(sigil)}`);
  }
}

// The sigil sits in a character class below, so escape it for that context too.
const classSigil = (sigil: string): string => sigil.replace(/[\]^-]/g, "\\$&");

function matchesReferenceSource(
  text: string,
  start: number,
  reference: string,
  sigil: string,
): boolean {
  const end = start + reference.length;
  const before = text.slice(0, start);
  const sigilClass = classSigil(sigil);
  return (
    text.slice(start, end) === reference &&
    !new RegExp(`[\\p{L}\\p{M}\\p{N}${sigilClass}/-]$`, "u").test(before) &&
    !/(?<!\\)(?:\\\\)*\\_$/u.test(before) &&
    !new RegExp(`^\\\\[_${sigilClass}/-]`, "u").test(text.slice(end))
  );
}

export interface ProseReferenceReplacement {
  /** The Reference Sigil that opens the shorthand, one character such as `$`, `@`, or `#`. */
  sigil: string;
  /**
   * Regular-expression source for one complete name after the sigil. It is tried as written, so
   * list longer alternatives first. Capture groups are not allowed.
   */
  name: string;
  /** The replacement for the whole `<sigil><name>` match, or undefined to leave it literal. */
  resolve: (name: string) => string | undefined;
}

/**
 * Replaces each known shorthand reference inside a Prose Span with what `resolve` returns for its
 * name. Code, existing links, HTML, escapes, and names that are not complete tokens stay literal.
 */
export function replaceProseReferences(text: string, options: ProseReferenceReplacement): string {
  const { sigil, name, resolve } = options;
  assertSigil(sigil);
  const sigilClass = classSigil(sigil);
  const referencePattern = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_${sigilClass}/+-])${escapeRegex(sigil)}(${name})(?![\\p{L}\\p{M}\\p{N}_${sigilClass}/+-]|\\.[\\p{L}\\p{M}\\p{N}_])`,
    "gu",
  );
  let result = "";
  let offset = 0;
  for (const span of proseSpans(text)) {
    for (const match of span.text.matchAll(referencePattern)) {
      const replacement = resolve(match[1] ?? "");
      if (replacement === undefined) continue;
      const start = span.positions[match.index];
      if (start === undefined || !matchesReferenceSource(text, start, match[0], sigil)) continue;
      result += text.slice(offset, start) + replacement;
      offset = start + match[0].length;
    }
  }
  return result + text.slice(offset);
}

export interface ProseReferencePrefixGrammar {
  /** The Reference Sigil that opens the shorthand, one character such as `$`, `@`, or `#`. */
  sigil: string;
  /** Regular-expression source for the characters of a possibly partial name, such as `[\\w-]*`. */
  partialName: string;
}

/**
 * The shorthand prefix (sigil plus the partial name typed so far) that ends at the cursor, or null
 * when the cursor is not at a token boundary in a Prose Span. `cursorOffset` indexes `text`.
 */
export function findProseReferencePrefix(
  text: string,
  cursorOffset: number,
  grammar: ProseReferencePrefixGrammar,
): string | null {
  const { sigil, partialName } = grammar;
  assertSigil(sigil);
  const sigilClass = classSigil(sigil);
  const prefixPattern = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_${sigilClass}/-])${escapeRegex(sigil)}(?:${partialName})$`,
    "u",
  );
  for (const span of proseSpans(text)) {
    const relativeCursor = span.positions.indexOf(cursorOffset - 1) + 1;
    if (relativeCursor === 0) continue;
    const prefix = span.text.slice(0, relativeCursor).match(prefixPattern)?.[0];
    return prefix !== undefined &&
      matchesReferenceSource(text, cursorOffset - prefix.length, prefix, sigil)
      ? prefix
      : null;
  }
  return null;
}

export interface ProseReferenceAutocomplete extends ProseReferencePrefixGrammar {
  /**
   * Completion items for the name typed so far (the prefix without its sigil). Each item's value
   * starts with the sigil and is inserted as the shorthand. An empty list shows no popup.
   */
  suggest: (query: string) => readonly AutocompleteItem[];
}

/**
 * Stacks a completion popup for one Reference Sigil over `current`. The returned provider owns
 * the popup wherever the cursor sits at the sigil's prefix in a Prose Span (even when nothing
 * matches) and delegates everything else, including applying other providers' items, to `current`.
 */
export function stackProseReferenceAutocomplete(
  current: AutocompleteProvider,
  options: ProseReferenceAutocomplete,
): AutocompleteProvider {
  const { sigil, partialName, suggest } = options;
  const prefixAt = (lines: string[], cursorLine: number, cursorCol: number): string | null => {
    const cursorOffset = lines
      .slice(0, cursorLine)
      .reduce((offset, line) => offset + line.length + 1, cursorCol);
    return findProseReferencePrefix(lines.join("\n"), cursorOffset, { sigil, partialName });
  };
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), sigil])],
    async getSuggestions(lines, cursorLine, cursorCol, requestOptions) {
      const prefix = prefixAt(lines, cursorLine, cursorCol);
      if (prefix === null)
        return current.getSuggestions(lines, cursorLine, cursorCol, requestOptions);
      if (requestOptions.signal.aborted) return null;
      const items = suggest(prefix.slice(sigil.length));
      return items.length === 0 ? null : { prefix, items: [...items] };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!item.value.startsWith(sigil) || prefix !== prefixAt(lines, cursorLine, cursorCol)) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }
      const line = lines[cursorLine] ?? "";
      const beforePrefix = line.slice(0, cursorCol - prefix.length);
      const completed = [...lines];
      completed[cursorLine] = `${beforePrefix}${item.value} ${line.slice(cursorCol)}`;
      return {
        lines: completed,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 1,
      };
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
