import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, openSync, writeFileSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  formatSize,
  truncateTail,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type BashOperations,
  type BashToolDetails,
  type BashToolOptions,
  type ExtensionToolContext,
  type ExtensionUIContext,
  type TruncationOptions,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { KILLED_EXIT, TermctrlRegistry } from "./termctrl-registry.js";
import type { OutputLimits } from "./pi-termctrl-settings.js";
import { termctrlTemporaryDirectory } from "./termctrl-driver.js";
import type { TerminalExit } from "./terminal-driver.js";

/** How long `background: true` waits before moving a still-running command to the background. */
export const BACKGROUND_YIELD_MS = 2_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
/** Output kept in memory before backgrounding; older output is dropped from the log's head. */
const BUFFER_LIMIT_BYTES = 16 * 1024 * 1024;
/** Recent output kept for previews and Exit notifications. */
const TAIL_LIMIT_CHARS = 64 * 1024;

type ExecOptions = Parameters<BashOperations["exec"]>[2];

function countNewlines(data: Buffer): number {
  let count = 0;
  for (let at = data.indexOf(10); at !== -1; at = data.indexOf(10, at + 1)) count++;
  return count;
}

/** Path of a Background job's log. The pid keeps concurrent Pi processes apart. */
export function backgroundLogPath(id: string): string {
  return join(termctrlTemporaryDirectory(), `${process.pid}-${id}.log`);
}

/** What a backgrounded call reports to the agent. */
interface BackgroundOutcome {
  readonly id: string;
  readonly logPath: string;
  readonly output: string;
  /** What the in-memory buffer dropped from the head of `output`. */
  readonly dropped: DroppedOutput;
}

/** Output that left the in-memory buffer, which a tail's totals still have to count. */
interface DroppedOutput {
  readonly lines: number;
  readonly bytes: number;
}

/**
 * One agent `bash` call. Wraps Pi's local `exec` so the call can leave the tool call: it owns the
 * abort controller and the timeout, and tees output into a buffer and, after backgrounding, a log.
 */
class BashCall {
  private readonly controller = new AbortController();
  private readonly chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private droppedBytes = 0;
  private droppedNewlines = 0;
  private recent = "";
  private readonly decoder = new TextDecoder();
  private log: WriteStream | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timedOut = false;
  private started = false;
  private startedAt = Date.now();
  private settled = false;
  private jobId: string | undefined;
  private forwardData: ((data: Buffer) => void) | undefined;
  private resolveBackground!: (outcome: BackgroundOutcome) => void;
  readonly backgrounded: Promise<BackgroundOutcome>;
  private isBackgrounded = false;

  constructor(
    private readonly owner: string,
    private readonly command: string,
    private readonly local: BashOperations,
  ) {
    this.backgrounded = new Promise((resolve) => {
      this.resolveBackground = resolve;
    });
  }

  /** Everything the foreground call printed that is still buffered, for the model-visible tail. */
  foregroundOutput() {
    if (this.isBackgrounded) return undefined;
    const raw = Buffer.concat(this.chunks);
    return { text: new TextDecoder().decode(raw), raw, dropped: this.dropped() };
  }

  private dropped(): DroppedOutput {
    return { lines: this.droppedNewlines, bytes: this.droppedBytes };
  }

