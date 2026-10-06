import { mkdir, stat, writeFile } from "node:fs/promises";
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
import { describeExitStatus, formatExitNotice, lastLines } from "./exit-notification.js";
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
/** How often `terminal_wait` checks for a queued message, which raises no event it can await. */
export const PENDING_CHECK_MS = 100;

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

const SettleReasonSchema = Type.Union(
  [Type.Literal("matched"), Type.Literal("timeout"), Type.Literal("quiet"), Type.Literal("exited")],
  {
    description:
      "Why the wait ended: wait_for_text matched, wait_ms ran out or the call was cancelled, the screen was quiet for 250 ms, or the Terminal exited",
  },
);

const TerminalResultSchema = Type.Object({
  id: Type.String(),
  state: TerminalStateSchema,
  settle_reason: SettleReasonSchema,
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
  screen: Type.Optional(
    Type.String({
      description:
        "Terminal only: the final screen; omitted when unchanged since your previous result",
    }),
  ),
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
      Type.Boolean({
        description:
          "Send an Exit notification when it exits (default true); to block until it exits, use terminal_wait",
      }),
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

const WaitParameters = Type.Object(
  {
    ids: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Terminal or Background job ids to wait for (default: all of yours still running)",
      }),
    ),
    wait_ms: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Maximum milliseconds to wait (default and maximum 300000)",
      }),
    ),
  },
  { additionalProperties: false },
);

const EntryKindSchema = Type.Union([Type.Literal("terminal"), Type.Literal("background_job")]);

const WaitResultSchema = Type.Object({
  reason: Type.Union(
    [
      Type.Literal("exited"),
      Type.Literal("timeout"),
      Type.Literal("message"),
      Type.Literal("aborted"),
      Type.Literal("nothing_running"),
    ],
    {
      description:
        "Why the wait ended: an exit, wait_ms, a message queued for you, cancellation, or nothing to wait for",
    },
  ),
  exited: Type.Array(
    Type.Object({
      id: Type.String(),
      kind: EntryKindSchema,
      command: Type.String(),
      exit_code: Type.Optional(Type.Number()),
      signal: Type.Optional(Type.String()),
      duration_ms: Type.Number(),
      output: Type.String({
        description: "Last lines of a Terminal's final screen or a Background job's output",
      }),
      log_path: Type.Optional(Type.String({ description: "Background job only: its log" })),
    }),
  ),
  running: Type.Array(
    Type.Object({
      id: Type.String(),
      kind: EntryKindSchema,
      command: Type.String(),
      age_seconds: Type.Number(),
    }),
  ),
});
type WaitResult = Static<typeof WaitResultSchema>;
type WaitReason = WaitResult["reason"];

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
export type SettleReason = Static<typeof SettleReasonSchema>;

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
 * Find where the result's screen starts in termctrl's log. The screen is read before the log, in a
 * separate termctrl request, so output in between can already have pushed the screen's top lines
 * above the log's last screenful. Output only adds lines to the end of the log, so the screen is at
 * the end or higher up, no higher than the log cursor. The screen is matched by every line except
 * its last, which the program may still be writing. When nothing matches, as when the screen was
 * redrawn in between, the log's last screenful is taken as the screen.
 */
function locateScreen(lines: readonly string[], screen: readonly string[], floor: number): number {
  const end = Math.max(0, lines.length - screen.length);
  for (let start = end; start >= floor; start--) {
    let matches = true;
    for (let row = 0; row < screen.length - 1 && matches; row++) {
      matches = lines[start + row] === screen[row];
    }
    if (matches) return start;
  }
  return end;
}

