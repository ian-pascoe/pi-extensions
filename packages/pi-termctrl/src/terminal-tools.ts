import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  truncateTail,
  type ExtensionToolContext,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type { Key } from "@kitlangton/terminal-control";
import { Type, type Static } from "typebox";
import type {
  BackgroundJobEntry,
  TermctrlEntry,
  TermctrlRegistry,
  TerminalEntry,
} from "./termctrl-registry.js";
import { describeExitStatus } from "./exit-notification.js";
import { termctrlTemporaryDirectory } from "./termctrl-driver.js";
import type { TerminalViewport } from "./pi-termctrl-settings.js";
import type { TerminalExit, TerminalSnapshot } from "./terminal-driver.js";
import { TROUBLESHOOTING_HINT } from "./troubleshooting-skill.js";

/** Screen quiet period that settles a Terminal. */
export const QUIET_MS = 250;
const POLL_MS = 50;
export const START_WAIT_MS = 2_000;
export const INPUT_WAIT_MS = 500;
export const POLL_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 5 * 60_000;

const CONTROL_KEYS = Array.from(
  { length: 26 },
  (_, index) => `Control+${String.fromCodePoint(65 + index)}`,
);
/** Every termctrl `Key` name the agent may send. */
export const TERMINAL_KEYS: readonly string[] = [
  "Enter",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Tab",
  "Shift+Tab",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  ...CONTROL_KEYS,
];
const TERMINAL_KEY_SET: ReadonlySet<string> = new Set(TERMINAL_KEYS);

function isKey(name: string): name is Key {
  return TERMINAL_KEY_SET.has(name);
}

/** The shell Pi's `bash` uses, plus its `shellCommandPrefix`. */
export interface TerminalShell {
  readonly shell: string;
  readonly args: readonly string[];
  readonly commandPrefix: string | undefined;
}

/** Session-scoped values the Terminal tools read at call time. */
export interface TerminalToolRuntime {
  readonly registry: TermctrlRegistry;
  readonly shell: () => TerminalShell;
  readonly viewport: () => TerminalViewport;
}

const TerminalStateSchema = Type.Union([Type.Literal("running"), Type.Literal("exited")]);

const TerminalResultSchema = Type.Object({
  id: Type.String(),
  state: TerminalStateSchema,
  exit_code: Type.Optional(Type.Number({ description: "Present once the Terminal has exited" })),
  signal: Type.Optional(Type.String({ description: "Present when a signal ended the Terminal" })),
  changed: Type.Boolean({ description: "Whether the screen differs from the previous result" }),
  screen: Type.String({ description: "The visible screen" }),
  scrolled_off: Type.String({
    description: "Log lines that scrolled off the screen since the previous result",
  }),
  output_missing: Type.Optional(
    Type.Boolean({
      description:
        "Present when output before scrolled_off is missing: termctrl dropped it or the screen was cleared",
    }),
  ),
  full_output_path: Type.Optional(
    Type.String({
      description: "Present when the result was truncated: the file with all its lines",
    }),
  ),
});
type TerminalResult = Static<typeof TerminalResultSchema>;

const ListEntrySchema = Type.Object({
  id: Type.String(),
  command: Type.String(),
  state: TerminalStateSchema,
  exit_code: Type.Optional(Type.Number()),
  signal: Type.Optional(Type.String()),
  age_seconds: Type.Number(),
});
const ListResultSchema = Type.Object({
  terminals: Type.Array(ListEntrySchema),
  background_jobs: Type.Array(
    Type.Object({ ...ListEntrySchema.properties, log_path: Type.String() }),
  ),
});
type ListResult = Static<typeof ListResultSchema>;

