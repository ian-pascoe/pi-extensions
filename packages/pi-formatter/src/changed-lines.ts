/** Split text into lines that keep their terminator, so a missing final newline is a change. */
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split(/(?<=\n)/);
}

interface SharedEnds {
  readonly prefix: number;
  readonly suffix: number;
}

/** Count the lines two versions share at the start and at the end, without overlapping. */
function sharedEnds(beforeLines: readonly string[], afterLines: readonly string[]): SharedEnds {
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
  return { prefix, suffix };
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
  const { prefix, suffix } = sharedEnds(beforeLines, afterLines);
  const first = prefix + 1;
  const last = afterLines.length - suffix;
  if (last < first)
    return prefix === 0 ? "lines removed before line 1" : `lines removed after line ${prefix}`;
  return first === last ? `line ${first} changed` : `lines ${first}–${last} changed`;
}

const CONTEXT_LINES = 3;
/** Most added plus removed lines worth finding; a rewrite that differs more is not diffed. */
const MAX_EDIT_DISTANCE = 100;

interface DiffOperation {
  readonly marker: " " | "-" | "+";
  readonly line: string;
  /** How many lines of the original and of the formatted content precede this operation. */
  readonly oldLinesBefore: number;
  readonly newLinesBefore: number;
}

/**
 * Find the fewest removed and added lines that turn `before` into `after` (Myers' O(ND)
 * algorithm), so cost follows how much changed rather than how far apart the changes are.
 * Returns `undefined` when more than `MAX_EDIT_DISTANCE` lines differ.
 */
function diffMiddle(
  before: readonly string[],
  after: readonly string[],
  linesBefore: number,
): DiffOperation[] | undefined {
  const limit = Math.min(before.length + after.length, MAX_EDIT_DISTANCE);
  const center = limit + 1;
  // reach[center + k] is the furthest `before` index reached on diagonal k = before index - after index.
  let reach = new Int32Array(2 * limit + 3);
  const history: Int32Array[] = [];
  let distance = 0;
  search: for (; distance <= limit; distance++) {
    history.push(reach.slice());
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down =
        diagonal === -distance ||
        (diagonal !== distance &&
          (reach[center + diagonal - 1] ?? 0) < (reach[center + diagonal + 1] ?? 0));
      let x = down ? (reach[center + diagonal + 1] ?? 0) : (reach[center + diagonal - 1] ?? 0) + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x++;
        y++;
      }
      reach[center + diagonal] = x;
      if (x >= before.length && y >= after.length) break search;
    }
  }
  if (distance > limit) return undefined;
  // Walk back from the end of both versions to the start, newest operation first.
  const backwards: DiffOperation[] = [];
  let x = before.length;
  let y = after.length;
  for (let step = distance; step >= 0; step--) {
    const earlier = history[step] ?? reach;
    const diagonal = x - y;
    const down =
      diagonal === -step ||
      (diagonal !== step &&
        (earlier[center + diagonal - 1] ?? 0) < (earlier[center + diagonal + 1] ?? 0));
    const previousDiagonal = down ? diagonal + 1 : diagonal - 1;
    const previousX = step === 0 ? 0 : (earlier[center + previousDiagonal] ?? 0);
    const previousY = step === 0 ? 0 : previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      x--;
      y--;
      backwards.push({
        marker: " ",
        line: before[x] ?? "",
        oldLinesBefore: linesBefore + x,
        newLinesBefore: linesBefore + y,
      });
    }
    if (step === 0) break;
    if (down) {
      y--;
      backwards.push({
        marker: "+",
        line: after[y] ?? "",
        oldLinesBefore: linesBefore + x,
        newLinesBefore: linesBefore + y,
      });
    } else {
      x--;
      backwards.push({
        marker: "-",
        line: before[x] ?? "",
        oldLinesBefore: linesBefore + x,
        newLinesBefore: linesBefore + y,
      });
    }
  }
  return backwards.reverse();
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
  const oldStart = oldCount === 0 ? first.oldLinesBefore : first.oldLinesBefore + 1;
  const newStart = newCount === 0 ? first.newLinesBefore : first.newLinesBefore + 1;
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
  const { prefix, suffix } = sharedEnds(beforeLines, afterLines);
  const middle = diffMiddle(
    beforeLines.slice(prefix, beforeLines.length - suffix),
    afterLines.slice(prefix, afterLines.length - suffix),
    prefix,
  );
  if (middle === undefined) return undefined;
  const leading = Math.min(prefix, CONTEXT_LINES);
  const trailing = Math.min(suffix, CONTEXT_LINES);
  const operations: DiffOperation[] = [
    ...beforeLines.slice(prefix - leading, prefix).map((line, index) => ({
      marker: " " as const,
      line,
      oldLinesBefore: prefix - leading + index,
      newLinesBefore: prefix - leading + index,
    })),
    ...middle,
    ...beforeLines
      .slice(beforeLines.length - suffix, beforeLines.length - suffix + trailing)
      .map((line, index) => ({
        marker: " " as const,
        line,
        oldLinesBefore: beforeLines.length - suffix + index,
        newLinesBefore: afterLines.length - suffix + index,
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
