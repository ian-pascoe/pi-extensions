import { visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { UiTheme } from "./ui.js";

/**
 * A theme that wraps each styled piece in its token name (`<accent>…</accent>`, `<b>…</b>`), so
 * render tests show which colour role a piece uses and fail on any hard-coded escape code.
 *
 * pi-tui counts the tag characters as visible width, so wrapped or truncated output differs from
 * a real theme's. Use it for shape assertions on lines that do not wrap; use `escapeTaggedTheme`
 * when a component wraps or truncates at a narrow width.
 */
export const taggedTheme: UiTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bg: (color, text) => `<bg:${color}>${text}</bg:${color}>`,
  bold: (text) => `<b>${text}</b>`,
  strikethrough: (text) => `<s>${text}</s>`,
};

const ESCAPE = String.fromCharCode(27);
const TAG_MARKER = /<\/?(?:b|s|(?:bg:)?[A-Za-z]+)>/g;
const ESCAPE_SEQUENCE = new RegExp(`${ESCAPE}(?:\\[([0-9;]*)m|[\\s\\S]?)`, "g");

/**
 * Index assigned to each token the escape-encoded theme has styled, in first-use order. Indexes
 * are encoded as SGR parameters 200-299 (foreground) and 300-399 (background), which no terminal
 * reads as a colour, so the colour check can reject every real colour sequence outright.
 */
const tokenIndexes = new Map<string, number>();
const FOREGROUND_BASE = 200;
const BACKGROUND_BASE = 300;

function tokenIndex(token: string): number {
  let index = tokenIndexes.get(token);
  if (index === undefined) {
    index = tokenIndexes.size;
    tokenIndexes.set(token, index);
  }
  return index;
}

function tokenAt(index: number): string | undefined {
  for (const [token, assigned] of tokenIndexes) if (assigned === index) return token;
  return undefined;
}

/**
 * Like `taggedTheme`, but each token is encoded as a non-colour SGR parameter, which pi-tui
 * measures as zero columns, so line breaks and truncation fall where they would under a real
 * theme. Decode a line with `readableTags` to assert on it. Because the encoding is never a real
 * colour, `expectLinesFitWidth` still rejects every hard-coded colour.
 *
 * Limit: pi-tui re-opens a real colour or style on each wrapped line, but it does not track these
 * made-up codes, so a wrapped line's style is NOT carried over (its closing code is also wrong).
 * Assert on where lines break and how wide they are, not on a styled span that crosses a wrap.
 */
export const escapeTaggedTheme: UiTheme = {
  fg: (color, text) => `${ESCAPE}[${FOREGROUND_BASE + tokenIndex(color)}m${text}${ESCAPE}[39m`,
  bg: (color, text) => `${ESCAPE}[${BACKGROUND_BASE + tokenIndex(color)}m${text}${ESCAPE}[49m`,
  bold: (text) => `${ESCAPE}[1m${text}${ESCAPE}[22m`,
  strikethrough: (text) => `${ESCAPE}[9m${text}${ESCAPE}[29m`,
};

/**
 * Decode `escapeTaggedTheme` output into `taggedTheme`'s readable tags. Resets that pi-tui adds
 * when it wraps or truncates are dropped.
 */
export function readableTags(line: string): string {
  const foreground: string[] = [];
  const background: string[] = [];
  return line.replace(ESCAPE_SEQUENCE, (_sequence, parameters: string | undefined) => {
    if (parameters === undefined) return "";
    const code = Number(parameters);
    if (code >= FOREGROUND_BASE && code < BACKGROUND_BASE) {
      const token = tokenAt(code - FOREGROUND_BASE) ?? `unregistered:${code}`;
      foreground.push(token);
      return `<${token}>`;
    }
    if (code >= BACKGROUND_BASE && code < BACKGROUND_BASE + 100) {
      const token = tokenAt(code - BACKGROUND_BASE) ?? `unregistered:${code}`;
      background.push(token);
      return `<bg:${token}>`;
    }
    if (parameters === "39") return `</${foreground.pop() ?? "?"}>`;
    if (parameters === "49") return `</bg:${background.pop() ?? "?"}>`;
    if (parameters === "1") return "<b>";
    if (parameters === "22") return "</b>";
    if (parameters === "9") return "<s>";
    if (parameters === "29") return "</s>";
    return "";
  });
}

function isColourParameter(code: number): boolean {
  return (
    (code >= 30 && code <= 38) ||
    (code >= 40 && code <= 48) ||
    (code >= 90 && code <= 97) ||
    (code >= 100 && code <= 107)
  );
}

/** Whether an SGR parameter list sets a real colour; `escapeTaggedTheme`'s encoding never does. */
function hasHardCodedColour(parameters: string): boolean {
  return parameters.split(";").some((parameter) => isColourParameter(Number(parameter)));
}

export interface LineFitOptions {
  /**
   * Allow colour escapes. Set it for a body drawn by Pi's own components (Markdown, diffs), which
   * style through Pi's global theme, so those colours still follow the user's theme.
   */
  piThemedBody?: boolean;
}

/**
 * Throw when any line is wider than `width` columns once `taggedTheme`'s tag markers are removed,
 * or when it carries a hard-coded colour escape. Resets and text styles (bold, strikethrough) are
 * allowed because they carry no colour, and `truncateToWidth` appends a reset when it clips, as
 * is `escapeTaggedTheme`'s token encoding. Any escape that is not a style sequence is rejected. Rendered text that itself looks like `<word>` is not supported.
 */
export function expectLinesFitWidth(
  lines: readonly string[],
  width: number,
  options: LineFitOptions = {},
): void {
  for (const line of lines) {
    for (const match of line.matchAll(ESCAPE_SEQUENCE)) {
      const parameters = match[1];
      if (parameters === undefined)
        throw new Error(`Unexpected non-style escape sequence in line: ${JSON.stringify(line)}`);
      if (!options.piThemedBody && hasHardCodedColour(parameters))
        throw new Error(`Hard-coded colour escape in line: ${JSON.stringify(line)}`);
    }
    const columns = visibleWidth(line.replace(TAG_MARKER, ""));
    if (columns > width)
      throw new Error(`Line is ${columns} columns, wider than ${width}: ${line}`);
  }
}

function leftClick(height: number, width: number): TuiMouseEvent {
  return {
    type: "click",
    button: "left",
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  };
}

/**
 * Throw unless a left click on the item `render` draws is handled and swaps it to the view Pi would
 * draw with the expanded flag flipped, and a second click swaps it back. Pass a registered message
 * or entry renderer to prove it was wrapped with `expandMessageOnClick`/`expandEntryOnClick`.
 */
export function expectClickToggles<Item, Options extends { expanded: boolean }, RenderTheme>(
  render: (item: Item, options: Options, theme: RenderTheme) => Component | undefined,
  item: Item,
  options: Options,
  theme: RenderTheme,
  width = 100,
): void {
  const draw = (component: Component | undefined) => component?.render(width) ?? [];
  const other = draw(render(item, { ...options, expanded: !options.expanded }, theme));
  const component = render(item, options, theme);
  const first = draw(component);
  const swaps: Array<[string, readonly string[]]> = [
    ["first", other],
    ["second", first],
  ];
  for (const [which, expected] of swaps) {
    if (!component?.handleMouse?.(leftClick(draw(component).length, width))?.handled)
      throw new Error(`The ${which} click: the item did not handle a left click`);
    if (JSON.stringify(draw(component)) !== JSON.stringify(expected))
      throw new Error(`The ${which} click: the item did not show the other view`);
  }
}