const StopResultSchema = Type.Object({
  id: Type.String(),
  kind: Type.Union([Type.Literal("terminal"), Type.Literal("background_job")]),
  state: TerminalStateSchema,
  exit_code: Type.Optional(Type.Number()),
  signal: Type.Optional(Type.String()),
  changed: Type.Optional(
    Type.Boolean({
      description: "Terminal only: whether the screen differs from the previous result",
    }),
  ),
  screen: Type.Optional(Type.String({ description: "Terminal only: the final screen" })),
  scrolled_off: Type.Optional(
    Type.String({
      description: "Terminal only: lines that scrolled off since the previous result",
    }),
  ),
  output_missing: Type.Optional(
    Type.Boolean({
      description:
        "Terminal only: present when output before scrolled_off is missing: termctrl dropped it or the screen was cleared",
    }),
  ),
  full_output_path: Type.Optional(
    Type.String({
      description:
        "Terminal only: present when the result was truncated: the file with all its lines",
    }),
  ),
  output: Type.Optional(Type.String({ description: "Background job only: its recent output" })),
});
type StopResult = Static<typeof StopResultSchema>;

const WaitMsSchema = Type.Optional(
  Type.Integer({ minimum: 0, description: "Maximum milliseconds to wait (clamped to 300000)" }),
);

const StartParameters = Type.Object(
  {
    command: Type.String({ description: "Shell command that starts the program" }),
    cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
    wait_ms: WaitMsSchema,
    notify: Type.Optional(
      Type.Boolean({ description: "Send an Exit notification when it exits (default true)" }),
    ),
  },
  { additionalProperties: false },
);

const SendParameters = Type.Object(
  {
    id: Type.String({ description: "Terminal id, such as t1" }),
    text: Type.Optional(Type.String({ description: "Text to type; \\n presses Enter" })),
    keys: Type.Optional(
      Type.Array(Type.String(), {
        description: `Keys pressed after text: ${TERMINAL_KEYS.slice(0, 14).join(", ")}, Control+A to Control+Z`,
      }),
    ),
    wait_for_text: Type.Optional(
      Type.String({ description: "Wait until the screen shows this text, or /regex/flags" }),
    ),
    wait_ms: WaitMsSchema,
  },
  { additionalProperties: false },
);

const StopParameters = Type.Object(
  { id: Type.String({ description: "A Terminal id (t1) or Background job id (b1)" }) },
  { additionalProperties: false },
);

const ListParameters = Type.Object({}, { additionalProperties: false });

/** Clamp a requested wait to the fixed 0 to 5 minute range. */
export function clampWait(requested: number | undefined, fallback: number): number {
  return Math.min(MAX_WAIT_MS, Math.max(0, requested ?? fallback));
}

/** Parse `wait_for_text`: `/source/flags` is a regex; anything else is a literal substring. */
export function parseWaitPattern(pattern: string): (screen: string) => boolean {
  const match = /^\/(.+)\/([dgimsuvy]*)$/su.exec(pattern);
  if (match?.[1] !== undefined) {
    const regex = new RegExp(match[1], (match[2] ?? "").replaceAll(/[gy]/gu, ""));
    return (screen) => regex.test(screen);
  }
  return (screen) => screen.includes(pattern);
}

type SettleMode = "start" | "input" | "poll";
/** Why a Terminal wait ended. */
export type SettleReason = "quiet" | "matched" | "exited" | "timeout";

interface SettleRequest {
  readonly mode: SettleMode;
  readonly waitMs: number;
  readonly startedAt: number;
  readonly matches: ((screen: string) => boolean) | undefined;
  /** The screen before the call. A match already on it counts only once the screen changes. */
  readonly baseline: string | undefined;
  readonly signal: AbortSignal | undefined;
}

/**
 * Poll a Terminal until it settles: screen quiet for 250 ms, a `wait_for_text` match, process exit,
 * or the wait budget running out. A poll (no input) settles on quiet only after new output.
 * With `wait_for_text`, quiet does not settle the wait.
 */
