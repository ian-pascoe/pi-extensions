import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import {
  appendDurationFooter,
  callDurationFooter,
  COLLAPSED_LINES,
  expandHint,
  joinInline,
  previewBody,
  toolHeader,
  type DurationContext,
  type UiTheme,
} from "@ian-pascoe/pi-utils/ui";
import { describeExitStatus, formatDuration } from "./exit-notification.js";
import type { ListResult, StopResult, TerminalResult, WaitResult } from "./terminal-tools.js";

type RenderTheme = Pick<UiTheme, "fg" | "bold">;

/** What a result renderer reads from Pi's render context. */
export interface ResultContext extends DurationContext {
  readonly isError: boolean;
}

/** What a result renderer reads from Pi's render options. */
export interface ResultOptions {
  readonly expanded: boolean;
  readonly isPartial: boolean;
}

interface RenderedResult<TDetails> {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly details: TDetails | undefined;
}

/** The widest a typed or sent value gets in a call header before it is cut. */
const ARGUMENT_WIDTH = 60;

function column(...children: Component[]): Container {
  const container = new Container();
  for (const child of children) container.addChild(child);
  return container;
}

function textBlock(lines: readonly string[]): Component {
  return new Text(lines.join("\n"), 0, 0);
}

/** The call row: Pi's header, with the live `Elapsed` footer until a result row takes over. */
function callRow(
  theme: RenderTheme & Pick<UiTheme, "fg">,
  context: DurationContext,
  header: string,
): Component {
  return column(textBlock([header]), callDurationFooter(theme, context));
}

function quoted(value: string): string {
  const characters = Array.from(JSON.stringify(value));
  return characters.length <= ARGUMENT_WIDTH
    ? characters.join("")
    : `${characters.slice(0, ARGUMENT_WIDTH - 3).join("")}...`;
}

function when(condition: boolean, text: string): string | undefined {
  return condition ? text : undefined;
}

function joinArguments(parts: readonly (string | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => part !== undefined);
  return present.length === 0 ? undefined : present.join(" ");
}

/** Arguments of a `terminal_start` call as they stream in, so every one may be absent. */
export interface StartCallArguments {
  readonly command?: string;
  readonly cwd?: string;
  readonly wait_ms?: number;
  readonly notify?: boolean;
}

/** `terminal_start` call row: `terminal_start $ command`, as Pi's bash shows its command. */
export function renderStartCall(
  args: StartCallArguments,
  theme: RenderTheme,
  context: DurationContext,
): Component {
  const command = args.command === undefined ? "..." : args.command;
  const extra = joinArguments([
    args.cwd === undefined ? undefined : `in ${args.cwd}`,
    args.wait_ms === undefined ? undefined : `wait ${args.wait_ms}ms`,
    when(args.notify === false, "no notify"),
  ]);
  return callRow(theme, context, toolHeader(theme, "terminal_start", `$ ${command}`, extra));
}

/** Arguments of a `terminal_send` call as they stream in. */
export interface SendCallArguments {
  readonly id?: string;
  readonly text?: string;
  readonly keys?: readonly string[];
  readonly wait_for_text?: string;
  readonly wait_ms?: number;
}

/** `terminal_send` call row: the Terminal id, then what is typed, pressed and waited for. */
export function renderSendCall(
  args: SendCallArguments,
  theme: RenderTheme,
  context: DurationContext,
): Component {
  const text = args.text ?? "";
  const keys = args.keys ?? [];
  const extra = joinArguments([
    text === "" ? undefined : `type ${quoted(text)}`,
    keys.length === 0 ? undefined : `press ${keys.join(" ")}`,
    args.wait_for_text === undefined ? undefined : `wait_for ${quoted(args.wait_for_text)}`,
    args.wait_ms === undefined ? undefined : `${args.wait_ms}ms`,
    when(text === "" && keys.length === 0 && args.wait_for_text === undefined, "poll"),
  ]);
  return callRow(theme, context, toolHeader(theme, "terminal_send", args.id ?? "...", extra));
}

/** `terminal_stop` call row. */
export function renderStopCall(
  args: { readonly id?: string },
  theme: RenderTheme,
  context: DurationContext,
): Component {
  return callRow(theme, context, toolHeader(theme, "terminal_stop", args.id ?? "..."));
}

/** `terminal_wait` call row: the ids it waits for, or every running entry. */
export function renderWaitCall(
  args: { readonly ids?: readonly string[]; readonly wait_ms?: number },
  theme: RenderTheme,
  context: DurationContext,
): Component {
  const ids = args.ids === undefined || args.ids.length === 0 ? undefined : args.ids.join(" ");
  const extra = args.wait_ms === undefined ? undefined : `${args.wait_ms}ms`;
  return callRow(theme, context, toolHeader(theme, "terminal_wait", ids, extra));
}

