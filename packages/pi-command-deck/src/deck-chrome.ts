import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const LABEL_GAP = 3;
const SOFTWARE_CURSOR = "\x1b[7m \x1b[0m";

/** Render a border row with a left and a right label, shrinking the longer label to fit. */
export function renderDeckBorder(
  left: string,
  right: string,
  width: number,
  borderColor: (text: string) => string,
): string {
  if (width <= 0) return "";
  if (width <= 5) return borderColor("─".repeat(width));

  let leftLabel = left;
  let rightLabel = right;
  while (visibleWidth(leftLabel) + visibleWidth(rightLabel) + LABEL_GAP + 2 > width) {
    if (visibleWidth(rightLabel) >= visibleWidth(leftLabel)) {
      rightLabel = truncateToWidth(rightLabel, Math.max(0, visibleWidth(rightLabel) - 1), "");
    } else {
      leftLabel = truncateToWidth(leftLabel, Math.max(0, visibleWidth(leftLabel) - 1), "");
    }
  }

  const fillWidth = width - visibleWidth(leftLabel) - visibleWidth(rightLabel) - 2;
  return `${borderColor("─")}${leftLabel}${borderColor("─".repeat(fillWidth))}${rightLabel}${borderColor("─")}`;
}

export function formatDeckCwd(cwd: string): string {
  return path.basename(cwd) || cwd;
}

export function formatContextUsage(percent: number | null | undefined): string {
  return percent === null || percent === undefined ? "ctx ?" : `ctx ${Math.round(percent)}%`;
}

/** Cache-read share of the latest assistant message's prompt tokens. */
export function formatCacheHit(entries: readonly SessionEntry[]): string {
  const entry = entries.findLast(
    (candidate) => candidate.type === "message" && candidate.message.role === "assistant",
  );
  if (entry?.type !== "message" || entry.message.role !== "assistant") return "cache ?";

  const usage = entry.message.usage;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  return promptTokens > 0
    ? `cache ${((usage.cacheRead / promptTokens) * 100).toFixed(1)}%`
    : "cache ?";
}

/** Show a placeholder after the cursor on the first content row of an empty prompt. */
export function withEmptyPromptPlaceholder(
  line: string,
  placeholder: string,
  width: number,
): string {
  return truncateToWidth(
    line
      .replace(SOFTWARE_CURSOR, `${SOFTWARE_CURSOR}${placeholder}`)
      .replace(`${CURSOR_MARKER} `, `${CURSOR_MARKER} ${placeholder}`),
    width,
    "",
  );
}

/**
 * Join extension statuses into one Status Footer row the way Pi's footer does: sorted by status
 * key, joined by a single space, and truncated with `ellipsis`. Each status is already formatted
 * by its owner.
 */
export function formatStatusFooter(
  statuses: ReadonlyMap<string, string>,
  ellipsis: string,
  width: number,
): string[] {
  const texts = [...statuses]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) =>
      text
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim(),
    )
    .filter(Boolean);
  return texts.length === 0 ? [] : [truncateToWidth(texts.join(" "), width, ellipsis)];
}