export async function settleTerminal(
  entry: TerminalEntry,
  request: SettleRequest,
): Promise<{ readonly snapshot: TerminalSnapshot; readonly reason: SettleReason }> {
  const deadline = request.startedAt + request.waitMs;
  let previousScreen: string | undefined;
  let lastChangeAt = request.startedAt;
  let sawOutput = false;
  for (;;) {
    const snapshot = await entry.handle.snapshot();
    const now = Date.now();
    if (previousScreen !== undefined && snapshot.screen !== previousScreen) lastChangeAt = now;
    previousScreen = snapshot.screen;
    const outputAt =
      snapshot.idleForMs === null ? lastChangeAt : Math.max(lastChangeAt, now - snapshot.idleForMs);
    if (outputAt > request.startedAt) sawOutput = true;

    if (snapshot.state === "exited") return { snapshot, reason: "exited" };
    if (request.matches !== undefined) {
      const stale =
        request.baseline !== undefined &&
        snapshot.screen === request.baseline &&
        request.matches(request.baseline);
      if (!stale && request.matches(snapshot.screen)) return { snapshot, reason: "matched" };
    } else if (
      (request.mode !== "poll" || sawOutput) &&
      now - Math.max(outputAt, request.startedAt) >= QUIET_MS
    ) {
      return { snapshot, reason: "quiet" };
    }
    if (now >= deadline || request.signal?.aborted === true) return { snapshot, reason: "timeout" };
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, deadline - now)));
  }
}

function exitFields(exit: TerminalExit | null): Pick<TerminalResult, "exit_code" | "signal"> {
  const fields: Pick<TerminalResult, "exit_code" | "signal"> = {};
  if (exit?.code !== null && exit?.code !== undefined) fields.exit_code = exit.code;
  if (exit?.signal !== null && exit?.signal !== undefined) fields.signal = exit.signal;
  return fields;
}

function describeExit(exit: TerminalExit | null): string {
  return exit === null ? "exited" : describeExitStatus(exit);
}

/** Lines kept before the log cursor to find it again after termctrl trims its scrollback. */
const ANCHOR_LINES = 5;

/** Scrolled-off lines, and whether output before them is missing from termctrl's log. */
interface ScrolledOff {
  readonly lines: readonly string[];
  readonly gap: boolean;
}

const NOTHING_SCROLLED: ScrolledOff = { lines: [], gap: false };

/**
 * Find the log cursor in a fresh copy of termctrl's log, or `undefined` when its anchor is gone.
 * termctrl keeps limited scrollback and drops lines from the top, so the cursor can only move up.
 * Lines above the screen never change; matching only the anchor's newest lines still finds a
 * cursor whose older anchor lines were dropped. While the cursor is 0 the anchor is the log's first
 * line, which was on the screen and may have been extended since, as by typing at a prompt.
 */
function locateCursor(
  lines: readonly string[],
  cursor: number,
  anchor: readonly string[],
): number | undefined {
  if (anchor.length === 0) return 0;
  if (cursor === 0) return lines[0]?.startsWith(anchor[0] ?? "") === true ? 0 : undefined;
  for (let end = Math.min(cursor, lines.length); end >= 1; end--) {
    const count = Math.min(anchor.length, end);
    let matches = true;
    for (let offset = 1; offset <= count && matches; offset++) {
      matches = lines[end - offset] === anchor[anchor.length - offset];
    }
    if (matches) return end;
  }
  return undefined;
}

/**
 * Lines that left the screen since the previous result, advancing the Terminal's log cursor.
 * Lines still on the screen stay unread, so a line rewritten after the agent saw it, such as a
 * progress line, is reported in its final form once it scrolls off. When the cursor cannot be found
 * again, because termctrl dropped lines the agent never received or the screen was cleared, every
 * line termctrl still holds is reported and the result says that earlier output is missing.
 */
async function takeScrolledOff(entry: TerminalEntry, screen: string): Promise<ScrolledOff> {
  let logs: string;
  try {
    logs = await entry.handle.logs();
  } catch {
    return NOTHING_SCROLLED;
  }
  const lines = logs === "" ? [] : logs.split("\n");
  const located = locateCursor(lines, entry.logCursor, entry.logAnchor);
  const screenLines = screen === "" ? 0 : screen.split("\n").length;
  const boundary = Math.max(0, lines.length - screenLines);
  const scrolled = lines.slice(Math.min(located ?? 0, boundary), boundary);
  entry.logCursor = boundary;
  entry.logAnchor =
    boundary > 0 ? lines.slice(Math.max(0, boundary - ANCHOR_LINES), boundary) : lines.slice(0, 1);
  return { lines: scrolled, gap: located === undefined };
}

