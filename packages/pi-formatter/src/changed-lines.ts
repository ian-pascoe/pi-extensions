/** Split text into lines that keep their terminator, so a missing final newline is a change. */
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split(/(?<=\n)/);
}

/**
 * Describe where a formatter changed a file, in line numbers of the formatted content.
 *
 * The description is one span: from the first line that differs from the original to the last
 * line that differs, found by trimming the lines both versions share at the start and the end.
 * Unchanged lines between two edits are included in the span. When the formatter only removed
 * lines, the description names the line they were removed after. Returns `undefined` when the
 * content is identical.
 */
export function describeChangedLines(before: string, after: string): string | undefined {
  if (before === after) return undefined;
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  if (afterLines.length === 0) return "all lines removed";
  const shared = Math.min(beforeLines.length, afterLines.length);
  let prefix = 0;
  while (prefix < shared && beforeLines[prefix] === afterLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shared - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const first = prefix + 1;
  const last = afterLines.length - suffix;
  if (last < first)
    return prefix === 0 ? "lines removed before line 1" : `lines removed after line ${prefix}`;
  return first === last ? `line ${first} changed` : `lines ${first}–${last} changed`;
}

const CONTEXT_LINES = 3;
/** Most cells of the line-matching table; a larger rewrite is not worth diffing line by line. */
const MAX_MATCH_CELLS = 250_000;

interface DiffOperation {
  readonly marker: " " | "-" | "+";
  readonly line: string;
  /** Lines of the original and the formatted content that precede this operation. */
  readonly oldBefore: number;
  readonly newBefore: number;
}

/** Match the lines two versions share, keeping the longest shared subsequence in order. */
function diffMiddle(
  before: readonly string[],
  after: readonly string[],
  oldStart: number,
  newStart: number,
): DiffOperation[] | undefined {
  const width = after.length + 1;
  if ((before.length + 1) * width > MAX_MATCH_CELLS) return undefined;
  // lengths[i * width + j] is the longest shared subsequence of before[i..] and after[j..].
  const lengths = new Uint32Array((before.length + 1) * width);
  for (let row = before.length - 1; row >= 0; row--) {
    for (let column = after.length - 1; column >= 0; column--) {
      lengths[row * width + column] =
        before[row] === after[column]
          ? (lengths[(row + 1) * width + column + 1] ?? 0) + 1
          : Math.max(
              lengths[(row + 1) * width + column] ?? 0,
              lengths[row * width + column + 1] ?? 0,
            );
    }
  }
  const operations: DiffOperation[] = [];
  let row = 0;
  let column = 0;
  while (row < before.length || column < after.length) {
    const oldBefore = oldStart + row;
    const newBefore = newStart + column;
    const oldLine = before[row];
    const newLine = after[column];
    if (oldLine !== undefined && oldLine === newLine) {
      operations.push({ marker: " ", line: oldLine, oldBefore, newBefore });
      row++;
      column++;
    } else if (
      oldLine !== undefined &&
      (newLine === undefined ||
        (lengths[(row + 1) * width + column] ?? 0) >= (lengths[row * width + column + 1] ?? 0))
    ) {
      operations.push({ marker: "-", line: oldLine, oldBefore, newBefore });
      row++;
    } else if (newLine !== undefined) {
      operations.push({ marker: "+", line: newLine, oldBefore, newBefore });
      column++;
    }
  }
  return operations;
}

function hunkRange(start: number, count: number): string {
  if (count === 0) return `${start},0`;
  return count === 1 ? `${start}` : `${start},${count}`;
}

function renderHunk(operations: readonly DiffOperation[]): string[] {
  const first = operations[0];
  if (first === undefined) return [];
  const oldCount = operations.filter(({ marker }) => marker !== "+").length;
  const newCount = operations.filter(({ marker }) => marker !== "-").length;
  // Git numbers an empty range by the line it follows, and a non-empty one by its first line.
  const oldStart = oldCount === 0 ? first.oldBefore : first.oldBefore + 1;
  const newStart = newCount === 0 ? first.newBefore : first.newBefore + 1;
  const lines = [`@@ -${hunkRange(oldStart, oldCount)} +${hunkRange(newStart, newCount)} @@`];
  for (const { marker, line } of operations) {
    lines.push(`${marker}${line.replace(/\n$/, "")}`);
    if (!line.endsWith("\n")) lines.push("\\ No newline at end of file");
  }
  return lines;
}

/**
 * Render how a formatter changed a file as unified diff hunks: the original lines it replaced
 * (`-`), the lines it wrote (`+`), and up to three unchanged lines around each change, which is
 * enough text to write an exact `edit` against the formatted file. Returns the hunk lines, or
 * `undefined` when the content is identical or the rewrite is too large to diff cheaply.
 */
export function diffChangedLines(before: string, after: string): string[] | undefined {
  if (before === after) return undefined;
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const shared = Math.min(beforeLines.length, afterLines.length);
  let prefix = 0;
  while (prefix < shared && beforeLines[prefix] === afterLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shared - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const middle = diffMiddle(
    beforeLines.slice(prefix, beforeLines.length - suffix),
    afterLines.slice(prefix, afterLines.length - suffix),
    prefix,
    prefix,
  );
  if (middle === undefined) return undefined;
  const leading = Math.min(prefix, CONTEXT_LINES);
  const trailing = Math.min(suffix, CONTEXT_LINES);
  const operations: DiffOperation[] = [
    ...beforeLines.slice(prefix - leading, prefix).map((line, index) => ({
      marker: " " as const,
      line,
      oldBefore: prefix - leading + index,
      newBefore: prefix - leading + index,
    })),
    ...middle,
    ...beforeLines
      .slice(beforeLines.length - suffix, beforeLines.length - suffix + trailing)
      .map((line, index) => ({
        marker: " " as const,
        line,
        oldBefore: beforeLines.length - suffix + index,
        newBefore: afterLines.length - suffix + index,
      })),
  ];
  // Changes separated by more than twice the context start a new hunk.
  const hunks: DiffOperation[][] = [];
  let hunk: DiffOperation[] = [];
  let unchangedRun: DiffOperation[] = [];
  for (const operation of operations) {
    if (operation.marker === " ") {
      unchangedRun.push(operation);
      continue;
    }
    if (hunk.length > 0 && unchangedRun.length > 2 * CONTEXT_LINES) {
      hunk.push(...unchangedRun.slice(0, CONTEXT_LINES));
      hunks.push(hunk);
      hunk = unchangedRun.slice(-CONTEXT_LINES);
    } else {
      hunk.push(...unchangedRun);
    }
    unchangedRun = [];
    hunk.push(operation);
  }
  hunk.push(...unchangedRun.slice(0, CONTEXT_LINES));
  hunks.push(hunk);
  return hunks.flatMap(renderHunk);
}
