import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DebugProtocol } from "@vscode/debugprotocol";
import { type Static, Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  DapProtocolClient,
  DapProtocolClientError,
  resolvedAdapterEnvironment,
  signalOwnedProcessGroup,
  type DapProtocolRequestOptions,
  type DapProtocolTransport,
  type DapReverseRequestResult,
} from "./dap-protocol-client.js";
import { RetainedDapOutput, type DapSessionFiles } from "./dap-session-files.js";
import type {
  DapAdapterDefinition,
  DapLaunchProfile,
  ResolvedDapSettings,
} from "./pi-dap-settings.js";

const DapAdapterProtocolIdSchema = Type.String({ minLength: 1 });
const DapCapabilitiesSchema = Type.Object(
  {
    supportsConfigurationDoneRequest: Type.Optional(Type.Boolean()),
    supportsTerminateRequest: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);
const DapOutputEventBodySchema = Type.Object(
  { output: Type.String(), category: Type.Optional(Type.String()) },
  { additionalProperties: true },
);
const DapStoppedEventBodySchema = Type.Object(
  {
    reason: Type.String(),
    description: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.Integer()),
    hitBreakpointIds: Type.Optional(Type.Array(Type.Integer())),
  },
  { additionalProperties: true },
);
const DapContinuedEventBodySchema = Type.Object(
  { threadId: Type.Optional(Type.Integer()) },
  { additionalProperties: true },
);
const DapExitedEventBodySchema = Type.Object(
  { exitCode: Type.Integer() },
  { additionalProperties: true },
);
const DapSourceSchema = Type.Object(
  {
    name: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
const DapBreakpointSchema = Type.Object(
  {
    id: Type.Optional(Type.Integer()),
    verified: Type.Boolean(),
    message: Type.Optional(Type.String()),
    line: Type.Optional(Type.Integer()),
    column: Type.Optional(Type.Integer()),
    source: Type.Optional(DapSourceSchema),
  },
  { additionalProperties: true },
);
const DapSetBreakpointsBodySchema = Type.Object(
  { breakpoints: Type.Array(DapBreakpointSchema) },
  { additionalProperties: true },
);
const DapThreadSchema = Type.Object(
  { id: Type.Integer(), name: Type.String() },
  { additionalProperties: true },
);
const DapThreadsBodySchema = Type.Object(
  { threads: Type.Array(DapThreadSchema) },
  { additionalProperties: true },
);
const DapStackFrameSchema = Type.Object(
  {
    id: Type.Integer(),
    name: Type.String(),
    line: Type.Integer(),
    column: Type.Integer(),
    source: Type.Optional(DapSourceSchema),
  },
  { additionalProperties: true },
);
const DapStackTraceBodySchema = Type.Object(
  {
    stackFrames: Type.Array(DapStackFrameSchema),
    totalFrames: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: true },
);
const DapScopeSchema = Type.Object(
  {
    name: Type.String(),
    variablesReference: Type.Integer({ minimum: 0 }),
    expensive: Type.Boolean(),
    namedVariables: Type.Optional(Type.Integer({ minimum: 0 })),
    indexedVariables: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: true },
);
const DapScopesBodySchema = Type.Object(
  { scopes: Type.Array(DapScopeSchema) },
  { additionalProperties: true },
);
const DapVariableSchema = Type.Object(
  {
    name: Type.String(),
    value: Type.String(),
    variablesReference: Type.Integer({ minimum: 0 }),
    type: Type.Optional(Type.String()),
    evaluateName: Type.Optional(Type.String()),
    namedVariables: Type.Optional(Type.Integer({ minimum: 0 })),
    indexedVariables: Type.Optional(Type.Integer({ minimum: 0 })),
    memoryReference: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
const DapVariablesBodySchema = Type.Object(
  { variables: Type.Array(DapVariableSchema) },
  { additionalProperties: true },
);
const DapEvaluateBodySchema = Type.Object(
  {
    result: Type.String(),
    variablesReference: Type.Integer({ minimum: 0 }),
    type: Type.Optional(Type.String()),
    namedVariables: Type.Optional(Type.Integer({ minimum: 0 })),
    indexedVariables: Type.Optional(Type.Integer({ minimum: 0 })),
    memoryReference: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
const RunInTerminalArgumentsSchema = Type.Object(
  {
    args: Type.Array(Type.String(), { minItems: 1 }),
    cwd: Type.String({ minLength: 1 }),
    env: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
    argsCanBeInterpretedByShell: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);
const JsDebugPrimaryTargetArgumentsSchema = Type.Object(
  {
    request: Type.Literal("launch"),
    configuration: Type.Object(
      {
        type: Type.Literal("pwa-node"),
        __pendingTargetId: Type.String({ minLength: 1 }),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

/** What a `startDebugging` request names about the child session it asks Pi DAP to debug. */
const StartDebuggingChildArgumentsSchema = Type.Object(
  {
    configuration: Type.Optional(
      Type.Object(
        {
          type: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          __pendingTargetId: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: true },
      ),
    ),
    request: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/** Classified configuration, state, protocol, or Debug Adapter failure. */
export class DapSessionError extends Error {
  /** Construct a stable Debug Session failure for the Pi tool boundary. */
  constructor(
    readonly kind: "adapter" | "configuration" | "protocol" | "state",
    message: string,
    options?: ErrorOptions,
  ) {
    super(`DAP Session: ${message}`, options);
  }
}

/** Optional Launch Profile overrides supplied by one launch operation. */
export interface DapLaunchInput {
  readonly profile?: string;
  readonly program?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Launch arguments merged over the Launch Profile's `arguments`; `program`, `args`, and `cwd` still win. */
  readonly launchArguments?: DapLaunchProfile["arguments"];
}

/**
 * A child session the adapter asked Pi DAP to debug, such as a worker thread or child process of
 * the Debuggee, that Pi DAP could not debug, so breakpoints in the child never bind.
 */
export interface DapRejectedChildSession {
  readonly type?: string;
  readonly name?: string;
  /** The adapter's id for the child session's pending debug target. */
  readonly targetId?: string;
  /** Actionable, model-readable explanation naming the child session. */
  readonly message: string;
}

/** One desired source Breakpoint, with one-based line numbering. */
export interface DapDesiredBreakpoint {
  readonly line: number;
  readonly condition?: string;
}

/** Complete replacement of Desired Breakpoints for one source file. */
export interface DapSetBreakpointsInput {
  readonly filePath: string;
  readonly breakpoints: readonly DapDesiredBreakpoint[];
}

/** Paged Stack Frame request, defaulting to the stopped thread. */
export interface DapStackInput {
  readonly threadId?: number;
  readonly start?: number;
  readonly count?: number;
}

/** Paged variables request by Stack Frame or child variables reference. */
export type DapVariablesInput =
  | {
      readonly frameId: number;
      readonly variablesReference?: never;
      readonly start?: number;
      readonly count?: number;
    }
  | {
      readonly frameId?: never;
      readonly variablesReference: number;
      readonly start?: number;
      readonly count?: number;
    };

/** Expression evaluation request, defaulting to the top Stack Frame. */
export interface DapEvaluateInput {
  readonly expression: string;
  readonly frameId?: number;
}

/** Public exhaustive Debug Session lifecycle snapshot. */
export type DapSessionSnapshot =
  | { readonly state: "idle" }
  | {
      readonly state: "launching" | "running";
      readonly adapterId: string;
      readonly profileId: string;
    }
  | {
      readonly state: "stopped";
      readonly adapterId: string;
      readonly profileId: string;
      readonly stopReason: string;
      readonly threadId?: number;
    }
  | {
      readonly state: "terminated";
      readonly adapterId: string;
      readonly profileId: string;
      readonly exitCode?: number;
      readonly terminationReason?: string;
    };

/** Desired Breakpoints retained for one source file across launches. */
export interface DapDesiredBreakpointFile {
  readonly filePath: string;
  readonly breakpoints: readonly DapDesiredBreakpoint[];
}

/**
 * One Stack Frame scope. `variables` is absent for an expensive scope that was listed but not
 * expanded; request its `variablesReference` to expand it.
 */
export interface DapVariableGroup {
  readonly scope: DebugProtocol.Scope;
  readonly variables?: readonly DebugProtocol.Variable[];
}

/** Where and why the Debuggee stopped, taken from the stopped event and the top Stack Frame. */
export interface DapStopDetails {
  /** The adapter's human-readable explanation of the stop, when it sent one. */
  readonly description?: string;
  /** Adapter ids of the Breakpoints that caused the stop, when it reported any. */
  readonly hitBreakpointIds?: readonly number[];
  /** Top Stack Frame, present when the operation waited for a stop and the frame could be read. */
  readonly topFrame?: DebugProtocol.StackFrame;
  /** The adapter's name for the Child session that stopped; absent for a stop in the Debuggee itself. */
  readonly childSession?: string;
}

/** Successful Debug Session operation including unread Debuggee output. */
export interface DapSessionResult {
  readonly snapshot: DapSessionSnapshot;
  readonly stop?: DapStopDetails;
  readonly output: string;
  readonly discardedOutputBytes: number;
  readonly desiredBreakpoints: readonly DapDesiredBreakpointFile[];
  /** Child sessions Pi DAP could not debug since the last result that reported them; set only when there are some. */
  readonly rejectedChildSessions?: readonly DapRejectedChildSession[];
  readonly breakpoints?: readonly DebugProtocol.Breakpoint[];
  readonly stackFrames?: readonly DebugProtocol.StackFrame[];
  readonly totalFrames?: number;
  readonly variableGroups?: readonly DapVariableGroup[];
  readonly variables?: readonly DebugProtocol.Variable[];
  readonly evaluation?: DebugProtocol.EvaluateResponse["body"];
}

/** Construction values owned for one conversation-level Debug Session controller. */
export interface DapSessionOptions {
  readonly cwd: string;
  readonly settings: ResolvedDapSettings;
  readonly sessionFiles: DapSessionFiles;
  /** Observe lifecycle snapshots synchronously without gaining protocol authority. */
  readonly onSnapshotChange?: (snapshot: DapSessionSnapshot) => void;
  /** Observe an asynchronous adapter or protocol failure not caused by an operation request. */
  readonly onUnexpectedFailure?: (error: Error) => void;
}

/** A stop a debuggable target reported that no operation has resumed yet. */
interface DapTargetStop {
  /** Orders waiting stops, so they are reported in the order they arrived. */
  readonly arrival: number;
  readonly reason: string;
  readonly description: string | undefined;
  /** The target's own Breakpoint ids, translated to the reported ids when the stop is reported. */
  readonly hitBreakpointIds: readonly number[] | undefined;
}

/**
 * One channel Pi DAP debugs: the primary target (vscode-js-debug's primary target channel, or the
 * root channel of any other adapter) or a Child session's target channel.
 */
interface DapDebugTarget {
  readonly client: DapProtocolClient;
  /** The adapter's name for a Child session; absent for the primary target. */
  readonly childSessionName: string | undefined;
  /**
   * Adapter thread id to Pi thread id. Each vscode-js-debug target numbers its own threads, so Pi
   * assigns ids that cannot collide; absent where Pi reports the adapter's thread ids unchanged.
   */
  readonly piThreadIds: Map<number, number> | undefined;
  /** The target's Breakpoint ids, each mapped to its Desired Breakpoint's key. */
  readonly breakpointKeys: Map<number, string>;
  /** Whether the target has initialized and accepts Breakpoints. */
  ready: boolean;
  /** Adapter thread id of the target's last stop or thread lookup. */
  threadId: number | undefined;
  /** Unresumed stop; queued while another target's stop is the one reported. */
  stop: DapTargetStop | undefined;
}

interface ActiveDapSession {
  readonly adapter: DapAdapterDefinition;
  readonly profile: DapLaunchProfile;
  /** Effective launch arguments: the Launch Profile's, merged with this launch's overrides. */
  readonly launchArguments: DapLaunchProfile["arguments"];
  readonly rootClient: DapProtocolClient;
  /** The root channel as a target; the primary target unless vscode-js-debug opens its own. */
  readonly rootTarget: DapDebugTarget;
  primary: DapDebugTarget;
  /** The target whose stop is reported and which inspection and stepping operations use. */
  focus: DapDebugTarget;
  /** Child sessions being debugged, from attach until they terminate or the session ends. */
  readonly children: Set<DapDebugTarget>;
  /** Pi thread id to its target and adapter thread id, for targets that map thread ids. */
  readonly threadOwners: Map<
    number,
    { readonly target: DapDebugTarget; readonly threadId: number }
  >;
  nextThreadId: number;
  /** Desired Breakpoint key to the id reported for it: the primary target's, else the first child's. */
  readonly reportedBreakpointIds: Map<string, number>;
  targetClient?: DapProtocolClient;
  targetChannelStarted: boolean;
  readonly debuggeeProcesses: Set<ChildProcessWithoutNullStreams>;
  readonly unsubscribeEvents: Set<() => void>;
  capabilities: Static<typeof DapCapabilitiesSchema>;
  phase: "launching" | "running" | "stopped";
  /** Top Stack Frame of the current stop, once an operation has read it. */
  topFrame: DebugProtocol.StackFrame | undefined;
  /** Counts stopped events, so a frame read for an earlier stop is never attached to a later one. */
  stopSequence: number;
  /** Counts stops any target reported, to order waiting stops. */
  stopArrivals: number;
  exitCode: number | undefined;
  /** Whether the primary target channel has reported `terminated`. */
  targetTerminated: boolean;
  /** Whether the root channel has reported `terminated`. */
  rootTerminated: boolean;
  /** Wakes waits for the other channel's `terminated`. */
  readonly settleTermination: Set<() => void>;
  cleanupPromise?: Promise<void>;
  stopping: boolean;
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

type InternalDapSessionState =
  | { readonly kind: "idle" }
  | { readonly kind: "active"; readonly active: ActiveDapSession }
  | {
      readonly kind: "terminated";
      readonly adapterId: string;
      readonly profileId: string;
      readonly exitCode?: number;
      readonly terminationReason?: string;
      readonly cleanupPromise: Promise<void>;
    };

interface ExecutionWait {
  readonly promise: Promise<"cancelled" | "timeout" | "transition">;
  cancel(): void;
}

type DapLaunchResponseOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly error: Error };

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the owning runtime parser for untrusted DAP response and event bodies.
function parseDapBody<T extends TSchema>(schema: T, value: unknown, operation: string): Static<T> {
  if (Value.Check(schema, value)) return value;
  const issue = Value.Errors(schema, value)[0];
  throw new DapSessionError(
    "protocol",
    `${operation} returned an invalid body${issue?.instancePath === undefined ? "" : ` at ${issue.instancePath || "/"}`}`,
  );
}

function protocolTransport(adapter: DapAdapterDefinition): DapProtocolTransport {
  return adapter.transport.type === "stdio" ? "stdio" : adapter.transport;
}

/** The child session as the adapter named it, for a model-readable message. */
function childSessionDescription(
  configuration: Static<typeof StartDebuggingChildArgumentsSchema>["configuration"],
): string {
  const parts = [
    configuration?.type,
    configuration?.name === undefined ? undefined : JSON.stringify(configuration.name),
    configuration?.__pendingTargetId === undefined
      ? undefined
      : `(target ${configuration.__pendingTargetId})`,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? "(unnamed)" : parts.join(" ");
}

function rejectedChildSession(
  message: string,
  configuration: Static<typeof StartDebuggingChildArgumentsSchema>["configuration"],
): DapRejectedChildSession {
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- SAFETY: Mutable removes only readonly for construction; optional fields are assigned before the value is shared.
  const rejected: Mutable<DapRejectedChildSession> = { message };
  if (configuration?.type !== undefined) rejected.type = configuration.type;
  if (configuration?.name !== undefined) rejected.name = configuration.name;
  if (configuration?.__pendingTargetId !== undefined) {
    rejected.targetId = configuration.__pendingTargetId;
  }
  return rejected;
}

/**
 * Whether vscode-js-debug reports a non-zero Debuggee exit as `Process exited with code N` on its
 * root channel. It does only when it owns the Debuggee's stdio: with a terminal `console`, which
 * Pi runs through `runInTerminal`, or `outputCapture: "std"`, it sends no such report, and the
 * Debuggee's own stderr arrives on the root channel where it could spoof one.
 */
function jsDebugReportsExitOnRoot(launchArguments: DapLaunchProfile["arguments"]): boolean {
  const { console: consoleKind, outputCapture } = launchArguments;
  return (
    (consoleKind === undefined || consoleKind === "internalConsole") && outputCapture !== "std"
  );
}

/** The exit code in vscode-js-debug's `Process exited with code N` stderr output, if that is it. */
function jsDebugExitCode(body: Static<typeof DapOutputEventBodySchema>): number | undefined {
  if (body.category !== "stderr") return undefined;
  const match = /^Process exited with code (\d+)\r?\n?$/u.exec(body.output);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** Pi DAP's `initialize` arguments; only the adapter id and two reverse-request flags vary. */
function initializeArguments(
  adapterID: string,
  supportsRunInTerminalRequest: boolean,
  supportsStartDebuggingRequest: boolean,
): DebugProtocol.InitializeRequestArguments {
  return {
    adapterID,
    clientID: "pi-dap",
    clientName: "Pi DAP",
    columnsStartAt1: true,
    linesStartAt1: true,
    locale: "en-US",
    pathFormat: "path",
    supportsRunInTerminalRequest,
    supportsStartDebuggingRequest,
  };
}

function debugTarget(
  client: DapProtocolClient,
  childSessionName: string | undefined,
  mapsThreadIds: boolean,
): DapDebugTarget {
  return {
    client,
    childSessionName,
    piThreadIds: mapsThreadIds ? new Map() : undefined,
    breakpointKeys: new Map(),
    ready: false,
    threadId: undefined,
    stop: undefined,
  };
}

/** Identifies a Desired Breakpoint by file and position, the same on every target. */
function breakpointKey(filePath: string, index: number): string {
  return `${filePath}\0${String(index)}`;
}

function supportsJsDebugPrimaryTarget(
  adapter: DapAdapterDefinition,
  launchArguments: DapLaunchProfile["arguments"],
): boolean {
  return adapter.transport.type === "tcp" && launchArguments.type === "pwa-node";
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The only check is an instanceof narrow against the classified protocol error.
function isProtocolCancellation(error: unknown): boolean {
  return error instanceof DapProtocolClientError && error.kind === "cancelled";
}

function dapRequestOptions(
  signal: AbortSignal | undefined,
  timeoutMs?: number,
): DapProtocolRequestOptions {
  if (signal === undefined && timeoutMs === undefined) return {};
  if (signal === undefined) return { timeoutMs };
  if (timeoutMs === undefined) return { signal };
  return { signal, timeoutMs };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopOwnedDebuggeeProcess(
  child: ChildProcessWithoutNullStreams,
  shutdownMs: number,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || !isProcessAlive(pid)) return;
  try {
    signalOwnedProcessGroup(child, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + Math.max(1, Math.floor(shutdownMs / 2));
  while (Date.now() < deadline && isProcessAlive(pid)) await delay(10);
  if (!isProcessAlive(pid)) return;
  try {
    signalOwnedProcessGroup(child, "SIGKILL");
  } catch {
    // The Debuggee exited between the liveness check and the signal.
  }
}

/** Own one configured Debug Session at a time and retain Desired Breakpoints across launches. */
export class DapSession {
  private readonly output = new RetainedDapOutput();
  private readonly desiredBreakpoints = new Map<string, readonly DapDesiredBreakpoint[]>();
  private readonly executionWaiters = new Set<() => void>();
  /** Child sessions Pi DAP could not debug during the current launch and not yet reported in a result. */
  private readonly rejectedChildSessions: DapRejectedChildSession[] = [];
  private state: InternalDapSessionState = { kind: "idle" };
  private shutdownPromise: Promise<void> | undefined;

  /** Construct an inert Debug Session controller; launch starts the first Debug Adapter. */
  constructor(private readonly options: DapSessionOptions) {}

  /** Launch one configured Launch Profile and wait for its first stop, exit, cancellation, or execution timeout. */
  async launch(input: DapLaunchInput = {}, signal?: AbortSignal): Promise<DapSessionResult> {
    if (this.state.kind === "active") {
      throw new DapSessionError("state", "launch requires no active Debug Session");
    }
    if (this.state.kind === "terminated") await this.state.cleanupPromise;
    this.output.drain();
    this.rejectedChildSessions.length = 0;

    const profile = this.resolveLaunchProfile(input.profile);
    const adapter = this.options.settings.adapters.get(profile.adapterId);
    if (adapter === undefined) {
      throw new DapSessionError(
        "configuration",
        `Launch Profile ${profile.id} references unavailable Adapter Definition ${profile.adapterId}`,
      );
    }
    // ponytail: shallow merge suffices — only top-level launch keys are replaced.
    const launchArguments = { ...profile.arguments, ...input.launchArguments };
    const adapterProtocolId = Value.Check(DapAdapterProtocolIdSchema, launchArguments.type)
      ? launchArguments.type
      : adapter.id;
    if (input.program !== undefined)
      launchArguments.program = resolve(this.options.cwd, input.program);
    if (input.args !== undefined) launchArguments.args = [...input.args];
    if (input.cwd !== undefined) launchArguments.cwd = resolve(this.options.cwd, input.cwd);

    const debuggeeProcesses = new Set<ChildProcessWithoutNullStreams>();
    const stderrPath = await this.options.sessionFiles.getAdapterStderrPath();
    let active: ActiveDapSession | undefined;
    try {
      const client = await DapProtocolClient.start({
        adapterId: adapter.id,
        cwd: this.options.cwd,
        command: adapter.command,
        args: adapter.args,
        environment: adapter.environment,
        transport: protocolTransport(adapter),
        timeouts: {
          startupMs: this.options.settings.timeouts.startupMs,
          requestMs: this.options.settings.timeouts.requestMs,
          shutdownMs: this.options.settings.timeouts.shutdownMs,
        },
        stderrPath,
        startupSignal: signal,
        onReverseRequest: (request) =>
          this.handleReverseRequest(request, debuggeeProcesses, () => active, signal),
        onFailure: (error) => {
          if (active !== undefined) this.handleAdapterFailure(active, error);
        },
      });
      const rootTarget = debugTarget(client, undefined, false);
      const startedActive: ActiveDapSession = {
        adapter,
        profile,
        launchArguments,
        rootClient: client,
        rootTarget,
        primary: rootTarget,
        focus: rootTarget,
        children: new Set(),
        threadOwners: new Map(),
        nextThreadId: 1,
        reportedBreakpointIds: new Map(),
        debuggeeProcesses,
        targetChannelStarted: false,
        unsubscribeEvents: new Set(),
        capabilities: {},
        phase: "launching",
        topFrame: undefined,
        stopSequence: 0,
        stopArrivals: 0,
        exitCode: undefined,
        targetTerminated: false,
        rootTerminated: false,
        settleTermination: new Set(),
        stopping: false,
      };
      active = startedActive;
      this.state = { kind: "active", active: startedActive };
      this.publishSnapshot();
      startedActive.unsubscribeEvents.add(
        client.onEvent((event) => this.handleDapEvent(startedActive, event, "root", rootTarget)),
      );

      const initialized: Promise<DapLaunchResponseOutcome> = client
        .waitForEvent(
          "initialized",
          dapRequestOptions(signal, this.options.settings.timeouts.startupMs),
        )
        .then(
          () => ({ kind: "success" }),
          (cause) => ({
            kind: "failure",
            error: cause instanceof Error ? cause : new Error(String(cause)),
          }),
        );
      active.capabilities = parseDapBody(
        DapCapabilitiesSchema,
        await client.request(
          "initialize",
          initializeArguments(
            adapterProtocolId,
            true,
            supportsJsDebugPrimaryTarget(adapter, launchArguments),
          ),
          dapRequestOptions(signal, this.options.settings.timeouts.startupMs),
        ),
        "initialize",
      );
      const launchResponse: Promise<DapLaunchResponseOutcome> = client
        .request("launch", launchArguments, dapRequestOptions(signal))
        .then(
          () => ({ kind: "success" }),
          (cause) => ({
            kind: "failure",
            error: cause instanceof Error ? cause : new Error(String(cause)),
          }),
        );
      const initializedOutcome = await initialized;
      if (initializedOutcome.kind === "failure") throw initializedOutcome.error;
      rootTarget.ready = true;
      await this.applyDesiredBreakpoints(active, active.primary, signal);
      if (active.capabilities.supportsConfigurationDoneRequest === true) {
        await client.request("configurationDone", {}, dapRequestOptions(signal));
      }
      const launchOutcome = await launchResponse;
      if (launchOutcome.kind === "failure") throw launchOutcome.error;
      if (this.isCurrentActive(active) && active.phase === "launching") {
        this.transitionActiveToRunning(active);
      }
      if (this.isCurrentActive(active) && active.phase === "running") {
        const wait = this.waitForExecutionTransition(signal);
        await wait.promise;
      }
      await active.cleanupPromise;
      return await this.stoppedResult(active);
    } catch (cause) {
      if (active !== undefined) {
        await this.finishActiveSession(active, "launch failed");
      } else {
        await Promise.all(
          [...debuggeeProcesses].map((child) =>
            stopOwnedDebuggeeProcess(child, this.options.settings.timeouts.shutdownMs),
          ),
        );
        this.state = { kind: "idle" };
        this.publishSnapshot();
      }
      if (isProtocolCancellation(cause)) {
        throw new DapSessionError("adapter", "launch was cancelled and cleaned up", { cause });
      }
      if (cause instanceof DapSessionError) throw cause;
      throw new DapSessionError(
        "adapter",
        `launch failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }

  /** Replace all Desired Breakpoints for one file, preserving the prior list if the active update fails. */
  async setBreakpoints(
    input: DapSetBreakpointsInput,
    signal?: AbortSignal,
  ): Promise<DapSessionResult> {
    const filePath = resolve(this.options.cwd, input.filePath);
    const breakpoints = input.breakpoints.map((breakpoint) => ({ ...breakpoint }));
    const active = this.currentActive();
    if (active === undefined) {
      this.retainBreakpoints(filePath, breakpoints);
      return this.result();
    }
    const children = [...active.children].filter((child) => child.ready);
    const [primary, ...childBodies] = await Promise.all([
      this.sendBreakpoints(active, active.primary, filePath, breakpoints, signal),
      // Best effort: a child session can end while the request is in flight.
      ...children.map((child) =>
        this.sendBreakpoints(active, child, filePath, breakpoints, signal).catch(() => undefined),
      ),
    ]);
    this.retainBreakpoints(filePath, breakpoints);
    // A child that became ready meanwhile may have applied the previous list; it gets this one.
    const late = [...active.children].filter((child) => child.ready && !children.includes(child));
    await Promise.all(
      late.map((child) =>
        this.sendBreakpoints(active, child, filePath, breakpoints, signal).catch(() => undefined),
      ),
    );
    // Code a child session loads is unknown to the primary target: verified where any target is.
    const reported = primary.breakpoints.map((breakpoint, index) => {
      const verified = breakpoint.verified
        ? breakpoint
        : (childBodies.find((body) => body?.breakpoints[index]?.verified === true)?.breakpoints[
            index
          ] ?? breakpoint);
      const id = active.reportedBreakpointIds.get(breakpointKey(filePath, index));
      return id === undefined ? verified : { ...verified, id };
    });
    return this.result({ breakpoints: reported });
  }

  /** An empty list clears the file, so it drops out of Desired Breakpoints instead of lingering. */
  private retainBreakpoints(filePath: string, breakpoints: readonly DapDesiredBreakpoint[]): void {
    if (breakpoints.length === 0) this.desiredBreakpoints.delete(filePath);
    else this.desiredBreakpoints.set(filePath, breakpoints);
  }

  /** Continue a stopped Debuggee and wait for its next stop or termination. */
  continue(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.executeLifecycleRequest("continue", signal);
  }

  /** Step over in a stopped Debuggee and wait for its next stop or termination. */
  next(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.executeLifecycleRequest("next", signal);
  }

  /** Step into in a stopped Debuggee and wait for its next stop or termination. */
  stepIn(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.executeLifecycleRequest("stepIn", signal);
  }

  /** Step out in a stopped Debuggee and wait for its next stop or termination. */
  stepOut(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.executeLifecycleRequest("stepOut", signal);
  }

  /** Pause a running Debuggee and wait for its stopped event. */
  pause(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.pauseTargets(signal);
  }

  /** Retrieve a page of Stack Frames from the stopped thread. */
  async stack(input: DapStackInput = {}, signal?: AbortSignal): Promise<DapSessionResult> {
    const active = this.requireActivePhase("stopped", "stack");
    const threadId =
      input.threadId === undefined
        ? await this.resolveThreadId(active, active.focus, signal)
        : this.adapterThreadId(active, input.threadId);
    const body = parseDapBody(
      DapStackTraceBodySchema,
      await active.focus.client.request(
        "stackTrace",
        { threadId, startFrame: input.start ?? 0, levels: input.count ?? 20 },
        dapRequestOptions(signal),
      ),
      "stackTrace",
    );
    return this.result({
      stackFrames: body.stackFrames,
      totalFrames: body.totalFrames ?? body.stackFrames.length,
    });
  }

  /** Retrieve paged variables by Stack Frame scopes or child variables reference. */
  async variables(input: DapVariablesInput, signal?: AbortSignal): Promise<DapSessionResult> {
    const active = this.requireActivePhase("stopped", "variables");
    const start = input.start ?? 0;
    const count = input.count ?? 100;
    if (input.variablesReference !== undefined) {
      const body = await this.requestVariables(
        active,
        input.variablesReference,
        start,
        count,
        signal,
      );
      return this.result({ variables: body.variables });
    }
    const scopes = parseDapBody(
      DapScopesBodySchema,
      await active.focus.client.request(
        "scopes",
        { frameId: input.frameId },
        dapRequestOptions(signal),
      ),
      "scopes",
    ).scopes;
    // Expensive scopes (such as js-debug's Global) can hold thousands of rows; list, don't expand.
    const variableGroups = await Promise.all(
      scopes.map(async (scope): Promise<DapVariableGroup> => {
        if (scope.expensive) return { scope };
        const { variables } = await this.requestVariables(
          active,
          scope.variablesReference,
          start,
          count,
          signal,
        );
        return { scope, variables };
      }),
    );
    return this.result({ variableGroups });
  }

  /** Evaluate an expression in a chosen or top stopped Stack Frame. */
  async evaluate(input: DapEvaluateInput, signal?: AbortSignal): Promise<DapSessionResult> {
    const active = this.requireActivePhase("stopped", "evaluate");
    let frameId = input.frameId;
    if (frameId === undefined) {
      const stackResult = parseDapBody(
        DapStackTraceBodySchema,
        await active.focus.client.request(
          "stackTrace",
          {
            threadId: await this.resolveThreadId(active, active.focus, signal),
            startFrame: 0,
            levels: 1,
          },
          dapRequestOptions(signal),
        ),
        "stackTrace",
      );
      frameId = stackResult.stackFrames.at(0)?.id;
      if (frameId === undefined) {
        throw new DapSessionError("state", "evaluate requires a top Stack Frame");
      }
    }
    const evaluation = parseDapBody(
      DapEvaluateBodySchema,
      await active.focus.client.request(
        "evaluate",
        { expression: input.expression, frameId, context: "repl" },
        dapRequestOptions(signal),
      ),
      "evaluate",
    );
    return this.result({ evaluation });
  }

  /** Return the current lifecycle snapshot and drain currently unread Debuggee output. */
  status(): DapSessionResult {
    return this.result({ ...this.stopPayload(), ...this.drainRejectedChildSessions() });
  }

  /** Idempotently stop the active Debug Session and preserve Desired Breakpoints. */
  async stop(): Promise<DapSessionResult> {
    const active = this.currentActive();
    if (active === undefined) {
      if (this.state.kind === "terminated") await this.state.cleanupPromise;
      return this.result();
    }
    await this.finishActiveSession(active, "stopped by request");
    return this.result();
  }

  /** Close the active Debug Session during Pi session shutdown. */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      const active = this.currentActive();
      if (active !== undefined) {
        await this.finishActiveSession(active, "Pi session shutdown");
      } else if (this.state.kind === "terminated") {
        await this.state.cleanupPromise;
      }
    })();
    return this.shutdownPromise;
  }

  private resolveLaunchProfile(profileId: string | undefined): DapLaunchProfile {
    if (profileId !== undefined) {
      const profile = this.options.settings.profiles.get(profileId);
      if (profile === undefined) {
        throw new DapSessionError("configuration", `unknown Launch Profile ${profileId}`);
      }
      return profile;
    }
    if (this.options.settings.profiles.size !== 1) {
      throw new DapSessionError(
        "configuration",
        "launch requires profile when there is not exactly one valid Launch Profile",
      );
    }
    const profile = this.options.settings.profiles.values().next().value;
    if (profile === undefined) {
      throw new DapSessionError("configuration", "launch requires a valid Launch Profile");
    }
    return profile;
  }

  private async applyDesiredBreakpoints(
    active: ActiveDapSession,
    target: DapDebugTarget,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const [filePath, breakpoints] of this.desiredBreakpoints) {
      await this.sendBreakpoints(active, target, filePath, breakpoints, signal);
    }
  }

  /** Send one file's Breakpoints to one target and record the ids it gave them. */
  private async sendBreakpoints(
    active: ActiveDapSession,
    target: DapDebugTarget,
    filePath: string,
    breakpoints: readonly DapDesiredBreakpoint[],
    signal: AbortSignal | undefined,
  ): Promise<Static<typeof DapSetBreakpointsBodySchema>> {
    const response = parseDapBody(
      DapSetBreakpointsBodySchema,
      await target.client.request(
        "setBreakpoints",
        {
          source: { name: filePath.split(/[\\/]/).at(-1), path: filePath },
          breakpoints: breakpoints.map((breakpoint) => ({ ...breakpoint })),
          lines: breakpoints.map(({ line }) => line),
          sourceModified: false,
        },
        dapRequestOptions(signal),
      ),
      "setBreakpoints",
    );
    const filePrefix = breakpointKey(filePath, 0).slice(0, -1);
    for (const [id, key] of target.breakpointKeys) {
      if (key.startsWith(filePrefix)) target.breakpointKeys.delete(id);
    }
    const isPrimary = target === active.primary;
    if (isPrimary) {
      for (const key of active.reportedBreakpointIds.keys()) {
        if (key.startsWith(filePrefix)) active.reportedBreakpointIds.delete(key);
      }
    }
    response.breakpoints.forEach(({ id }, index) => {
      if (id === undefined) return;
      const key = breakpointKey(filePath, index);
      target.breakpointKeys.set(id, key);
      if (isPrimary || !active.reportedBreakpointIds.has(key)) {
        active.reportedBreakpointIds.set(key, id);
      }
    });
    return response;
  }

  /** Resume or step the target whose stop is reported, then wait for the next stop. */
  private async executeLifecycleRequest(
    command: "continue" | "next" | "stepIn" | "stepOut",
    signal: AbortSignal | undefined,
  ): Promise<DapSessionResult> {
    const active = this.requireActivePhase("stopped", command);
    const target = active.focus;
    const threadId = await this.resolveThreadId(active, target, signal);
    target.stop = undefined;
    this.transitionActiveToRunning(active);
    return this.waitAfter(active, signal, async () => {
      await target.client.request(command, { threadId }, dapRequestOptions(signal));
    });
  }

  /** Pause the primary target and, best effort, every Child session; the first stop is reported. */
  private async pauseTargets(signal: AbortSignal | undefined): Promise<DapSessionResult> {
    const active = this.requireActivePhase("running", "pause");
    const pause = async (target: DapDebugTarget) => {
      const threadId = await this.resolveThreadId(active, target, signal);
      await target.client.request("pause", { threadId }, dapRequestOptions(signal));
    };
    const children = [...active.children].filter((child) => child.ready);
    return this.waitAfter(active, signal, async () => {
      await Promise.all([
        pause(active.primary),
        ...children.map((child) => pause(child).catch(() => undefined)),
      ]);
    });
  }

  /** Send an execution request, then wait for a stop, exit, cancellation, or the execution timeout. */
  private async waitAfter(
    active: ActiveDapSession,
    signal: AbortSignal | undefined,
    send: () => Promise<void>,
  ): Promise<DapSessionResult> {
    const wait = this.waitForExecutionTransition(signal);
    try {
      await send();
    } catch (cause) {
      wait.cancel();
      // A target that stopped meanwhile stays reportable even though this request failed.
      this.focusQueuedStop(active);
      if (isProtocolCancellation(cause)) return this.result();
      throw cause;
    }
    // Another target stopped while this one was stopped: its stop is reported next, right away.
    this.focusQueuedStop(active);
    await wait.promise;
    await active.cleanupPromise;
    return this.stoppedResult(active);
  }

  /** Result that, when the Debuggee is stopped, says where and why without a separate stack call. */
  private async stoppedResult(active: ActiveDapSession): Promise<DapSessionResult> {
    if (this.isCurrentActive(active) && active.phase === "stopped") {
      const stopSequence = active.stopSequence;
      const topFrame = await this.readTopFrame(active);
      if (
        topFrame !== undefined &&
        this.isCurrentActive(active) &&
        active.phase === "stopped" &&
        active.stopSequence === stopSequence
      ) {
        active.topFrame = topFrame;
      }
    }
    return this.result({ ...this.stopPayload(), ...this.drainRejectedChildSessions() });
  }

  /** Unreported child sessions Pi DAP could not debug, once, like unread Debuggee output. */
  private drainRejectedChildSessions(): Pick<DapSessionResult, "rejectedChildSessions"> {
    if (this.rejectedChildSessions.length === 0) return {};
    return { rejectedChildSessions: this.rejectedChildSessions.splice(0) };
  }

  /**
   * Best effort: a stop is still reported when the adapter cannot give its top Stack Frame. The read
   * ignores the tool's cancellation signal so a cancel after the stop cannot discard the location.
   */
  private async readTopFrame(
    active: ActiveDapSession,
  ): Promise<DebugProtocol.StackFrame | undefined> {
    const target = active.focus;
    try {
      const body = parseDapBody(
        DapStackTraceBodySchema,
        await target.client.request(
          "stackTrace",
          {
            threadId: await this.resolveThreadId(active, target, undefined),
            startFrame: 0,
            levels: 1,
          },
          dapRequestOptions(undefined),
        ),
        "stackTrace",
      );
      return body.stackFrames.at(0);
    } catch {
      return undefined;
    }
  }

  private stopPayload(): Pick<DapSessionResult, "stop"> {
    const active = this.currentActive();
    if (active === undefined || active.phase !== "stopped") return {};
    const { focus } = active;
    const stop: Mutable<DapStopDetails> = {};
    if (focus.stop?.description !== undefined) stop.description = focus.stop.description;
    if (focus.stop?.hitBreakpointIds !== undefined) {
      stop.hitBreakpointIds = focus.stop.hitBreakpointIds.map((id) => {
        const key = focus.breakpointKeys.get(id);
        return key === undefined ? id : (active.reportedBreakpointIds.get(key) ?? id);
      });
    }
    if (active.topFrame !== undefined) stop.topFrame = active.topFrame;
    if (focus.childSessionName !== undefined) stop.childSession = focus.childSessionName;
    return { stop };
  }

  /** The adapter thread id of the target's stop, else of its first thread. */
  private async resolveThreadId(
    active: ActiveDapSession,
    target: DapDebugTarget,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    if (target.threadId !== undefined) return target.threadId;
    const body = parseDapBody(
      DapThreadsBodySchema,
      await target.client.request("threads", {}, dapRequestOptions(signal)),
      "threads",
    );
    const threadId = body.threads.at(0)?.id;
    if (threadId === undefined) {
      throw new DapSessionError("state", "Debuggee has no thread available for this operation");
    }
    target.threadId = threadId;
    this.assignPiThreadId(active, target, threadId);
    return threadId;
  }

  /** Assign, once, the thread id Pi reports for a target's adapter thread id. */
  private assignPiThreadId(
    active: ActiveDapSession,
    target: DapDebugTarget,
    adapterThreadId: number,
  ): number {
    if (target.piThreadIds === undefined) return adapterThreadId;
    const known = target.piThreadIds.get(adapterThreadId);
    if (known !== undefined) return known;
    const threadId = active.nextThreadId++;
    target.piThreadIds.set(adapterThreadId, threadId);
    active.threadOwners.set(threadId, { target, threadId: adapterThreadId });
    return threadId;
  }

  /** The adapter thread id behind a reported thread id, which must belong to the stopped target. */
  private adapterThreadId(active: ActiveDapSession, threadId: number): number {
    if (active.focus.piThreadIds === undefined) return threadId;
    const owner = active.threadOwners.get(threadId);
    if (owner === undefined || owner.target !== active.focus) {
      throw new DapSessionError(
        "state",
        `stack requires a thread of the stopped target; thread ${String(threadId)} is not one`,
      );
    }
    return owner.threadId;
  }

  private requestVariables(
    active: ActiveDapSession,
    variablesReference: number,
    start: number,
    count: number,
    signal: AbortSignal | undefined,
  ): Promise<Static<typeof DapVariablesBodySchema>> {
    return active.focus.client
      .request("variables", { variablesReference, start, count }, dapRequestOptions(signal))
      .then((body) => parseDapBody(DapVariablesBodySchema, body, "variables"));
  }

  private requireActivePhase(phase: "running" | "stopped", operation: string): ActiveDapSession {
    const active = this.currentActive();
    if (active === undefined || active.phase !== phase) {
      throw new DapSessionError("state", `${operation} requires a ${phase} Debuggee`);
    }
    return active;
  }

  private currentActive(): ActiveDapSession | undefined {
    return this.state.kind === "active" ? this.state.active : undefined;
  }

  private isCurrentActive(active: ActiveDapSession): boolean {
    return this.state.kind === "active" && this.state.active === active;
  }

  private handleDapEvent(
    active: ActiveDapSession,
    event: DebugProtocol.Event,
    channel: "root" | "target" | "child",
    target: DapDebugTarget,
  ): void {
    if (!this.isCurrentActive(active)) return;
    if (channel === "child" && !active.children.has(target)) return;
    try {
      switch (event.event) {
        case "output": {
          const body = parseDapBody(DapOutputEventBodySchema, event.body, "output event");
          // Adapters such as vscode-js-debug send diagnostics with category "telemetry".
          if (body.category !== "telemetry") this.output.append(body.output);
          // vscode-js-debug never sends `exited`; it reports a non-zero exit on the root channel.
          // The last report wins, as the adapter's own report follows any earlier look-alike.
          if (
            channel === "root" &&
            active.targetClient !== undefined &&
            jsDebugReportsExitOnRoot(active.launchArguments)
          ) {
            const exitCode = jsDebugExitCode(body);
            if (exitCode !== undefined) active.exitCode = exitCode;
          }
          return;
        }
        case "stopped": {
          const body = parseDapBody(DapStoppedEventBodySchema, event.body, "stopped event");
          target.stop = {
            arrival: ++active.stopArrivals,
            reason: body.reason,
            description: body.description,
            hitBreakpointIds: body.hitBreakpointIds,
          };
          target.threadId = body.threadId;
          if (body.threadId !== undefined) this.assignPiThreadId(active, target, body.threadId);
          // One stop is reported at a time; a stop in another target waits its turn.
          if (active.phase !== "stopped" || active.focus === target) this.focusStop(active, target);
          return;
        }
        case "continued": {
          const body = parseDapBody(DapContinuedEventBodySchema, event.body, "continued event");
          target.stop = undefined;
          if (body.threadId !== undefined) {
            target.threadId = body.threadId;
            this.assignPiThreadId(active, target, body.threadId);
          }
          if (active.focus === target) {
            this.transitionActiveToRunning(active);
            this.focusQueuedStop(active);
          }
          return;
        }
        case "exited":
          // A Child session's exit is not the Debuggee's; its `terminated` ends its channel.
          if (channel === "child") return;
          active.exitCode = parseDapBody(
            DapExitedEventBodySchema,
            event.body,
            "exited event",
          ).exitCode;
          if (!active.stopping) void this.finishActiveSession(active, "Debuggee exited");
          return;
        case "terminated":
          if (active.stopping) return;
          if (channel === "child") {
            this.removeChildSession(active, target);
            return;
          }
          if (channel === "root") active.rootTerminated = true;
          else active.targetTerminated = true;
          for (const settle of active.settleTermination) settle();
          if (active.targetClient === undefined) {
            void this.finishActiveSession(active, "Debug Session terminated");
          } else {
            void this.finishAfterChannelsTerminate(active);
          }
          return;
        default:
          return;
      }
    } catch (cause) {
      // A Child session that misbehaves is dropped; the Debuggee's own session goes on.
      if (channel === "child") {
        this.removeChildSession(active, target);
        return;
      }
      const error =
        cause instanceof Error ? cause : new Error("DAP Session: invalid Debug Adapter event");
      this.publishUnexpectedFailure(error);
      void this.finishActiveSession(active, error.message);
    }
  }

  /** Report a target's stop: it becomes the target inspection and stepping operations use. */
  private focusStop(active: ActiveDapSession, target: DapDebugTarget): void {
    active.focus = target;
    active.phase = "stopped";
    active.topFrame = undefined;
    active.stopSequence++;
    this.publishSnapshot();
    this.settleExecutionWaiters();
  }

  /** While running, report the stop that has waited longest, if any target has one. */
  private focusQueuedStop(active: ActiveDapSession): void {
    if (!this.isCurrentActive(active) || active.phase === "stopped") return;
    let queued: DapDebugTarget | undefined;
    for (const target of [active.primary, ...active.children]) {
      if (target.stop === undefined) continue;
      if (queued?.stop === undefined || target.stop.arrival < queued.stop.arrival) queued = target;
    }
    if (queued !== undefined) this.focusStop(active, queued);
  }

  /** Forget a Child session that ended or failed, and detach its channel. */
  private removeChildSession(active: ActiveDapSession, target: DapDebugTarget): void {
    if (!active.children.delete(target)) return;
    void target.client.detach().catch(() => undefined);
    if (active.focus !== target) return;
    active.focus = active.primary;
    if (active.phase === "stopped") {
      this.transitionActiveToRunning(active);
      this.focusQueuedStop(active);
    }
  }

  /**
   * vscode-js-debug reports `terminated` on both the primary target channel and the root channel,
   * in either order. The root channel's comes last of its events and follows any `Process exited
   * with code N` report, which is also where a late root output event would otherwise be lost. Wait
   * for both. Where the adapter reports exits on the root channel, a clean run sends no report, so
   * a root `terminated` with none means exit code 0 (a signal kill also reads 0, as js-debug
   * reports it). Otherwise the exit code stays whatever the Debuggee's `runInTerminal` child
   * recorded, or unknown. A timeout finishes with the exit code unknown unless the root ended.
   *
   * This assumes one primary target channel, as the V1 boundary allows; more would need a count.
   */
  private async finishAfterChannelsTerminate(active: ActiveDapSession): Promise<void> {
    if (!active.rootTerminated || !active.targetTerminated) {
      await new Promise<void>((resolveWait) => {
        const finish = () => {
          clearTimeout(timer);
          active.settleTermination.delete(finish);
          resolveWait();
        };
        const timer = setTimeout(finish, this.options.settings.timeouts.shutdownMs);
        active.settleTermination.add(finish);
        if (active.rootTerminated && active.targetTerminated) finish();
      });
    }
    if (!this.isCurrentActive(active) || active.stopping) return;
    if (
      active.rootTerminated &&
      active.exitCode === undefined &&
      jsDebugReportsExitOnRoot(active.launchArguments)
    ) {
      active.exitCode = 0;
    }
    await this.finishActiveSession(active, "Debug Session terminated");
  }

  private handleAdapterFailure(active: ActiveDapSession, error: DapProtocolClientError): void {
    if (!this.isCurrentActive(active) || active.stopping) return;
    this.publishUnexpectedFailure(error);
    void this.finishActiveSession(active, error.message);
  }

  private handleReverseRequest(
    request: DebugProtocol.Request,
    debuggeeProcesses: Set<ChildProcessWithoutNullStreams>,
    getActive: () => ActiveDapSession | undefined,
    signal: AbortSignal | undefined,
  ): Promise<DapReverseRequestResult> | DapReverseRequestResult {
    if (request.command === "startDebugging") {
      const active = getActive();
      if (
        active !== undefined &&
        !active.targetChannelStarted &&
        supportsJsDebugPrimaryTarget(active.adapter, active.launchArguments) &&
        Value.Check(JsDebugPrimaryTargetArgumentsSchema, request.arguments)
      ) {
        return this.startJsDebugPrimaryTarget(active, request.arguments, signal);
      }
      return this.debugChildSession(active, request);
    }
    if (request.command !== "runInTerminal") {
      return { success: false, message: `Pi DAP: unsupported reverse request ${request.command}` };
    }
    if (!Value.Check(RunInTerminalArgumentsSchema, request.arguments)) {
      return { success: false, message: "Pi DAP: runInTerminal arguments are invalid" };
    }
    return this.spawnRunInTerminal(request.arguments, debuggeeProcesses, getActive);
  }

  /**
   * Debug a Child session (a worker thread, a child process, or a child's own child) that
   * vscode-js-debug asks for on its parent's channel: open a target channel for it against the same
   * adapter process, apply Desired Breakpoints, and start it. Its stops are reported one at a time
   * with the primary target's (ADR-0003). A Child session Pi DAP cannot debug is reported in the
   * next operation result; a channel that attached and then failed is detached, which lets the
   * adapter run the child without a debugger.
   */
  private async debugChildSession(
    active: ActiveDapSession | undefined,
    request: DebugProtocol.Request,
  ): Promise<DapReverseRequestResult> {
    const child = Value.Check(StartDebuggingChildArgumentsSchema, request.arguments)
      ? request.arguments
      : undefined;
    const configuration = child?.configuration;
    const description = childSessionDescription(configuration);
    if (active === undefined) {
      return {
        success: false,
        message: `Pi DAP refused child session ${description}: no Debug Session is active.`,
      };
    }
    let failure: string;
    if (
      configuration?.__pendingTargetId === undefined ||
      !supportsJsDebugPrimaryTarget(active.adapter, active.launchArguments)
    ) {
      failure = "Pi DAP debugs child sessions of vscode-js-debug targets only";
    } else {
      try {
        await this.attachChildSession(
          active,
          child?.request ?? "launch",
          configuration,
          configuration.name ?? description,
        );
        return { success: true };
      } catch (cause) {
        failure = cause instanceof Error ? cause.message : String(cause);
      }
    }
    const message = `Pi DAP could not debug child session ${description}: ${failure}. Breakpoints in it will not bind.`;
    this.rejectedChildSessions.push(rejectedChildSession(message, configuration));
    return { success: false, message };
  }

  /**
   * The channel joins the Child sessions before it starts, so its stops, its own children, and its
   * `terminated` are handled like any target's; it leaves them when it terminates or fails.
   */
  private async attachChildSession(
    active: ActiveDapSession,
    request: string,
    configuration: Static<typeof StartDebuggingChildArgumentsSchema>["configuration"],
    name: string,
  ): Promise<void> {
    const { startupMs, requestMs } = this.options.settings.timeouts;
    let attached: DapDebugTarget | undefined;
    const client = await active.rootClient.connectTargetChannel({
      onReverseRequest: (nested) =>
        this.handleReverseRequest(nested, active.debuggeeProcesses, () => active, undefined),
      onFailure: () => {
        if (attached !== undefined) this.removeChildSession(active, attached);
      },
    });
    if (!this.isCurrentActive(active) || active.stopping) {
      await client.detach().catch(() => undefined);
      throw new Error("the Debug Session ended");
    }
    const target = debugTarget(client, name, true);
    attached = target;
    active.children.add(target);
    active.unsubscribeEvents.add(
      client.onEvent((event) => this.handleDapEvent(active, event, "child", target)),
    );
    try {
      const initialized = client.waitForEvent("initialized", { timeoutMs: startupMs });
      initialized.catch(() => undefined);
      const capabilities = parseDapBody(
        DapCapabilitiesSchema,
        await client.request(
          "initialize",
          // A Child session's own children are asked for on its channel.
          initializeArguments("pwa-node", false, true),
          { timeoutMs: startupMs },
        ),
        "initialize child js-debug target",
      );
      const launchResponse = client.request(
        request,
        { ...configuration },
        { timeoutMs: requestMs },
      );
      launchResponse.catch(() => undefined);
      await initialized;
      target.ready = true;
      await this.applyDesiredBreakpoints(active, target, undefined);
      if (capabilities.supportsConfigurationDoneRequest === true) {
        await client.request("configurationDone", {}, { timeoutMs: requestMs });
      }
      await launchResponse;
    } catch (cause) {
      this.removeChildSession(active, target);
      throw cause;
    }
  }

  private async startJsDebugPrimaryTarget(
    active: ActiveDapSession,
    argumentsValue: Static<typeof JsDebugPrimaryTargetArgumentsSchema>,
    signal: AbortSignal | undefined,
  ): Promise<DapReverseRequestResult> {
    active.targetChannelStarted = true;
    const targetClient = await active.rootClient.connectTargetChannel({
      startupSignal: signal,
      onReverseRequest: (request) =>
        this.handleReverseRequest(request, active.debuggeeProcesses, () => active, signal),
      onFailure: (error) => this.handleAdapterFailure(active, error),
    });
    const primary = debugTarget(targetClient, undefined, true);
    active.targetClient = targetClient;
    active.primary = primary;
    active.focus = primary;
    active.unsubscribeEvents.add(
      targetClient.onEvent((event) => this.handleDapEvent(active, event, "target", primary)),
    );

    const initialized = targetClient.waitForEvent(
      "initialized",
      dapRequestOptions(signal, this.options.settings.timeouts.startupMs),
    );
    const capabilities = parseDapBody(
      DapCapabilitiesSchema,
      await targetClient.request(
        "initialize",
        // vscode-js-debug asks for the primary target's Child sessions on this channel.
        initializeArguments("pwa-node", true, true),
        dapRequestOptions(signal, this.options.settings.timeouts.startupMs),
      ),
      "initialize primary js-debug target",
    );
    const launchResponse = targetClient.request(
      argumentsValue.request,
      { ...argumentsValue.configuration },
      dapRequestOptions(signal),
    );
    await initialized;
    active.capabilities = capabilities;
    primary.ready = true;
    await this.applyDesiredBreakpoints(active, primary, signal);
    if (capabilities.supportsConfigurationDoneRequest === true) {
      await targetClient.request("configurationDone", {}, dapRequestOptions(signal));
    }
    await launchResponse;
    return { success: true };
  }

  private async spawnRunInTerminal(
    argumentsValue: Static<typeof RunInTerminalArgumentsSchema>,
    debuggeeProcesses: Set<ChildProcessWithoutNullStreams>,
    getActive: () => ActiveDapSession | undefined,
  ): Promise<DapReverseRequestResult> {
    const environment = resolvedAdapterEnvironment(argumentsValue.env ?? {});
    const interpretedByShell = argumentsValue.argsCanBeInterpretedByShell === true;
    const command = interpretedByShell ? argumentsValue.args.join(" ") : argumentsValue.args[0];
    if (command === undefined)
      return { success: false, message: "Pi DAP: runInTerminal has no command" };
    const commandArguments = interpretedByShell ? [] : argumentsValue.args.slice(1);
    const child = spawn(command, commandArguments, {
      cwd: argumentsValue.cwd,
      detached: process.platform === "linux",
      env: environment,
      shell: interpretedByShell,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => this.output.append(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => this.output.append(chunk.toString("utf8")));
    try {
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child.once("spawn", resolveSpawn);
        child.once("error", rejectSpawn);
      });
    } catch (cause) {
      return {
        success: false,
        message: `Pi DAP: runInTerminal failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    debuggeeProcesses.add(child);
    // Pi owns this child, so its real exit status is the Debuggee's. A kill by Pi or by a signal
    // has no code to report; a stop that Pi requested must not look like a Debuggee exit.
    child.once("exit", (code) => {
      const active = getActive();
      if (code !== null && active !== undefined && !active.stopping) active.exitCode = code;
    });
    child.once("close", () => debuggeeProcesses.delete(child));
    return {
      success: true,
      body: { processId: child.pid, shellProcessId: child.pid },
    };
  }

  private waitForExecutionTransition(signal: AbortSignal | undefined): ExecutionWait {
    let finish: ((outcome: "cancelled" | "timeout" | "transition") => void) | undefined;
    const promise = new Promise<"cancelled" | "timeout" | "transition">((resolveWait) => {
      const timer = setTimeout(
        () => finish?.("timeout"),
        this.options.settings.timeouts.executionMs,
      );
      const onAbort = () => finish?.("cancelled");
      finish = (outcome) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.executionWaiters.delete(onTransition);
        finish = undefined;
        resolveWait(outcome);
      };
      const onTransition = () => finish?.("transition");
      this.executionWaiters.add(onTransition);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) finish("cancelled");
    });
    return { promise, cancel: () => finish?.("cancelled") };
  }

  private settleExecutionWaiters(): void {
    for (const settle of this.executionWaiters) settle();
  }

  private async finishActiveSession(
    active: ActiveDapSession,
    terminationReason: string,
  ): Promise<void> {
    if (active.cleanupPromise !== undefined) return active.cleanupPromise;
    active.stopping = true;
    // Wake any wait for the other channel's `terminated` so its grace timer is cleared.
    for (const settle of active.settleTermination) settle();
    const cleanup = (async () => {
      for (const unsubscribe of active.unsubscribeEvents) unsubscribe();
      active.unsubscribeEvents.clear();
      await Promise.all(
        [...active.children].map((child) => child.client.detach().catch(() => undefined)),
      );
      try {
        await active.targetClient?.shutdown();
      } catch {
        // The terminal snapshot remains useful after a failed best-effort shutdown.
      }
      try {
        await active.rootClient.shutdown();
      } catch {
        // Process-group ownership is best effort after adapter failure.
      }
      await Promise.all(
        [...active.debuggeeProcesses].map((child) =>
          stopOwnedDebuggeeProcess(child, this.options.settings.timeouts.shutdownMs),
        ),
      );
    })();
    active.cleanupPromise = cleanup;
    if (this.isCurrentActive(active)) {
      // oxlint-disable-next-line anti-slop/no-known-value-widening -- SAFETY: Mutable removes only readonly for construction; all fields retain the terminated-state contract.
      const terminated: Mutable<Extract<InternalDapSessionState, { kind: "terminated" }>> = {
        kind: "terminated",
        adapterId: active.adapter.id,
        profileId: active.profile.id,
        cleanupPromise: cleanup,
      };
      if (active.exitCode !== undefined) terminated.exitCode = active.exitCode;
      if (terminationReason.length > 0) terminated.terminationReason = terminationReason;
      this.state = terminated;
      this.publishSnapshot();
    }
    this.settleExecutionWaiters();
    await cleanup;
  }

  private transitionActiveToRunning(active: ActiveDapSession): void {
    if (!this.isCurrentActive(active)) return;
    const changed = active.phase !== "running";
    active.phase = "running";
    active.topFrame = undefined;
    if (changed) this.publishSnapshot();
  }

  private publishSnapshot(): void {
    try {
      this.options.onSnapshotChange?.(this.snapshot());
    } catch {
      // Observer UI failures cannot change Debug Session cleanup or protocol behavior.
    }
  }

  private publishUnexpectedFailure(error: Error): void {
    try {
      this.options.onUnexpectedFailure?.(error);
    } catch {
      // Observer UI failures cannot change Debug Session cleanup or protocol behavior.
    }
  }

  /** Current lifecycle snapshot, without draining unread Debuggee output. */
  snapshot(): DapSessionSnapshot {
    if (this.state.kind === "idle") return { state: "idle" };
    if (this.state.kind === "terminated") {
      const terminated = this.state;
      // oxlint-disable-next-line anti-slop/no-known-value-widening -- SAFETY: Mutable preserves every snapshot field type while optional fields are assigned before publication.
      const snapshot: Mutable<Extract<DapSessionSnapshot, { state: "terminated" }>> = {
        state: "terminated",
        adapterId: terminated.adapterId,
        profileId: terminated.profileId,
      };
      if (terminated.exitCode !== undefined) snapshot.exitCode = terminated.exitCode;
      if (terminated.terminationReason !== undefined) {
        snapshot.terminationReason = terminated.terminationReason;
      }
      return snapshot;
    }
    const active = this.state.active;
    if (active.phase === "stopped") {
      // oxlint-disable-next-line anti-slop/no-known-value-widening -- SAFETY: Mutable preserves every snapshot field type while the optional thread is assigned before publication.
      const snapshot: Mutable<Extract<DapSessionSnapshot, { state: "stopped" }>> = {
        state: "stopped",
        adapterId: active.adapter.id,
        profileId: active.profile.id,
        stopReason: active.focus.stop?.reason ?? "unknown",
      };
      const { piThreadIds, threadId } = active.focus;
      const reported =
        threadId === undefined || piThreadIds === undefined ? threadId : piThreadIds.get(threadId);
      if (reported !== undefined) snapshot.threadId = reported;
      return snapshot;
    }
    return {
      state: active.phase,
      adapterId: active.adapter.id,
      profileId: active.profile.id,
    };
  }

  private result(
    payload: Omit<
      DapSessionResult,
      "snapshot" | "output" | "discardedOutputBytes" | "desiredBreakpoints"
    > = {},
  ): DapSessionResult {
    const output = this.output.drain();
    return {
      snapshot: this.snapshot(),
      output: output.text,
      discardedOutputBytes: output.discardedBytes,
      desiredBreakpoints: [...this.desiredBreakpoints]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([filePath, breakpoints]) => ({ filePath, breakpoints })),
      ...payload,
    };
  }
}