const GAP_NOTICE =
  "[Earlier output is missing: termctrl keeps limited scrollback and dropped lines, or the screen was cleared. For complete output, run the command with bash or redirect it to a file.]";

/** A Terminal result's screen and scrolled-off lines, fitted to Pi's tool output limits. */
interface FittedOutput {
  readonly screen: string;
  readonly scrolledOff: string;
  readonly fullOutputPath?: string;
  /** Output before the scrolled-off lines is missing from termctrl's log. */
  readonly gap: boolean;
  /** Explains missing or truncated output; appended to the result text. */
  readonly notice?: string;
}

function emptyTruncation(content: string): TruncationResult {
  const totalLines = content === "" ? 0 : content.split("\n").length;
  return {
    content: "",
    truncated: content !== "",
    truncatedBy: content === "" ? null : "bytes",
    totalLines,
    totalBytes: Buffer.byteLength(content, "utf8"),
    outputLines: 0,
    outputBytes: 0,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines: 0,
    maxBytes: 0,
  };
}

/**
 * Fit a result into Pi's 2000-line and 50 KB limits. The screen is kept first, from its bottom;
 * the newest scrolled-off lines fill what is left. When anything is cut, every line of the result
 * goes to a full output file that lasts until the owner's session shuts down.
 */
async function fitOutput(
  registry: TermctrlRegistry,
  entry: TerminalEntry,
  screen: string,
  scrolled: ScrolledOff,
): Promise<FittedOutput> {
  const fitted = await truncateOutput(registry, entry, screen, scrolled.lines);
  if (!scrolled.gap) return { ...fitted, gap: false };
  const notice = fitted.notice === undefined ? GAP_NOTICE : `${GAP_NOTICE}\n${fitted.notice}`;
  return { ...fitted, gap: true, notice };
}

async function truncateOutput(
  registry: TermctrlRegistry,
  entry: TerminalEntry,
  screen: string,
  scrolled: readonly string[],
): Promise<Omit<FittedOutput, "gap">> {
  const limits = { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES };
  const scrolledText = scrolled.join("\n");
  const shownScreen = truncateTail(screen, limits);
  const lineBudget = limits.maxLines - shownScreen.outputLines;
  // One byte for the newline that joins the scrolled-off lines to the screen.
  const byteBudget = limits.maxBytes - shownScreen.outputBytes - 1;
  const shownScrolled =
    lineBudget > 0 && byteBudget > 0
      ? truncateTail(scrolledText, { maxLines: lineBudget, maxBytes: byteBudget })
      : emptyTruncation(scrolledText);
  if (!shownScreen.truncated && !shownScrolled.truncated)
    return { screen, scrolledOff: scrolledText };

  const total = shownScrolled.totalLines + shownScreen.totalLines;
  const shown = shownScrolled.outputLines + shownScreen.outputLines;
  const fitted = { screen: shownScreen.content, scrolledOff: shownScrolled.content };
  const range = `[Showing lines ${total - shown + 1}-${total} of ${total} (${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} line limit).`;
  const directory = termctrlTemporaryDirectory();
  let path: string;
  try {
    path = registry.reserveOutputFile(entry.owner, entry.id, directory);
    await mkdir(directory, { recursive: true });
    const full =
      scrolledText === "" ? screen : screen === "" ? scrolledText : `${scrolledText}\n${screen}`;
    await writeFile(path, full, { encoding: "utf8", mode: 0o600 });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { ...fitted, notice: `${range} The full output could not be saved: ${reason}]` };
  }
  return { ...fitted, fullOutputPath: path, notice: `${range} Full output: ${path}]` };
}

function formatTerminalText(
  result: TerminalResult,
  note: string | undefined,
  notice: string | undefined,
): string {
  const exit =
    result.state === "running"
      ? "running"
      : describeExit({ code: result.exit_code ?? null, signal: result.signal ?? null });
  const parts = [`${result.id} ${exit}${result.changed ? "" : " · screen unchanged"}`];
  if (note !== undefined) parts.push(note);
  if (result.scrolled_off !== "") {
    parts.push(`--- scrolled off ---\n${result.scrolled_off}`);
  }
  parts.push(`--- screen ---\n${result.screen === "" ? "(blank)" : result.screen}`);
  const text = parts.join("\n");
  return notice === undefined ? text : `${text}\n\n${notice}`;
}