  /** The `BashOperations.exec` Pi's `execute` calls. */
  async exec(
    command: string,
    cwd: string,
    options: ExecOptions,
  ): Promise<{ exitCode: number | null }> {
    const { timeout, signal, onData, env } = options;
    if (timeout !== undefined) {
      if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new Error("Invalid timeout: must be a finite number of seconds");
      }
      if (timeout * 1000 > MAX_TIMEOUT_MS) {
        throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
      }
    }
    if (signal?.aborted) throw new Error("aborted");
    this.forwardData = onData;
    const forwardAbort = () => {
      if (!this.isBackgrounded) this.controller.abort();
    };
    signal?.addEventListener("abort", forwardAbort, { once: true });
    if (timeout !== undefined) {
      this.timer = setTimeout(() => {
        this.timedOut = true;
        this.controller.abort();
      }, timeout * 1000);
    }
    this.started = true;
    this.startedAt = Date.now();
    try {
      const localOptions: ExecOptions = {
        onData: (data) => this.receive(data),
        signal: this.controller.signal,
      };
      if (env !== undefined) localOptions.env = env;
      const result = await this.local.exec(command, cwd, localOptions);
      this.finish({ code: result.exitCode, signal: null });
      return result;
    } catch (error) {
      this.finish(this.controller.signal.aborted ? KILLED_EXIT : { code: null, signal: null });
      if (this.timedOut && !this.isBackgrounded)
        throw new Error(`timeout:${timeout}`, { cause: error });
      throw error;
    } finally {
      this.settled = true;
      clearTimeout(this.timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  private receive(data: Buffer): void {
    if (this.isBackgrounded) {
      this.log?.write(data);
      this.remember(this.decoder.decode(data, { stream: true }));
      return;
    }
    this.chunks.push(data);
    this.bufferedBytes += data.length;
    while (this.bufferedBytes > BUFFER_LIMIT_BYTES && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.bufferedBytes -= dropped?.length ?? 0;
      this.droppedBytes += dropped?.length ?? 0;
      if (dropped !== undefined) this.droppedNewlines += countNewlines(dropped);
    }
    this.forwardData?.(data);
  }

  private remember(text: string): void {
    this.recent = (this.recent + text).slice(-TAIL_LIMIT_CHARS);
  }

  private finish(exit: TerminalExit): void {
    if (this.jobId === undefined) return;
    this.remember(this.decoder.decode());
    const log = this.log;
    this.log = undefined;
    log?.end();
    TermctrlRegistry.current()?.jobExited(this.jobId, exit);
  }

  /** Move the running command to the background. Returns false when it already finished. */
  background(registry: TermctrlRegistry): boolean {
    if (this.isBackgrounded || this.settled || !this.started) return false;
    // An aborted or timed-out command is already dying; let Pi report it.
    if (this.controller.signal.aborted) return false;
    const entry = registry.createJob(
      this.owner,
      this.command,
      (id) => {
        const logPath = backgroundLogPath(id);
        mkdirSync(termctrlTemporaryDirectory(), { recursive: true });
        this.log = createWriteStream(logPath, { fd: openSync(logPath, "w") });
        this.log.on("error", () => {});
        return {
          logPath,
          stop: () => this.controller.abort(),
          tail: () => this.recent,
          removeLog: async () => {
            this.log?.end();
            await rm(logPath, { force: true });
          },
        };
      },
      this.startedAt,
    );
    this.jobId = entry.id;
    this.isBackgrounded = true;
    clearTimeout(this.timer);
    if (this.droppedBytes > 0) {
      this.log?.write(
        `[pi-termctrl: ${formatSize(this.droppedBytes)} of earlier output omitted]\n`,
      );
    }
    for (const chunk of this.chunks) this.log?.write(chunk);
    const output = this.decoder.decode(Buffer.concat(this.chunks), { stream: true });
    this.chunks.length = 0;
    this.remember(output);
    this.resolveBackground({
      id: entry.id,
      logPath: entry.child.logPath,
      output,
      dropped: this.dropped(),
    });
    return true;
  }
}

/** The agent `bash` calls running in one session, and the Ctrl+B subscription while any run. */
export class RunningBashCalls {
  private readonly calls = new Set<BashCall>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly registry: () => TermctrlRegistry) {}

  /** Track a call; the first one subscribes to Ctrl+B. */
  add(call: BashCall, ui: ExtensionUIContext): void {
    this.calls.add(call);
    if (this.unsubscribe !== undefined) return;
    this.unsubscribe = ui.onTerminalInput((data) => {
      if (!matchesKey(data, "ctrl+b")) return undefined;
      this.backgroundAll(ui);
      return { consume: true };
    });
  }

  /** Stop tracking a call; the last one releases Ctrl+B back to the editor. */
  delete(call: BashCall): void {
    this.calls.delete(call);
    if (this.calls.size > 0) return;
    this.dispose();
  }

  /** Move every running call to the background. */
  backgroundAll(ui: Pick<ExtensionUIContext, "notify">): void {
    for (const call of this.calls) {
      try {
        call.background(this.registry());
      } catch (error) {
        ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

/** Settings the replacement shares with Pi's built-in `bash`. */
export interface BashReplacementOptions {
  readonly cwd: string;
  readonly commandPrefix: string | undefined;
  readonly shellPath: string | undefined;
  readonly registry: () => TermctrlRegistry;
  readonly calls: RunningBashCalls;
  /**
   * Limits on the model-visible tail of a result and of "output so far"; undefined keeps Pi's own
   * limits. Pi's `bash` accepts no limits, so the replacement tightens what Pi returns.
   */
  readonly bashTail?: OutputLimits | undefined;
  /** Builds Pi's `bash` definition; tests wrap it to observe what reaches Pi's accumulator. */
  readonly definitionFactory?: typeof createBashToolDefinition;
}

/** Pi's `bash` declares an object `outputSchema` since 0.99.0; extend it with the background fields. */
function backgroundOutputSchema(builtin: TSchema | undefined) {
  if (builtin === undefined || !Type.IsObject(builtin))
    throw new Error("Pi's bash tool does not declare an object outputSchema");
  return Type.Object({
    ...builtin.properties,
    exit_code: Type.Optional(
      Type.Number({ description: "Absent only when the command was moved to the background" }),
    ),
    background: Type.Optional(
      Type.Object(
        {
          id: Type.String({ description: "Background job id, for terminal_stop" }),
          log_path: Type.String({ description: "File receiving the job's output; read it" }),
        },
        { description: "Present when the command was moved to the background" },
      ),
    ),
  });
}

/** The notice after a cut tail, naming the limits that cut it and where every line is. */
function tailNotice(truncation: TruncationResult, fullOutput: string, logPath: string): string {
  const lastLine = truncation.totalLines;
  if (truncation.lastLinePartial) {
    const lineBytes = Buffer.byteLength(fullOutput.slice(fullOutput.lastIndexOf("\n") + 1));
    return `[Showing last ${formatSize(truncation.outputBytes)} of line ${lastLine} (line is ${formatSize(lineBytes)}). Full output: ${logPath}]`;
  }
  const first = truncation.totalLines - truncation.outputLines + 1;
  return `[Showing lines ${first}-${lastLine} of ${truncation.totalLines} (${formatSize(truncation.maxBytes)} or ${truncation.maxLines} line limit). Full output: ${logPath}]`;
}

/** The status Pi appends after the output on a failure, abort, or timeout. */
const PI_STATUS =
  /\n\n(Command exited with code -?\d+|Command aborted|Command timed out after [^\n]+|Command terminated without an exit code)$/u;
/** Pi's cut notice, as the last thing before its status. */
const PI_NOTICE_AT_END = /\[Showing [^\n]*Full output: ([^\]\n]+)\]$/u;

/**
 * Where Pi saved the full output of a call whose output Pi itself cut. A command can print text
 * that looks like Pi's notice, so this is consulted only when Pi's own limits were exceeded, and a
 * rejection's text is read only at the notice Pi puts directly before its status.
 */
function piFullOutputPath(text: string, details: BashToolDetails | undefined): string | undefined {
  if (details?.fullOutputPath !== undefined) return details.fullOutputPath;
  const status = PI_STATUS.exec(text);
  if (status === null) return undefined;
  return PI_NOTICE_AT_END.exec(text.slice(0, status.index))?.[1];
}

/** Save the whole output beside Pi's own `pi-bash-*.log` files. */
function saveFullOutput(raw: Buffer): string | undefined {
  const path = join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
  try {
    writeFileSync(path, raw, { mode: 0o600, flag: "wx" });
    return path;
  } catch {
    return undefined;
  }
}

/** `truncateTail` over a buffer that dropped its head: the totals count the dropped output too. */
function truncateBuffered(
  output: string,
  dropped: DroppedOutput,
  limits: TruncationOptions,
): TruncationResult {
  const truncation = truncateTail(output, limits);
  if (dropped.bytes === 0) return truncation;
  return {
    ...truncation,
    truncated: true,
    truncatedBy: truncation.truncatedBy ?? "bytes",
    totalLines: truncation.totalLines + dropped.lines,
    totalBytes: truncation.totalBytes + dropped.bytes,
  };
}

/**
 * Cut a foreground result's text to `limits`. Returns undefined when the output already fits, which
 * leaves Pi's text as it is: Pi's limits are never tighter than `limits`.
 */
function limitForegroundText(
  call: BashCall,
  piText: string,
  piDetails: BashToolDetails | undefined,
  limits: OutputLimits,
  hasStatus: boolean,
) {
  const output = call.foregroundOutput();
  if (output === undefined) return undefined;
  const truncation = truncateBuffered(output.text, output.dropped, {
    maxLines: limits.maxLines,
    maxBytes: limits.maxBytes,
  });
  if (!truncation.truncated) return undefined;
  const piCut = truncateBuffered(output.text, output.dropped, {}).truncated;
  const logPath =
    (piCut ? piFullOutputPath(piText, piDetails) : undefined) ?? saveFullOutput(output.raw);
  const notice = tailNotice(truncation, output.text, logPath ?? "(could not be saved)");
  // Pi appends a status only to a failure; a successful command's output may merely look like one.
  const status = hasStatus ? PI_STATUS.exec(piText) : null;
  const suffix = status === null ? "" : `\n\n${status[1] ?? ""}`;
  return {
    text: `${truncation.content}\n\n${notice}${suffix}`,
    details: logPath === undefined ? { truncation } : { truncation, fullOutputPath: logPath },
  };
}

function backgroundResult(
  outcome: BackgroundOutcome,
  startedAt: number,
  limits: OutputLimits | undefined,
) {
  const truncation = truncateBuffered(outcome.output, outcome.dropped, limits ?? {});
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n${tailNotice(truncation, outcome.output, outcome.logPath)}`;
  }
  // Scripts get the same contract as a finished call's structured result: Pi's limits, not the tail.
  const structured = truncateBuffered(outcome.output, outcome.dropped, {});
  const status = `Command moved to the background as ${outcome.id}. Its output so far and all later output go to ${outcome.logPath}. You will get an Exit notification when it ends, so do not poll the log in a loop; to block until it ends, call terminal_wait. Stop it with terminal_stop {"id": "${outcome.id}"}.`;
  return {
    content: [{ type: "text" as const, text: text === "" ? status : `${text}\n\n${status}` }],
    details: undefined,
    structuredContent: {
      output: structured.content,
      truncated: structured.truncated,
      wall_time_seconds: Math.round((performance.now() - startedAt) / 100) / 10,
      background: { id: outcome.id, log_path: outcome.logPath },
    },
  };
}

type BashResult = Awaited<ReturnType<ReturnType<typeof createBashToolDefinition>["execute"]>>;

function limitResult(call: BashCall, result: BashResult, limits: OutputLimits): BashResult {
  const [first] = result.content;
  if (first?.type !== "text") return result;
  const limited = limitForegroundText(
    call,
    first.text,
    result.details,
    limits,
    result.isError === true,
  );
  if (limited === undefined) return result;
  return {
    ...result,
    content: [{ type: "text", text: limited.text }],
    details: limited.details,
  };
}

function limitError(call: BashCall, error: Error, limits: OutputLimits): Error {
  // Only Pi's output-plus-status messages are rewritten; any other error passes through.
  if (!PI_STATUS.test(error.message)) return error;
  const limited = limitForegroundText(call, error.message, undefined, limits, true);
  return limited === undefined ? error : new Error(limited.text, { cause: error });
}

/** Pi's description names its own limits; name the ones in force instead. */
function describeTail(description: string, limits: OutputLimits | undefined): string {
  if (limits === undefined) return description;
  const piLimits = `${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB`;
  const ours = `${limits.maxLines} lines or ${formatSize(limits.maxBytes)}`;
  // If Pi rewords its description, still tell the model the limits in force.
  if (!description.includes(piLimits)) return `${description} Output is truncated to last ${ours}.`;
  return description.replace(piLimits, ours);
}

/** Pi's `bash` definition plus `background`, executed through Pi's own pipes. */
export function createBashReplacement(options: BashReplacementOptions) {
  const builtinOptions: BashToolOptions = {};
  if (options.commandPrefix !== undefined) builtinOptions.commandPrefix = options.commandPrefix;
  if (options.shellPath !== undefined) builtinOptions.shellPath = options.shellPath;
  const builtin = createBashToolDefinition(options.cwd, builtinOptions);
  const local = createLocalBashOperations(
    options.shellPath === undefined ? undefined : { shellPath: options.shellPath },
  );
  const parameters = Type.Object({
    ...builtin.parameters.properties,
    background: Type.Optional(
      Type.Boolean({
        description:
          "Run in the background if still running after 2 seconds; returns a Background job id and log path",
      }),
    ),
  });
  return {
    ...builtin,
    description: describeTail(builtin.description, options.bashTail),
    parameters,
    outputSchema: backgroundOutputSchema(builtin.outputSchema),
    async execute(
      toolCallId: string,
      params: { command: string; timeout?: number; background?: boolean },
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof builtin.execute>[3],
      context: ExtensionToolContext,
    ) {
      const registry = options.registry();
      const owner = context.sessionManager.getSessionId();
      if (params.background === true) registry.checkCapacity(owner);
      const call = new BashCall(owner, params.command, local);
      const inner = (options.definitionFactory ?? createBashToolDefinition)(options.cwd, {
        ...builtinOptions,
        operations: { exec: (command, cwd, execOptions) => call.exec(command, cwd, execOptions) },
      });
      let backgrounded = false;
      const forwardUpdate: typeof onUpdate =
        onUpdate === undefined
          ? undefined
          : (update) => {
              if (!backgrounded) onUpdate(update);
            };
      const startedAt = performance.now();
      const limits = options.bashTail;
      const piRunning = inner.execute(
        toolCallId,
        params.timeout === undefined
          ? { command: params.command }
          : { command: params.command, timeout: params.timeout },
        signal,
        forwardUpdate,
        context,
      );
      const running =
        limits === undefined
          ? piRunning
          : piRunning.then(
              (result) => limitResult(call, result, limits),
              (error: Error) => {
                // Pi's `bash` rejects only with Errors; anything else passes through unchanged.
                if (!(error instanceof Error)) throw error;
                throw limitError(call, error, limits);
              },
            );
      running.catch(() => {});
      options.calls.add(call, context.ui);
      const yieldTimer =
        params.background === true
          ? setTimeout(() => {
              try {
                call.background(registry);
              } catch {
                // The cap filled during the yield window; the command stays in the foreground.
              }
            }, BACKGROUND_YIELD_MS)
          : undefined;
      try {
        const winner = await Promise.race([
          running.then((result) => ({ kind: "finished" as const, result })),
          call.backgrounded.then((outcome) => ({ kind: "background" as const, outcome })),
        ]);
        if (winner.kind === "finished") return winner.result;
        backgrounded = true;
        return backgroundResult(winner.outcome, startedAt, options.bashTail);
      } finally {
        clearTimeout(yieldTimer);
        options.calls.delete(call);
      }
    },
  };
}
