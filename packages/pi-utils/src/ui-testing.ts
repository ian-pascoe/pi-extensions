import { visibleWidth } from "@earendil-works/pi-tui";
import type { UiTheme } from "./ui.js";

/**
 * A theme that wraps each styled piece in its token name (`<accent>…</accent>`, `<b>…</b>`), so
 * render tests show which colour role a piece uses and fail on any hard-coded escape code.
 */
export const taggedTheme: UiTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bg: (color, text) => `<bg:${color}>${text}</bg:${color}>`,
  bold: (text) => `<b>${text}</b>`,
  strikethrough: (text) => `<s>${text}</s>`,
};

const ESCAPE = String.fromCharCode(27);
const TAG_MARKER = /<\/?(?:b|s|(?:bg:)?[A-Za-z]+)>/g;

/**
 * Throw when any line is wider than `width` columns once `taggedTheme`'s tag markers are removed,
 * or when it carries a raw escape sequence. Rendered text that itself looks like `<word>` is not
 * supported.
 */
export function expectLinesFitWidth(lines: readonly string[], width: number): void {
  for (const line of lines) {
    if (line.includes(ESCAPE))
      throw new Error(`Hard-coded escape sequence in line: ${JSON.stringify(line)}`);
    const columns = visibleWidth(line.replace(TAG_MARKER, ""));
    if (columns > width)
      throw new Error(`Line is ${columns} columns, wider than ${width}: ${line}`);
  }
}