/** Build the agent's view of a Terminal after a wait, recording the exit as seen. */
async function terminalResult(
  registry: TermctrlRegistry,
  entry: TerminalEntry,
  snapshot: TerminalSnapshot | undefined,
  note?: string,
) {
  const screen = snapshot?.screen ?? entry.finalScreen ?? entry.lastScreen ?? "";
  const scrolled =
    entry.state === "running" || snapshot !== undefined
      ? await takeScrolledOff(entry, screen)
      : NOTHING_SCROLLED;
  const output = await fitOutput(registry, entry, screen, scrolled);
  if (snapshot?.state === "exited") {
    registry.terminalExited(entry.id, snapshot.exit ?? { code: null, signal: null }, screen, true);
  }
  registry.markSeen(entry.id);
  const exited = entry.state === "exited";
  const result: TerminalResult = {
    id: entry.id,
    state: exited ? "exited" : "running",
    ...exitFields(exited ? entry.exit : null),
    changed: entry.lastScreen !== screen,
    screen: output.screen,
    scrolled_off: output.scrolledOff,
  };
  if (output.gap) result.output_missing = true;
  if (output.fullOutputPath !== undefined) result.full_output_path = output.fullOutputPath;
  entry.lastScreen = screen;
  return {
    content: [{ type: "text" as const, text: formatTerminalText(result, note, output.notice) }],
    details: result,
    structuredContent: result,
  };
}

async function driveTerminal<T>(
  registry: TermctrlRegistry,
  entry: TerminalEntry,
  run: () => Promise<T>,
): Promise<T> {
  entry.activeCalls++;
  try {
    return await run();
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (registry.reportTerminalError(entry, error)) {
      throw new Error(
        `${entry.id} was lost because the termctrl driver exited\n\n${TROUBLESHOOTING_HINT}`,
        { cause },
      );
    }
    throw error;
  } finally {
    entry.activeCalls--;
  }
}

function ownerOf(context: ExtensionToolContext): string {
  return context.sessionManager.getSessionId();
}

function unknownId(id: string): Error {
  return new Error(
    `Unknown id ${id}. Call terminal_list to see your Terminals and Background jobs.`,
  );
}

function shellCommand(shell: TerminalShell, command: string): [string, ...string[]] {
  const script = shell.commandPrefix ? `${shell.commandPrefix}\n${command}` : command;
  return [shell.shell, ...shell.args, script];
}

/** `terminal_start`: run a program in a new Terminal and wait for it to settle. */
export function createTerminalStartTool(runtime: TerminalToolRuntime) {
  return defineTool<typeof StartParameters, TerminalResult>({
    name: "terminal_start",
    label: "terminal_start",
    description:
      "Start a program in a new interactive Terminal (a PTY) and return its screen once it settles: 250 ms of quiet, exit, or wait_ms (default 2000). Use it for REPLs, TUIs, prompts and other programs that need input or a screen. Drive it with terminal_send and end it with terminal_stop.",
    promptSnippet: "Start an interactive program (REPL, TUI, prompt) in a Terminal",
    promptGuidelines: [
      "Use terminal_start, terminal_send and terminal_stop for programs that need input or a screen; use bash for everything else.",
      "Terminals keep limited scrollback, so long output can be lost; run commands whose full output you need with bash, or redirect their output to a file.",
    ],
    parameters: StartParameters,
    outputSchema: TerminalResultSchema,
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const entry = await runtime.registry.startTerminal(ownerOf(context), {
        command: shellCommand(runtime.shell(), params.command),
        displayCommand: params.command,
        cwd: resolve(context.cwd, params.cwd ?? "."),
        viewport: runtime.viewport(),
        notify: params.notify ?? true,
      });
      // Launching, including a cold driver start, does not count toward the quiet period.
      const startedAt = Date.now();
      return driveTerminal(runtime.registry, entry, async () => {
        const { snapshot } = await settleTerminal(entry, {
          mode: "start",
          waitMs: clampWait(params.wait_ms, START_WAIT_MS),
          startedAt,
          matches: undefined,
          baseline: undefined,
          signal,
        });
        return terminalResult(runtime.registry, entry, snapshot);
      });
    },
  });
}