/**
 * Lines that left the screen since the previous result, advancing the Terminal's log cursor.
 * Lines still on the result's screen stay unread, so a line rewritten after the agent saw it, such
 * as a progress line, is reported in its final form once it scrolls off. When the cursor cannot be
 * found again, because termctrl dropped lines the agent never received or the screen was cleared,
 * every line termctrl still holds is reported and the result says that earlier output is missing.
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
  const screenLines = screen === "" ? [] : screen.split("\n");
  const boundary = locateScreen(lines, screenLines, located ?? 0);
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

/** Says that `wait_for_text` was not seen when its wait timed out. */
function unmatchedNote(reason: SettleReason, pattern: string | undefined): string | undefined {
  return reason === "timeout" && pattern !== undefined
    ? `wait_for_text ${JSON.stringify(pattern)} was not seen before the wait ended.`
    : undefined;
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
  const parts = [
    `${result.id} ${exit} · settled: ${result.settle_reason}${result.changed ? "" : " · screen unchanged"}`,
  ];
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
  settleReason: SettleReason,
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
    settle_reason: settleReason,
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

/** A call that was removed from its Terminal's queue before it started. */
class CallCancelledError extends Error {
  constructor(id: string) {
    super(`The call to ${id} was cancelled before it started.`);
    this.name = "CallCancelledError";
  }
}

/**
 * Wait for this call's turn on a Terminal. Calls to one Terminal run one at a time, each typing,
 * pressing keys and settling before the next starts, so a parallel batch of sends gets screens
 * that match its calls. Calls to other Terminals are unaffected. Aborting a waiting call removes
 * it from the queue and rejects it; the running call is untouched.
 */
function awaitTurn(entry: TerminalEntry, signal: AbortSignal | undefined): Promise<() => void> {
  const queue = entry.callQueue;
  const release = () => {
    const next = queue.waiting.shift();
    if (next === undefined) queue.running = false;
    else next();
  };
  if (signal?.aborted === true) return Promise.reject(new CallCancelledError(entry.id));
  if (!queue.running) {
    queue.running = true;
    return Promise.resolve(release);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const index = queue.waiting.indexOf(start);
      if (index !== -1) queue.waiting.splice(index, 1);
      reject(new CallCancelledError(entry.id));
    };
    const start = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve(release);
    };
    queue.waiting.push(start);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run one call against a Terminal in its turn. A call that waited finds the Terminal as the calls
 * ahead left it, so `run` must read the Terminal's state itself. A Terminal that a call ahead
 * stopped is gone by then.
 */
async function driveTerminal<T>(
  registry: TermctrlRegistry,
  entry: TerminalEntry,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  // Counted while queued too, so the exit watcher leaves a Terminal the agent is driving alone.
  entry.activeCalls++;
  let release: (() => void) | undefined;
  try {
    release = await awaitTurn(entry, signal);
    if (registry.find(entry.owner, entry.id) !== entry) throw unknownId(entry.id);
    return await run();
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (release !== undefined && registry.reportTerminalError(entry, error)) {
      throw new Error(
        `${entry.id} was lost because the termctrl driver exited\n\n${TROUBLESHOOTING_HINT}`,
        { cause },
      );
    }
    throw error;
  } finally {
    release?.();
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

/** Resolve `cwd` against the session's directory and check it is a directory termctrl can start in. */
async function resolveWorkingDirectory(base: string, cwd: string | undefined): Promise<string> {
  const resolved = resolve(base, cwd ?? ".");
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(resolved)).isDirectory();
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`Working directory does not exist: ${resolved}`, { cause });
    }
    throw cause;
  }
  if (!isDirectory) throw new Error(`Working directory is not a directory: ${resolved}`);
  return resolved;
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
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    outputSchema: TerminalResultSchema,
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const cwd = await resolveWorkingDirectory(context.cwd, params.cwd);
      const entry = await runtime.registry.startTerminal(ownerOf(context), {
        command: shellCommand(runtime.shell(), params.command),
        displayCommand: params.command,
        cwd,
        viewport: runtime.viewport(),
        notify: params.notify ?? true,
      });
      // Launching, including a cold driver start, does not count toward the quiet period.
      const startedAt = Date.now();
      // The Terminal is running and nothing else knows its id yet, so the call never queues; an
      // abort ends the wait but must still return the id, or the agent could not reach the Terminal.
      return driveTerminal(runtime.registry, entry, undefined, async () => {
        const { snapshot, reason } = await settleTerminal(entry, {
          mode: "start",
          waitMs: clampWait(params.wait_ms, START_WAIT_MS),
          startedAt,
          matches: undefined,
          baseline: undefined,
          signal,
        });
        return terminalResult(runtime.registry, entry, snapshot, reason);
      });
    },
  });
}

function inputToExited(id: string, exit: TerminalExit | null): Error {
  return new Error(
    `${id} ${describeExit(exit)} and accepts no input. Poll it with terminal_send for its final screen, or remove it with terminal_stop.`,
  );
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
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
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
      return driveTerminal(runtime.registry, entry, signal, async () => {
        if (entry.state === "exited") {
          if (!hasInput) return terminalResult(runtime.registry, entry, undefined, "exited");
          // The error tells the agent about the exit, so a deferred Exit notification is redundant.
          runtime.registry.markSeen(entry.id);
          throw inputToExited(entry.id, entry.exit);
        }
        const matches =
          params.wait_for_text === undefined ? undefined : parseWaitPattern(params.wait_for_text);
        const before =
          hasInput || matches !== undefined ? await entry.handle.snapshot() : undefined;
        if (hasInput && before?.state === "exited") {
          // The exit watcher has not noticed this exit yet.
          const exit = before.exit ?? { code: null, signal: null };
          runtime.registry.terminalExited(entry.id, exit, before.screen, true);
          throw inputToExited(entry.id, exit);
        }
        const baseline = matches === undefined ? undefined : before?.screen;
        const startedAt = Date.now();
        if (params.text !== undefined && params.text !== "") await entry.handle.type(params.text);
        const validKeys = keys.filter(isKey);
        if (validKeys.length > 0) await entry.handle.press(validKeys);
        const { snapshot, reason } = await settleTerminal(entry, {
          mode: hasInput ? "input" : "poll",
          waitMs: clampWait(params.wait_ms, hasInput ? INPUT_WAIT_MS : POLL_WAIT_MS),
          startedAt,
          matches,
          baseline,
          signal,
        });
        return terminalResult(
          runtime.registry,
          entry,
          snapshot,
          reason,
          unmatchedNote(reason, params.wait_for_text),
        );
      });
    },
  });
}