/** `terminal_list` takes no arguments. */
export type ListCallArguments = Readonly<Record<never, never>>;

/** `terminal_list` call row. */
export function renderListCall(
  _args: ListCallArguments,
  theme: RenderTheme,
  context: DurationContext,
): Component {
  return callRow(theme, context, toolHeader(theme, "terminal_list"));
}

function contentText(content: RenderedResult<unknown>["content"]): string {
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/** Pi's result layout, as its bash renderer builds it: a blank line, the body, then the footer. */
function resultRow(
  theme: RenderTheme,
  context: ResultContext,
  options: ResultOptions,
  body: readonly string[],
): Component {
  const container = new Container();
  if (body.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(body.join("\n"), 0, 0));
  }
  appendDurationFooter(container, theme, context, { isPartial: options.isPartial });
  return container;
}

function errorRow(
  theme: RenderTheme,
  context: ResultContext,
  options: ResultOptions,
  result: RenderedResult<unknown>,
): Component {
  const lines = contentText(result.content).trim().split("\n");
  return resultRow(
    theme,
    context,
    options,
    previewBody(theme, lines, {
      limit: COLLAPSED_LINES.fallback,
      expanded: options.expanded,
      color: "error",
    }),
  );
}

function warning(theme: RenderTheme, text: string): string {
  return theme.fg("warning", `[${text}]`);
}

function splitLines(text: string | undefined): string[] {
  if (text === undefined || text === "") return [];
  return text.replace(/\n+$/u, "").split("\n");
}

function screenLines(screen: string): string[] {
  const lines = splitLines(screen);
  return lines.length === 0 ? ["(blank)"] : lines;
}

/**
 * A Terminal's lines in bash's Collapsed View, the last 5 with the earlier lines counted in the
 * Expand Hint. The Expanded View labels the scrolled-off lines apart from the screen.
 */
function terminalBody(
  theme: RenderTheme,
  expanded: boolean,
  scrolledOff: readonly string[],
  screen: readonly string[],
): string[] {
  const styled = (lines: readonly string[]) => lines.map((line) => theme.fg("toolOutput", line));
  if (!expanded) {
    return previewBody(theme, [...scrolledOff, ...screen], {
      limit: COLLAPSED_LINES.terminal,
      expanded,
      keep: "end",
    });
  }
  if (scrolledOff.length === 0) return styled(screen);
  return [
    theme.fg("muted", "--- scrolled off ---"),
    ...styled(scrolledOff),
    theme.fg("muted", "--- screen ---"),
    ...styled(screen),
  ];
}

function terminalWarnings(
  theme: RenderTheme,
  details: Pick<TerminalResult, "output_missing" | "full_output_path">,
): string[] {
  const warnings: string[] = [];
  if (details.output_missing === true) warnings.push(warning(theme, "Earlier output is missing"));
  if (details.full_output_path !== undefined) {
    warnings.push(warning(theme, `Full output: ${details.full_output_path}`));
  }
  return warnings;
}

function exitText(details: Pick<TerminalResult, "state" | "exit_code" | "signal">): string {
  return details.state === "running"
    ? "running"
    : describeExitStatus({ code: details.exit_code ?? null, signal: details.signal ?? null });
}

function isFailedExit(details: Pick<TerminalResult, "state" | "exit_code" | "signal">): boolean {
  return details.state === "exited" && (details.exit_code !== 0 || details.signal !== undefined);
}

/** `terminal_start` and `terminal_send` result: a status line, then the screen like bash output. */
export function renderTerminalResult(
  result: RenderedResult<TerminalResult>,
  options: ResultOptions,
  theme: RenderTheme,
  context: ResultContext,
): Component {
  const details = result.details;
  if (context.isError || details === undefined) return errorRow(theme, context, options, result);
  const status = joinInline(theme, [
    theme.fg(isFailedExit(details) ? "warning" : "muted", `${details.id} ${exitText(details)}`),
    theme.fg("muted", `settled: ${details.settle_reason}`),
    details.changed ? undefined : theme.fg("muted", "screen unchanged"),
  ]);
  const body = terminalBody(
    theme,
    options.expanded,
    splitLines(details.scrolled_off),
    screenLines(details.screen),
  );
  return resultRow(theme, context, options, [status, ...body, ...terminalWarnings(theme, details)]);
}