/** `terminal_send`: type text and keys into a Terminal, or poll it, and wait for it to settle. */
export function createTerminalSendTool(runtime: TerminalToolRuntime) {
  return defineTool<typeof SendParameters, TerminalResult>({
    name: "terminal_send",
    label: "terminal_send",
    description:
      "Type text and press keys in a Terminal, then return its screen once it settles: 250 ms of quiet, a wait_for_text match, exit, or wait_ms (default 500). With neither text nor keys it polls: it waits up to wait_ms (default 30000) for new output. Results include the lines that scrolled off since your previous result; a truncated result names a file with its full output.",
    promptSnippet: "Send input to a Terminal, or poll it, and read its screen",
    parameters: SendParameters,
    outputSchema: TerminalResultSchema,
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const entry = runtime.registry.find(ownerOf(context), params.id);
      if (entry === undefined) throw unknownId(params.id);
      if (entry.kind !== "terminal") {
        throw new Error(
          `${params.id} is a Background job, which accepts no input. Read its log or stop it with terminal_stop.`,
        );
      }
      const keys = params.keys ?? [];
      const invalid = keys.filter((key) => !isKey(key));
      if (invalid.length > 0) {
        throw new Error(
          `Unknown keys: ${invalid.join(", ")}. Valid keys: ${TERMINAL_KEYS.slice(0, 14).join(", ")}, Control+A to Control+Z.`,
        );
      }
      const hasInput = (params.text ?? "") !== "" || keys.length > 0;
      if (entry.state === "exited") {
        return terminalResult(
          runtime.registry,
          entry,
          undefined,
          hasInput ? "Input was not sent because the Terminal has exited." : undefined,
        );
      }
      return driveTerminal(runtime.registry, entry, async () => {
        const matches =
          params.wait_for_text === undefined ? undefined : parseWaitPattern(params.wait_for_text);
        const baseline = matches === undefined ? undefined : (await entry.handle.snapshot()).screen;
        const startedAt = Date.now();
        if (params.text !== undefined && params.text !== "") await entry.handle.type(params.text);
        const validKeys = keys.filter(isKey);
        if (validKeys.length > 0) await entry.handle.press(validKeys);
        const { snapshot } = await settleTerminal(entry, {
          mode: hasInput ? "input" : "poll",
          waitMs: clampWait(params.wait_ms, hasInput ? INPUT_WAIT_MS : POLL_WAIT_MS),
          startedAt,
          matches,
          baseline,
          signal,
        });
        return terminalResult(runtime.registry, entry, snapshot);
      });
    },
  });
}

/** Capture the lines a Terminal scrolled off since the agent's last result, before it is stopped. */
async function finalScrolledOff(
  registry: TermctrlRegistry,
  entry: TerminalEntry,
): Promise<ScrolledOff> {
  try {
    if (entry.state === "exited") return await takeScrolledOff(entry, entry.finalScreen ?? "");
    return await driveTerminal(registry, entry, async () =>
      takeScrolledOff(entry, (await entry.handle.snapshot()).screen),
    );
  } catch {
    return NOTHING_SCROLLED;
  }
}

