import { isAbsolute } from "node:path";
import { Marked, type Token, type Tokens } from "@earendil-works/pi-tui";

export interface Skill {
  name: string;
  path: string;
  description?: string;
}

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

function matchesReferenceSource(text: string, start: number, reference: string): boolean {
  const end = start + reference.length;
  const before = text.slice(0, start);
  return (
    text.slice(start, end) === reference &&
    !/[\p{L}\p{M}\p{N}$/-]$/u.test(before) &&
    !/(?<!\\)(?:\\\\)*\\_$/u.test(before) &&
    !/^\\[_$/-]/u.test(text.slice(end))
  );
}

export function transformSkillReferences(text: string, skills: readonly Skill[]): string {
  const catalogue = new Map(skills.map((skill) => [skill.name, skill.path]));
  const names = [...catalogue.keys()]
    .filter((name) => name.length > 0)
    .sort((left, right) => right.length - left.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (names.length === 0) return text;
  const referencePattern = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_$/+-])\\$(${names.join("|")})(?![\\p{L}\\p{M}\\p{N}_$/+-]|\\.[\\p{L}\\p{M}\\p{N}_])`,
    "gu",
  );
  let result = "";
  let offset = 0;
  for (const span of proseSpans(text)) {
    for (const match of span.text.matchAll(referencePattern)) {
      const path = catalogue.get(match[0].slice(1));
      if (path === undefined || !isAbsolute(path) || !path.isWellFormed()) continue;
      const start = span.positions[match.index];
      if (start === undefined || !matchesReferenceSource(text, start, match[0])) continue;
      const destination = encodeURI(path).replace(
        /[?#()]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      result += text.slice(offset, start) + `[${match[0]}](${destination})`;
      offset = start + match[0].length;
    }
  }
  return result + text.slice(offset);
}

export function getSkillReferencePrefix(text: string, cursorOffset: number): string | null {
  for (const span of proseSpans(text)) {
    const relativeCursor = span.positions.indexOf(cursorOffset - 1) + 1;
    if (relativeCursor === 0) continue;
    const prefix = span.text
      .slice(0, relativeCursor)
      .match(/(?<![\p{L}\p{M}\p{N}_$/-])\$[^\s$[\]()`*~<>]*$/u)?.[0];
    return prefix !== undefined &&
      matchesReferenceSource(text, cursorOffset - prefix.length, prefix)
      ? prefix
      : null;
  }
  return null;
}
