import {
  keyText,
  type EntryRenderer,
  type MessageRenderer,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Container,
  MouseRegion,
  Spacer,
  Text,
  truncateToWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

/** The theme methods the shared UI helpers draw with; Pi's `Theme` satisfies it. */
export type UiTheme = Pick<Theme, "fg" | "bg" | "bold" | "strikethrough">;

/** Collapsed View preview lengths, copied from the Nearest Built-in tool of each kind. */
export const COLLAPSED_LINES = { fallback: 10, terminal: 5, search: 15, list: 20 } as const;

/** Pi's cap on a widget's rendered lines. */
export const WIDGET_MAX_LINES = 10;

/** The shared Status Marks, for surfaces whose background does not show the outcome. */
export const STATUS_MARKS = {
  active: "●",
  idle: "○",
  done: "✓",
  failed: "✗",
  warning: "!",
  stopped: "■",
} as const;

export type StatusKind = keyof typeof STATUS_MARKS;

const STATUS_COLORS = {
  active: "accent",
  idle: "dim",
  done: "success",
  failed: "error",
  warning: "warning",
  stopped: "muted",
} as const satisfies Record<StatusKind, string>;

/** One Status Mark coloured from its theme role. */
export function statusMark(theme: Pick<UiTheme, "fg">, kind: StatusKind): string {
  return theme.fg(STATUS_COLORS[kind], STATUS_MARKS[kind]);
}

/** The one inline separator. */
export const SEPARATOR = " · ";

/** Join non-empty parts with the inline separator in the `dim` role. */
export function joinInline(
  theme: Pick<UiTheme, "fg">,
  parts: readonly (string | undefined)[],
): string {
  return parts.filter((part): part is string => Boolean(part)).join(theme.fg("dim", SEPARATOR));
}

/**
 * A tool header in Pi's shape: the registered tool name in bold `toolTitle`, the target in
 * `accent`, then extra arguments in `muted`.
 */
export function toolHeader(
  theme: Pick<UiTheme, "fg" | "bold">,
  name: string,
  target?: string,
  args?: string,
): string {
  return [
    theme.fg("toolTitle", theme.bold(name)),
    target ? theme.fg("accent", target) : undefined,
    args ? theme.fg("muted", args) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

/** Pi's line-hint wording: `... (N more lines, ctrl+o to expand)`. */
export function expandHint(
  theme: Pick<UiTheme, "fg">,
  hidden: number,
  direction: "more" | "earlier" = "more",
): string {
  // Pi's own `keyHint` styles with its global theme, so build the hint from the injected one.
  const key = theme.fg("dim", keyText("app.tools.expand"));
  return `${theme.fg("muted", `... (${hidden} ${direction} lines,`)} ${key}${theme.fg("muted", " to expand")}${theme.fg("muted", ")")}`;
}

/** The dim ` (ctrl+o to expand)` appended to a row that collapses to a summary line. */
export function summaryExpandHint(theme: Pick<UiTheme, "fg">): string {
  return theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
}

export interface PreviewOptions {
  /** Lines shown when collapsed; use `COLLAPSED_LINES`. */
  limit: number;
  expanded: boolean;
  /** Which end the Collapsed View keeps. Defaults to the head. */
  keep?: "head" | "end";
  /** Theme role for the body text. Defaults to `toolOutput`. */
  color?: Parameters<UiTheme["fg"]>[0];
}

/**
 * A body of lines in its Collapsed or Expanded View. The Collapsed View keeps `limit` lines from
 * one end and adds Pi's Expand Hint; the Expanded View shows every line with no hint.
 */
export function previewBody(
  theme: Pick<UiTheme, "fg">,
  lines: readonly string[],
  options: PreviewOptions,
): string[] {
  const color = options.color ?? "toolOutput";
  const styled = lines.map((line) => theme.fg(color, line));
  const hidden = lines.length - options.limit;
  if (options.expanded || hidden <= 0) return styled;
  if (options.keep === "end") {
    return [expandHint(theme, hidden, "earlier"), ...styled.slice(hidden)];
  }
  return [...styled.slice(0, options.limit), expandHint(theme, hidden)];
}

/**
 * Clips an already rendered child to `limit` visual lines (counted after wrapping), adding Pi's
 * Expand Hint, wrapped to the available width, when lines are hidden. Use it for Markdown or other
 * component bodies; use `previewBody` for plain lines. The Expanded View shows every line.
 */
export class CollapsedPreview implements Component {
  constructor(
    private readonly theme: Pick<UiTheme, "fg">,
    private readonly child: Component,
    private readonly options: { limit: number; expanded: boolean; keep?: "head" | "end" },
  ) {}

  render(width: number): string[] {
    const lines = this.child.render(width);
    const hidden = lines.length - this.options.limit;
    if (this.options.expanded || hidden <= 0) return lines;
    const keepEnd = this.options.keep === "end";
    const hint = new Text(
      expandHint(this.theme, hidden, keepEnd ? "earlier" : "more"),
      0,
      0,
    ).render(width);
    return keepEnd
      ? [...hint, ...lines.slice(hidden)]
      : [...lines.slice(0, this.options.limit), ...hint];
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

/** A custom message or entry renderer: Pi's `MessageRenderer` and `EntryRenderer` have this shape. */
type ItemRenderer<Item extends WeakKey, Options extends { expanded: boolean }, RenderTheme> = (
  item: Item,
  options: Options,
  theme: RenderTheme,
) => Component | undefined;

/**
 * A clicked item's own view, kept per message or entry object because Pi rebuilds their components
 * on invalidation. `global` is Pi's expanded flag when the item was clicked: once ctrl+o changes it,
 * the click is forgotten, as Pi's tool rows forget theirs.
 */
const clickedViews = new WeakMap<WeakKey, { global: boolean; expanded: boolean }>();

function viewFor(item: WeakKey, global: boolean): boolean {
  const clicked = clickedViews.get(item);
  if (clicked?.global === global) return clicked.expanded;
  clickedViews.delete(item);
  return global;
}

/** Renders one item and swaps between its views on a left click its content does not handle. */
class ExpandOnClick implements Component {
  private region: MouseRegion;

  constructor(
    child: Component,
    private readonly item: WeakKey,
    private readonly global: boolean,
    private readonly build: (expanded: boolean) => Component | undefined,
  ) {
    this.region = this.wrap(child);
  }

  private wrap(child: Component): MouseRegion {
    return new MouseRegion(child, (event) => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      const expanded = !viewFor(this.item, this.global);
      const next = this.build(expanded);
      if (!next) return undefined;
      clickedViews.set(this.item, { global: this.global, expanded });
      this.region = this.wrap(next);
      return { handled: true };
    });
  }

  render(width: number): string[] {
    return this.region.render(width);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.region.handleMouse(event);
  }

  invalidate(): void {
    this.region.invalidate();
  }
}

function expandOnClick<Item extends WeakKey, Options extends { expanded: boolean }, RenderTheme>(
  render: ItemRenderer<Item, Options, RenderTheme>,
): ItemRenderer<Item, Options, RenderTheme> {
  return (item, options, theme) => {
    const build = (expanded: boolean) => render(item, { ...options, expanded }, theme);
    const child = build(viewFor(item, options.expanded));
    return child && new ExpandOnClick(child, item, options.expanded, build);
  };
}

/**
 * Lets a click toggle a custom message between its Collapsed and Expanded View, as Pi's tool rows
 * and built-in messages do. Pi's custom-message host has no click handling of its own, so wrap the
 * renderer passed to `registerMessageRenderer`. ctrl+o still sets every item.
 */
export function expandMessageOnClick<T>(render: MessageRenderer<T>): MessageRenderer<T> {
  return expandOnClick(render);
}

/** `expandMessageOnClick` for the renderer passed to `registerEntryRenderer`. */
export function expandEntryOnClick<T>(render: EntryRenderer<T>): EntryRenderer<T> {
  return expandOnClick(render);
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

/** The parts of Pi's `ToolRenderContext` the duration footers read. */
export interface DurationContext {
  /** Shared by every render of one tool row; keys the renderer's clock. */
  state: WeakKey;
  executionStarted: boolean;
  /** Whether the call is still running; true for the call row until the final result. */
  isPartial: boolean;
  /** Pi records this only after `execute()` returns. */
  durationMs: number | undefined;
  invalidate(): void;
}

interface DurationTracker {
  startedAt: number | undefined;
  endedAt: number | undefined;
  interval: ReturnType<typeof setInterval> | undefined;
  /** Set once a result renderer has run, so the call row stops showing its own footer. */
  resultSeen: boolean;
}

const trackers = new WeakMap<WeakKey, DurationTracker>();

function trackerFor(context: DurationContext): DurationTracker {
  let tracker = trackers.get(context.state);
  if (!tracker) {
    tracker = { startedAt: undefined, endedAt: undefined, interval: undefined, resultSeen: false };
    trackers.set(context.state, tracker);
  }
  return tracker;
}

/**
 * Start the renderer's own clock once the call is executing and redraw the row every second until
 * the call finishes.
 */
function track(context: DurationContext, isPartial: boolean): DurationTracker {
  const tracker = trackerFor(context);
  if (tracker.startedAt === undefined && context.executionStarted) tracker.startedAt = Date.now();
  if (tracker.startedAt === undefined) return tracker;
  if (isPartial) {
    tracker.interval ??= setInterval(() => context.invalidate(), 1000);
  } else {
    if (tracker.interval) clearInterval(tracker.interval);
    tracker.interval = undefined;
    tracker.endedAt ??= Date.now();
  }
  return tracker;
}

function elapsedMs(tracker: DurationTracker): number | undefined {
  return tracker.startedAt === undefined
    ? undefined
    : (tracker.endedAt ?? Date.now()) - tracker.startedAt;
}

/**
 * Pi's duration footer for a result row: `Elapsed 1.2s` while the call runs, `Took 1.2s` once it
 * finishes. A final result's recorded duration wins because it is monotonic and survives reloads;
 * the renderer's own clock covers live progress and results stored without one. Absent when
 * neither is known.
 */
export function durationFooter(
  theme: Pick<UiTheme, "fg">,
  context: DurationContext,
  options: { isPartial: boolean },
): string | undefined {
  const tracker = track(context, options.isPartial);
  tracker.resultSeen = true;
  if (!options.isPartial && context.durationMs !== undefined) {
    return theme.fg("muted", `Took ${formatDuration(context.durationMs)}`);
  }
  const elapsed = elapsedMs(tracker);
  if (elapsed === undefined) return undefined;
  return theme.fg("muted", `${options.isPartial ? "Elapsed" : "Took"} ${formatDuration(elapsed)}`);
}

/**
 * Append the duration footer to a result container, preceded by Pi's blank line as in its bash
 * renderer. Adds nothing when no duration is known. Every result renderer uses this so the footer
 * spaces identically in every package.
 */
export function appendDurationFooter(
  container: Container,
  theme: Pick<UiTheme, "fg">,
  context: DurationContext,
  options: { isPartial: boolean },
): void {
  const footer = durationFooter(theme, context, options);
  if (footer === undefined) return;
  container.addChild(new Spacer(1));
  container.addChild(new Text(footer, 0, 0));
}

/**
 * The `Elapsed` footer for a call row. Pi renders a result row only once a result exists, so a tool
 * that sends no partial results shows its running time here. The footer disappears when a result
 * row takes over, checked when drawn so both never show at once.
 */
export function callDurationFooter(
  theme: Pick<UiTheme, "fg">,
  context: DurationContext,
): Component {
  const tracker = track(context, context.isPartial);
  return {
    render: () => {
      const elapsed = elapsedMs(tracker);
      if (tracker.resultSeen || tracker.endedAt !== undefined || elapsed === undefined) return [];
      return [theme.fg("muted", `Elapsed ${formatDuration(elapsed)}`)];
    },
    invalidate: () => {},
  };
}

/**
 * Pi's tree prefix for a nested row: one guide per ancestor (`│  ` while that ancestor has later
 * siblings, blank when it was last), then `├─ ` or `└─ `.
 */
export function treePrefix(ancestorsLast: readonly boolean[], isLast: boolean): string {
  const guides = ancestorsLast.map((last) => (last ? "   " : "│  ")).join("");
  return `${guides}${isLast ? "└─ " : "├─ "}`;
}

export interface WidgetLayout {
  title: string;
  /** Muted counts after the title, such as `3 active · 2 done`. */
  counts?: string;
  rows: readonly string[];
}

/**
 * A widget in the shared layout: a bold `toolTitle` name with muted counts, then rows, kept under
 * Pi's widget cap with a `... N more` line.
 */
export function widgetLines(theme: Pick<UiTheme, "fg" | "bold">, layout: WidgetLayout): string[] {
  const header = [theme.fg("toolTitle", theme.bold(layout.title))];
  if (layout.counts) header.push(theme.fg("muted", layout.counts));
  const room = WIDGET_MAX_LINES - 1;
  if (layout.rows.length <= room) return [header.join(" "), ...layout.rows];
  const shown = room - 1;
  return [
    header.join(" "),
    ...layout.rows.slice(0, shown),
    theme.fg("muted", `... ${layout.rows.length - shown} more`),
  ];
}

/**
 * A footer hint line for a custom overlay, as Pi's selector draws it: each key in `dim` and its
 * description in `muted`, separated by two spaces. Pass the key text from `keyText(id)` so it
 * follows the user's keybindings. Built from the injected theme, unlike Pi's own `keyHint`.
 */
export function hintLine(
  theme: Pick<UiTheme, "fg">,
  hints: readonly { key: string; description: string }[],
): string {
  return hints
    .map((hint) => theme.fg("dim", hint.key) + theme.fg("muted", ` ${hint.description}`))
    .join("  ");
}

/** One footer status entry: an optional Status Mark, the name in `dim`, then the value. */
export function footerStatus(
  theme: Pick<UiTheme, "fg">,
  entry: { mark?: StatusKind; name: string; value: string },
): string {
  return [
    entry.mark ? statusMark(theme, entry.mark) : undefined,
    theme.fg("dim", entry.name),
    entry.value,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

/**
 * Pi's custom-message look for message and entry renderers: a `customMessageBg` box padded by
 * `outputPad`, with an optional bold `customMessageLabel` header and a spacer above the body.
 */
export function customMessageBox(
  theme: Pick<UiTheme, "fg" | "bg" | "bold">,
  options: { outputPad: number; label?: string },
  body: readonly Component[],
): Box {
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  if (options.label !== undefined) {
    box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(options.label)), 0, 0));
    box.addChild(new Spacer(1));
  }
  for (const child of body) box.addChild(child);
  return box;
}

const ESCAPE = String.fromCharCode(27);
const RESET_SEQUENCE = new RegExp(`${ESCAPE}\\[0m`, "g");

/**
 * Clip plain text to `width` columns, ending with `...` when it is cut. Unlike pi-tui's
 * `truncateToWidth` it emits no escape sequence, so the result can be styled afterwards.
 */
export function clipPlain(text: string, width: number): string {
  return truncateToWidth(text, width, "...").replace(RESET_SEQUENCE, "");
}

/** A warning or error notification: `<Display Name>: message`. Info messages carry no prefix. */
export function noticeText(displayName: string, message: string): string {
  return `${displayName}: ${message}`;
}