/** `terminal_stop`: stop a Terminal or Background job and forget it. */
export function createTerminalStopTool(registry: TermctrlRegistry) {
  return defineTool<typeof StopParameters, StopResult>({
    name: "terminal_stop",
    label: "terminal_stop",
    description:
      "Stop a Terminal (t1) or Background job (b1) and forget it. Running processes are killed; exited ones are removed. Returns a Terminal's final screen and scrolled-off lines, or a Background job's recent output.",
    promptSnippet: "Stop a Terminal or Background job",
    parameters: StopParameters,
    outputSchema: StopResultSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const owner = ownerOf(context);
      const known = registry.find(owner, params.id);
      if (known === undefined) throw unknownId(params.id);
      const wasRunning = known.state === "running";
      const previousScreen = known.kind === "terminal" ? known.lastScreen : undefined;
      const scrolled =
        known.kind === "terminal" ? await finalScrolledOff(registry, known) : NOTHING_SCROLLED;
      const entry = (await registry.stop(owner, params.id)) ?? known;
      const label = entry.kind === "terminal" ? "Terminal" : "Background job";
      const header = wasRunning
        ? `${label} ${entry.id} stopped.`
        : `${label} ${entry.id} had already ${describeExit(entry.exit)}; removed.`;
      const result: StopResult = {
        id: entry.id,
        kind: entry.kind === "terminal" ? "terminal" : "background_job",
        state: "exited",
        ...exitFields(entry.exit),
      };
      const parts = [header];
      if (entry.kind === "terminal") {
        const screen = entry.finalScreen ?? "";
        const output = await fitOutput(registry, entry, screen, scrolled);
        result.changed = previousScreen !== screen;
        result.screen = output.screen;
        result.scrolled_off = output.scrolledOff;
        if (output.gap) result.output_missing = true;
        if (output.fullOutputPath !== undefined) result.full_output_path = output.fullOutputPath;
        if (output.scrolledOff !== "") parts.push(`--- scrolled off ---\n${output.scrolledOff}`);
        parts.push(`--- final screen ---\n${output.screen === "" ? "(blank)" : output.screen}`);
        if (output.notice !== undefined) parts.push(`\n${output.notice}`);
      } else {
        result.output = entry.child.tail();
        if (result.output !== "") parts.push(`--- recent output ---\n${result.output}`);
      }
      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
        details: result,
        structuredContent: result,
      };
    },
  });
}

function listEntry(entry: TermctrlEntry, now: number) {
  return {
    id: entry.id,
    command: entry.command,
    state: entry.state,
    ...exitFields(entry.exit),
    age_seconds: Math.round((now - entry.startedAt) / 1000),
  };
}

function listLine(entry: TermctrlEntry, now: number): string {
  const state = entry.state === "running" ? "running" : describeExit(entry.exit);
  const age = Math.round((now - entry.startedAt) / 1000);
  const log = entry.kind === "job" ? ` · log ${entry.child.logPath}` : "";
  return `${entry.id} ${state} · ${age}s · ${entry.command}${log}`;
}

/** `terminal_list`: list the caller's Terminals and Background jobs. */
export function createTerminalListTool(registry: TermctrlRegistry) {
  return defineTool<typeof ListParameters, ListResult>({
    name: "terminal_list",
    label: "terminal_list",
    description:
      "List your Terminals and Background jobs, running and exited, with their state. Background jobs include their log path.",
    promptSnippet: "List Terminals and Background jobs",
    parameters: ListParameters,
    outputSchema: ListResultSchema,
    async execute(_toolCallId, _params, _signal, _onUpdate, context) {
      const now = Date.now();
      const entries = registry.ownedEntries(ownerOf(context));
      const terminals = entries.filter(
        (entry): entry is TerminalEntry => entry.kind === "terminal",
      );
      const jobs = entries.filter((entry): entry is BackgroundJobEntry => entry.kind === "job");
      for (const entry of entries) if (entry.state === "exited") registry.markSeen(entry.id);
      const result: ListResult = {
        terminals: terminals.map((entry) => listEntry(entry, now)),
        background_jobs: jobs.map((entry) => ({
          ...listEntry(entry, now),
          log_path: entry.child.logPath,
        })),
      };
      const section = (title: string, items: readonly TermctrlEntry[]) =>
        `${title}:\n${items.length === 0 ? "(none)" : items.map((entry) => listLine(entry, now)).join("\n")}`;
      return {
        content: [
          {
            type: "text" as const,
            text: `${section("Terminals", terminals)}\n\n${section("Background jobs", jobs)}`,
          },
        ],
        details: result,
        structuredContent: result,
      };
    },
  });
}
