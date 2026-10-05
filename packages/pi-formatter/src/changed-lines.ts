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