/** `terminal_stop` result: the stop line, then the final screen or the job's recent output. */
export function renderStopResult(
  result: RenderedResult<StopResult>,
  options: ResultOptions,
  theme: RenderTheme,
  context: ResultContext,
): Component {
  const details = result.details;
  if (context.isError || details === undefined) return errorRow(theme, context, options, result);
  const status = theme.fg("muted", contentText(result.content).split("\n")[0] ?? "");
  const body =
    details.kind === "terminal"
      ? terminalBody(
          theme,
          options.expanded,
          splitLines(details.scrolled_off),
          splitLines(details.screen),
        )
      : terminalBody(theme, options.expanded, [], splitLines(details.output));
  return resultRow(theme, context, options, [status, ...body, ...terminalWarnings(theme, details)]);
}

/** A list in ls's Collapsed View: its first 20 rows and the Expand Hint for the rest. */
function listRows(theme: RenderTheme, rows: readonly string[], expanded: boolean): string[] {
  const hidden = rows.length - COLLAPSED_LINES.list;
  if (expanded || hidden <= 0) return [...rows];
  return [...rows.slice(0, COLLAPSED_LINES.list), expandHint(theme, hidden)];
}

function entryRow(
  theme: RenderTheme,
  entry: {
    id: string;
    command: string;
    state: string;
    exit_code?: number | undefined;
    signal?: string | undefined;
  },
  ageSeconds: number,
): string {
  const state =
    entry.state === "running"
      ? "running"
      : describeExitStatus({ code: entry.exit_code ?? null, signal: entry.signal ?? null });
  return `${theme.fg("accent", entry.id)} ${joinInline(theme, [
    theme.fg("toolOutput", state),
    theme.fg("muted", formatDuration(ageSeconds * 1000)),
    theme.fg("toolOutput", entry.command),
  ])}`;
}

/** `terminal_list` result: one row per Terminal and Background job, like ls. */
export function renderListResult(
  result: RenderedResult<ListResult>,
  options: ResultOptions,
  theme: RenderTheme,
  context: ResultContext,
): Component {
  const details = result.details;
  if (context.isError || details === undefined) return errorRow(theme, context, options, result);
  const rows = [
    ...details.terminals.map((entry) => entryRow(theme, entry, entry.age_seconds)),
    ...details.background_jobs.map((entry) => {
      const row = entryRow(theme, entry, entry.age_seconds);
      return options.expanded ? `${row} ${theme.fg("muted", `(log ${entry.log_path})`)}` : row;
    }),
  ];
  const body =
    rows.length === 0 ? [theme.fg("muted", "(none)")] : listRows(theme, rows, options.expanded);
  return resultRow(theme, context, options, body);
}

const WAIT_REASON_SUMMARY = {
  exited: undefined,
  timeout: "Nothing exited before the wait ended",
  message: "Returned early: a message is waiting",
  aborted: "Wait cancelled",
  nothing_running: "Nothing to wait for",
} as const satisfies Record<WaitResult["reason"], string | undefined>;

/**
 * `terminal_wait` result: what exited and what still runs, one row each. The Expanded View adds
 * each exit's last lines.
 */
export function renderWaitResult(
  result: RenderedResult<WaitResult>,
  options: ResultOptions,
  theme: RenderTheme,
  context: ResultContext,
): Component {
  const details = result.details;
  if (context.isError || details === undefined) return errorRow(theme, context, options, result);
  const summary = WAIT_REASON_SUMMARY[details.reason];
  const rows: string[] = [];
  for (const exit of details.exited) {
    const status = describeExitStatus({
      code: exit.exit_code ?? null,
      signal: exit.signal ?? null,
    });
    rows.push(
      `${theme.fg("accent", exit.id)} ${joinInline(theme, [
        theme.fg("toolOutput", status),
        theme.fg("muted", formatDuration(exit.duration_ms)),
        theme.fg("toolOutput", exit.command),
      ])}`,
    );
    if (options.expanded) {
      for (const line of splitLines(exit.output)) rows.push(`  ${theme.fg("toolOutput", line)}`);
      if (exit.log_path !== undefined) rows.push(theme.fg("muted", `  Log: ${exit.log_path}`));
    }
  }
  for (const entry of details.running) {
    rows.push(entryRow(theme, { ...entry, state: "running" }, entry.age_seconds));
  }
  const body = [
    ...(summary === undefined ? [] : [theme.fg("muted", summary)]),
    ...listRows(theme, rows, options.expanded),
  ];
  return resultRow(theme, context, options, body);
}