/** Capture the lines a Terminal scrolled off since the agent's last result, before it is stopped. */
async function finalScrolledOff(entry: TerminalEntry): Promise<ScrolledOff> {
  try {
    if (entry.state === "exited") return await takeScrolledOff(entry, entry.finalScreen ?? "");
    return await takeScrolledOff(entry, (await entry.handle.snapshot()).screen);
  } catch {
    return NOTHING_SCROLLED;
  }
}

/** What a stop saw of a Terminal at its turn, before stopping it. */
interface StopView {
  readonly wasRunning: boolean;
  readonly previousScreen: string | undefined;
  readonly scrolled: ScrolledOff;
  readonly entry: TermctrlEntry;
}

/**
 * Stop a Terminal in its turn: the calls ahead have finished, so `wasRunning` and the previous
 * screen are what they left, and calls queued behind find the Terminal gone.
 */
function stopTerminalInTurn(
  registry: TermctrlRegistry,
  known: TerminalEntry,
  signal: AbortSignal | undefined,
): Promise<StopView> {
  return driveTerminal(registry, known, signal, async () => {
    const wasRunning = known.state === "running";
    const previousScreen = known.lastScreen;
    const scrolled = await finalScrolledOff(known);
    const entry = (await registry.stop(known.owner, known.id)) ?? known;
    return { wasRunning, previousScreen, scrolled, entry };
  });
}

/** `terminal_stop`: stop a Terminal or Background job and forget it. */
export function createTerminalStopTool(registry: TermctrlRegistry) {
  return defineTool<typeof StopParameters, StopResult>({
    name: "terminal_stop",
    label: "terminal_stop",
    description:
      "Stop a Terminal (t1) or Background job (b1) and forget it. Running processes are killed; exited ones are removed. Returns a Terminal's final screen (omitted when unchanged since your previous result) and scrolled-off lines, or a Background job's recent output.",
    promptSnippet: "Stop a Terminal or Background job",
    parameters: StopParameters,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: StopResultSchema,
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const owner = ownerOf(context);
      const known = registry.find(owner, params.id);
      if (known === undefined) throw unknownId(params.id);
      const { wasRunning, previousScreen, scrolled, entry } =
        known.kind === "terminal"
          ? await stopTerminalInTurn(registry, known, signal)
          : {
              wasRunning: known.state === "running",
              previousScreen: undefined,
              scrolled: NOTHING_SCROLLED,
              entry: (await registry.stop(owner, params.id)) ?? known,
            };
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
        const changed = previousScreen !== screen;
        // A screen the agent already saw is not repeated, whether the Terminal was running or exited.
        const repeated = !changed;
        const output = await fitOutput(registry, entry, repeated ? "" : screen, scrolled);
        result.changed = changed;
        if (!repeated) result.screen = output.screen;
        if (!repeated || output.scrolledOff !== "") result.scrolled_off = output.scrolledOff;
        if (output.gap) result.output_missing = true;
        if (output.fullOutputPath !== undefined) result.full_output_path = output.fullOutputPath;
        if (output.scrolledOff !== "") parts.push(`--- scrolled off ---\n${output.scrolledOff}`);
        if (repeated) parts.push("Its screen is unchanged since your last result.");
        else
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

/** Session-scoped values `terminal_wait` reads at call time. */
export interface TerminalWaitRuntime {
  readonly registry: TermctrlRegistry;
  readonly exitTailLines: () => number;
}

/** The entries one `terminal_wait` call watches: the listed ids, or every running entry. */
function waitTargets(
  registry: TermctrlRegistry,
  owner: string,
  ids: readonly string[] | undefined,
): TermctrlEntry[] {
  if (ids === undefined) {
    // An exit whose Exit notification is still queued has not reached the agent yet.
    return registry.ownedEntries(owner).filter((entry) => entry.state === "running" || !entry.seen);
  }
  const targets = new Map<string, TermctrlEntry>();
  for (const id of ids) {
    const entry = registry.find(owner, id);
    if (entry === undefined) throw unknownId(id);
    targets.set(id, entry);
  }
  return [...targets.values()];
}

/** Wait until a target exits, the wait runs out, the call is aborted, or a message is queued. */
function awaitExit(
  registry: TermctrlRegistry,
  targets: readonly TermctrlEntry[],
  waitMs: number,
  signal: AbortSignal | undefined,
  hasPendingMessages: () => boolean,
): Promise<WaitReason> {
  const deadline = Date.now() + waitMs;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const check = () => {
      let reason: WaitReason | undefined;
      if (targets.some((entry) => entry.state === "exited")) reason = "exited";
      else if (signal?.aborted === true) reason = "aborted";
      else if (hasPendingMessages()) reason = "message";
      else if (Date.now() >= deadline) reason = "timeout";
      if (reason === undefined) {
        clearTimeout(timer);
        timer = setTimeout(check, Math.max(0, Math.min(PENDING_CHECK_MS, deadline - Date.now())));
        return;
      }
      clearTimeout(timer);
      unsubscribe?.();
      signal?.removeEventListener("abort", check);
      resolve(reason);
    };
    unsubscribe = registry.onChange(check);
    signal?.addEventListener("abort", check, { once: true });
    check();
  });
}

const WAIT_REASON_TEXT = {
  timeout: (waitMs) => `Nothing exited within ${Math.round(waitMs / 1000)}s.`,
  message: () => "Returned early: a message is waiting for you.",
  aborted: () => "Wait cancelled.",
  nothing_running: () => "Nothing to wait for: you have no running Terminals or Background jobs.",
} satisfies Record<Exclude<WaitReason, "exited">, (waitMs: number) => string>;

/** `terminal_wait`: block until a Terminal or Background job exits. */
export function createTerminalWaitTool(runtime: TerminalWaitRuntime) {
  const { registry } = runtime;
  return defineTool<typeof WaitParameters, WaitResult>({
    name: "terminal_wait",
    label: "terminal_wait",
    description:
      "Wait until one of your Terminals or Background jobs exits, then return every exit so far and what is still running. Returns early when wait_ms (default 300000) runs out or a message is queued for you. Exits it returns send no Exit notification.",
    promptSnippet: "Wait for a Terminal or Background job to exit",
    promptGuidelines: [
      "Do not poll a Background job's log or a Terminal in a loop to learn when it finishes: keep working and rely on its Exit notification, or call terminal_wait when nothing else can proceed.",
    ],
    parameters: WaitParameters,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: WaitResultSchema,
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const owner = ownerOf(context);
      const targets = waitTargets(registry, owner, params.ids);
      const waitMs = clampWait(params.wait_ms, MAX_WAIT_MS);
      let reason: WaitReason = "nothing_running";
      const result: WaitResult = { reason, exited: [], running: [] };
      const parts: string[] = [];
      if (targets.length > 0) {
        const release = registry.watch(targets);
        try {
          reason = await awaitExit(registry, targets, waitMs, signal, () =>
            context.hasPendingMessages(),
          );
          const tailLines = runtime.exitTailLines();
          for (const entry of targets) {
            const notice = registry.noticeFor(entry);
            if (notice === undefined) continue;
            registry.markSeen(entry.id);
            parts.push(formatExitNotice(notice, tailLines));
            const exited: WaitResult["exited"][number] = {
              id: notice.id,
              kind: notice.kind === "job" ? "background_job" : "terminal",
              command: notice.command,
              ...exitFields(notice.exit),
              duration_ms: notice.durationMs,
              output: lastLines(notice.output, tailLines),
            };
            if (notice.logPath !== undefined) exited.log_path = notice.logPath;
            result.exited.push(exited);
          }
        } finally {
          release();
        }
      }
      result.reason = reason;
      if (reason !== "exited") parts.unshift(WAIT_REASON_TEXT[reason](waitMs));
      const now = Date.now();
      const running = registry.ownedEntries(owner).filter((entry) => entry.state === "running");
      result.running = running.map((entry) => ({
        id: entry.id,
        kind: entry.kind === "job" ? "background_job" : "terminal",
        command: entry.command,
        age_seconds: Math.round((now - entry.startedAt) / 1000),
      }));
      if (running.length > 0) {
        parts.push(`Still running:\n${running.map((entry) => listLine(entry, now)).join("\n")}`);
      }
      return {
        content: [{ type: "text" as const, text: parts.join("\n\n") }],
        details: result,
        structuredContent: result,
      };
    },
  });
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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
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
