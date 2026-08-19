import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DebugProtocol } from "@vscode/debugprotocol";
import { type Static, Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  DapProtocolClient,
  DapProtocolClientError,
  type DapProtocolRequestOptions,
  type DapProtocolTransport,
  type DapReverseRequestResult,
} from "./dap-protocol-client.js";
import {
  createDapOutputBuffer,
  type DapOutputBuffer,
  type DapSessionFiles,
} from "./dap-session-files.js";
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
  { output: Type.String() },
  { additionalProperties: true },
);
const DapStoppedEventBodySchema = Type.Object(
  {
    reason: Type.String(),
    threadId: Type.Optional(Type.Integer()),
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

/** Classified configuration, state, protocol, or Debug Adapter failure. */
export class DapSessionError extends Error {
  readonly _tag = "DapSessionError" as const;

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

/** Variables fetched for one Stack Frame scope. */
export interface DapVariableGroup {
  readonly scope: DebugProtocol.Scope;
  readonly variables: readonly DebugProtocol.Variable[];
}

/** Successful Debug Session operation including unread Debuggee output. */
export interface DapSessionResult {
  readonly snapshot: DapSessionSnapshot;
  readonly output: string;
  readonly discardedOutputBytes: number;
  readonly desiredBreakpoints: readonly DapDesiredBreakpointFile[];
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
}

type DapLaunchArgumentValue =
  | null
  | boolean
  | number
  | string
  | readonly DapLaunchArgumentValue[]
  | { readonly [key: string]: DapLaunchArgumentValue };

interface ActiveDapSession {
  readonly adapter: DapAdapterDefinition;
  readonly profile: DapLaunchProfile;
  readonly rootClient: DapProtocolClient;
  client: DapProtocolClient;
  targetClient?: DapProtocolClient;
  targetChannelStarted: boolean;
  readonly debuggeeProcesses: Set<ChildProcessWithoutNullStreams>;
  readonly unsubscribeEvents: Set<() => void>;
  capabilities: Static<typeof DapCapabilitiesSchema>;
  phase: "launching" | "running" | "stopped";
  stopReason: string | undefined;
  threadId: number | undefined;
  exitCode: number | undefined;
  cleanupPromise?: Promise<void>;
  stopping: boolean;
}

interface TerminatedDapSessionState {
  readonly kind: "terminated";
  readonly adapterId: string;
  readonly profileId: string;
  readonly exitCode?: number;
  readonly terminationReason?: string;
  readonly cleanupPromise: Promise<void>;
}

type InternalDapSessionState =
  | { readonly kind: "idle" }
  | { readonly kind: "active"; readonly active: ActiveDapSession }
  | TerminatedDapSessionState;

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

function supportsJsDebugPrimaryTarget(
  adapter: DapAdapterDefinition,
  profile: DapLaunchProfile,
): boolean {
  return adapter.transport.type === "tcp" && profile.arguments.type === "pwa-node";
}

function isProtocolCancellation(error: Error): boolean {
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

function terminatedDapSessionState(
  active: ActiveDapSession,
  cleanupPromise: Promise<void>,
  terminationReason: string,
): TerminatedDapSessionState {
  if (active.exitCode !== undefined && terminationReason.length > 0) {
    return {
      kind: "terminated",
      adapterId: active.adapter.id,
      profileId: active.profile.id,
      cleanupPromise,
      exitCode: active.exitCode,
      terminationReason,
    };
  }
  if (active.exitCode !== undefined) {
    return {
      kind: "terminated",
      adapterId: active.adapter.id,
      profileId: active.profile.id,
      cleanupPromise,
      exitCode: active.exitCode,
    };
  }
  if (terminationReason.length > 0) {
    return {
      kind: "terminated",
      adapterId: active.adapter.id,
      profileId: active.profile.id,
      cleanupPromise,
      terminationReason,
    };
  }
  return {
    kind: "terminated",
    adapterId: active.adapter.id,
    profileId: active.profile.id,
    cleanupPromise,
  };
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
  const processId = process.platform === "linux" ? -pid : pid;
  try {
    process.kill(processId, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + Math.max(1, Math.floor(shutdownMs / 2));
  while (Date.now() < deadline && isProcessAlive(pid)) await delay(10);
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(processId, "SIGKILL");
  } catch {
    // The Debuggee exited between the liveness check and the signal.
  }
}

/** Own one configured Debug Session at a time and retain Desired Breakpoints across launches. */
export class DapSession {
  private readonly output: DapOutputBuffer = createDapOutputBuffer();
  private readonly desiredBreakpoints = new Map<string, readonly DapDesiredBreakpoint[]>();
  private readonly executionWaiters = new Set<() => void>();
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

    const profile = this.resolveLaunchProfile(input.profile);
    const adapter = this.options.settings.adapters.get(profile.adapterId);
    if (adapter === undefined) {
      throw new DapSessionError(
        "configuration",
        `Launch Profile ${profile.id} references unavailable Adapter Definition ${profile.adapterId}`,
      );
    }
    const launchArguments: { [key: string]: DapLaunchArgumentValue } = structuredClone(
      profile.arguments,
    );
    const adapterProtocolId = Value.Check(DapAdapterProtocolIdSchema, profile.arguments.type)
      ? profile.arguments.type
      : adapter.id;
    if (input.program !== undefined)
      launchArguments.program = resolve(this.options.cwd, input.program);
    if (input.args !== undefined) launchArguments.args = [...input.args];
    if (input.cwd !== undefined) launchArguments.cwd = resolve(this.options.cwd, input.cwd);

    const debuggeeProcesses = new Set<ChildProcessWithoutNullStreams>();
    const stderrPath = await this.options.sessionFiles.getAdapterStderrPath(adapter.id);
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
      const startedActive: ActiveDapSession = {
        adapter,
        profile,
        rootClient: client,
        client,
        debuggeeProcesses,
        targetChannelStarted: false,
        unsubscribeEvents: new Set(),
        capabilities: {},
        phase: "launching",
        stopReason: undefined,
        threadId: undefined,
        exitCode: undefined,
        stopping: false,
      };
      active = startedActive;
      this.state = { kind: "active", active: startedActive };
      startedActive.unsubscribeEvents.add(
        client.onEvent((event) => this.handleDapEvent(startedActive, event)),
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
          {
            adapterID: adapterProtocolId,
            clientID: "pi-dap",
            clientName: "Pi DAP",
            columnsStartAt1: true,
            linesStartAt1: true,
            locale: "en-US",
            pathFormat: "path",
            supportsRunInTerminalRequest: true,
            supportsStartDebuggingRequest: supportsJsDebugPrimaryTarget(adapter, profile),
          },
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
      await this.applyDesiredBreakpoints(active, signal);
      if (active.capabilities.supportsConfigurationDoneRequest === true) {
        await client.request("configurationDone", {}, dapRequestOptions(signal));
      }
      const launchOutcome = await launchResponse;
      if (launchOutcome.kind === "failure") throw launchOutcome.error;
      if (this.isCurrentActive(active) && active.phase === "launching") active.phase = "running";
      if (this.isCurrentActive(active) && active.phase === "running") {
        const wait = this.waitForExecutionTransition(signal);
        await wait.promise;
      }
      await active.cleanupPromise;
      return this.result();
    } catch (cause) {
      if (active !== undefined) {
        active.stopping = true;
        await this.finishActiveSession(active, "launch failed");
      } else {
        await Promise.all(
          [...debuggeeProcesses].map((child) =>
            stopOwnedDebuggeeProcess(child, this.options.settings.timeouts.shutdownMs),
          ),
        );
        this.state = { kind: "idle" };
      }
      if (cause instanceof Error && isProtocolCancellation(cause)) {
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
      this.desiredBreakpoints.set(filePath, breakpoints);
      return this.result();
    }
    const body = await this.sendBreakpoints(active, filePath, breakpoints, signal);
    this.desiredBreakpoints.set(filePath, breakpoints);
    return this.result({ breakpoints: body.breakpoints });
  }

  /** Continue a stopped Debuggee and wait for its next stop or termination. */
  continue(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.executeStoppedRequest("continue", signal);
  }

  /** Step over in a stopped Debuggee and wait for its next stop or termination. */
  next(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.executeStoppedRequest("next", signal);
  }

  /** Step into in a stopped Debuggee and wait for its next stop or termination. */
  stepIn(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.executeStoppedRequest("stepIn", signal);
  }

  /** Step out in a stopped Debuggee and wait for its next stop or termination. */
  stepOut(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.executeStoppedRequest("stepOut", signal);
  }

  /** Pause a running Debuggee and wait for its stopped event. */
  async pause(signal?: AbortSignal): Promise<DapSessionResult> {
    const active = this.requireActivePhase("running", "pause");
    const threadId = await this.resolveThreadId(active, signal);
    const wait = this.waitForExecutionTransition(signal);
    try {
      await active.client.request("pause", { threadId }, dapRequestOptions(signal));
    } catch (cause) {
      wait.cancel();
      if (cause instanceof Error && isProtocolCancellation(cause)) return this.result();
      throw cause;
    }
    await wait.promise;
    await active.cleanupPromise;
    return this.result();
  }

  /** Retrieve a page of Stack Frames from the stopped thread. */
  async stack(input: DapStackInput = {}, signal?: AbortSignal): Promise<DapSessionResult> {
    const active = this.requireActivePhase("stopped", "stack");
    const threadId = input.threadId ?? (await this.resolveThreadId(active, signal));
    const body = parseDapBody(
      DapStackTraceBodySchema,
      await active.client.request(
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
      await active.client.request("scopes", { frameId: input.frameId }, dapRequestOptions(signal)),
      "scopes",
    ).scopes;
    const variableGroups = await Promise.all(
      scopes.map(async (scope): Promise<DapVariableGroup> => ({
        scope,
        variables: (
          await this.requestVariables(active, scope.variablesReference, start, count, signal)
        ).variables,
      })),
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
        await active.client.request(
          "stackTrace",
          { threadId: await this.resolveThreadId(active, signal), startFrame: 0, levels: 1 },
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
      await active.client.request(
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
    return this.result();
  }

  /** Idempotently stop the active Debug Session and preserve Desired Breakpoints. */
  async stop(_signal?: AbortSignal): Promise<DapSessionResult> {
    const active = this.currentActive();
    if (active === undefined) {
      if (this.state.kind === "terminated") await this.state.cleanupPromise;
      return this.result();
    }
    active.stopping = true;
    await this.finishActiveSession(active, "stopped by request");
    return this.result();
  }

  /** Close the active Debug Session during Pi session shutdown. */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      const active = this.currentActive();
      if (active !== undefined) {
        active.stopping = true;
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
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const [filePath, breakpoints] of this.desiredBreakpoints) {
      await this.sendBreakpoints(active, filePath, breakpoints, signal);
    }
  }

  private async sendBreakpoints(
    active: ActiveDapSession,
    filePath: string,
    breakpoints: readonly DapDesiredBreakpoint[],
    signal: AbortSignal | undefined,
  ): Promise<Static<typeof DapSetBreakpointsBodySchema>> {
    const response = parseDapBody(
      DapSetBreakpointsBodySchema,
      await active.client.request(
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
    return response;
  }

  private async executeStoppedRequest(
    command: "continue" | "next" | "stepIn" | "stepOut",
    signal: AbortSignal | undefined,
  ): Promise<DapSessionResult> {
    const active = this.requireActivePhase("stopped", command);
    const threadId = await this.resolveThreadId(active, signal);
    active.phase = "running";
    active.stopReason = undefined;
    const wait = this.waitForExecutionTransition(signal);
    try {
      await active.client.request(command, { threadId }, dapRequestOptions(signal));
    } catch (cause) {
      wait.cancel();
      if (cause instanceof Error && isProtocolCancellation(cause)) return this.result();
      throw cause;
    }
    await wait.promise;
    await active.cleanupPromise;
    return this.result();
  }

  private async resolveThreadId(
    active: ActiveDapSession,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    if (active.threadId !== undefined) return active.threadId;
    const body = parseDapBody(
      DapThreadsBodySchema,
      await active.client.request("threads", {}, dapRequestOptions(signal)),
      "threads",
    );
    const threadId = body.threads.at(0)?.id;
    if (threadId === undefined) {
      throw new DapSessionError("state", "Debuggee has no thread available for this operation");
    }
    active.threadId = threadId;
    return threadId;
  }

  private requestVariables(
    active: ActiveDapSession,
    variablesReference: number,
    start: number,
    count: number,
    signal: AbortSignal | undefined,
  ): Promise<Static<typeof DapVariablesBodySchema>> {
    return active.client
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

  private handleDapEvent(active: ActiveDapSession, event: DebugProtocol.Event): void {
    if (!this.isCurrentActive(active)) return;
    try {
      switch (event.event) {
        case "output":
          this.output.append(
            parseDapBody(DapOutputEventBodySchema, event.body, "output event").output,
          );
          return;
        case "stopped": {
          const body = parseDapBody(DapStoppedEventBodySchema, event.body, "stopped event");
          active.phase = "stopped";
          active.stopReason = body.reason;
          active.threadId = body.threadId;
          this.settleExecutionWaiters();
          return;
        }
        case "continued": {
          const body = parseDapBody(DapContinuedEventBodySchema, event.body, "continued event");
          active.phase = "running";
          if (body.threadId !== undefined) active.threadId = body.threadId;
          return;
        }
        case "exited":
          active.exitCode = parseDapBody(
            DapExitedEventBodySchema,
            event.body,
            "exited event",
          ).exitCode;
          if (!active.stopping) void this.finishActiveSession(active, "Debuggee exited");
          return;
        case "terminated":
          if (!active.stopping) void this.finishActiveSession(active, "Debug Session terminated");
          return;
        default:
          return;
      }
    } catch (cause) {
      void this.finishActiveSession(
        active,
        cause instanceof Error ? cause.message : "invalid Debug Adapter event",
      );
    }
  }

  private handleAdapterFailure(active: ActiveDapSession, error: DapProtocolClientError): void {
    if (!this.isCurrentActive(active) || active.stopping) return;
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
        active === undefined ||
        active.targetChannelStarted ||
        !supportsJsDebugPrimaryTarget(active.adapter, active.profile) ||
        !Value.Check(JsDebugPrimaryTargetArgumentsSchema, request.arguments)
      ) {
        return { success: false, message: "Pi DAP: startDebugging is outside the V1 boundary" };
      }
      return this.startJsDebugPrimaryTarget(active, request.arguments, signal);
    }
    if (request.command !== "runInTerminal") {
      return { success: false, message: `Pi DAP: unsupported reverse request ${request.command}` };
    }
    if (!Value.Check(RunInTerminalArgumentsSchema, request.arguments)) {
      return { success: false, message: "Pi DAP: runInTerminal arguments are invalid" };
    }
    return this.spawnRunInTerminal(request.arguments, debuggeeProcesses);
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
    active.targetClient = targetClient;
    active.client = targetClient;
    active.unsubscribeEvents.add(
      targetClient.onEvent((event) => this.handleDapEvent(active, event)),
    );

    const initialized = targetClient.waitForEvent(
      "initialized",
      dapRequestOptions(signal, this.options.settings.timeouts.startupMs),
    );
    const capabilities = parseDapBody(
      DapCapabilitiesSchema,
      await targetClient.request(
        "initialize",
        {
          adapterID: "pwa-node",
          clientID: "pi-dap",
          clientName: "Pi DAP",
          columnsStartAt1: true,
          linesStartAt1: true,
          locale: "en-US",
          pathFormat: "path",
          supportsRunInTerminalRequest: true,
          supportsStartDebuggingRequest: false,
        },
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
    await this.applyDesiredBreakpoints(active, signal);
    if (capabilities.supportsConfigurationDoneRequest === true) {
      await targetClient.request("configurationDone", {}, dapRequestOptions(signal));
    }
    await launchResponse;
    return { success: true };
  }

  private async spawnRunInTerminal(
    argumentsValue: Static<typeof RunInTerminalArgumentsSchema>,
    debuggeeProcesses: Set<ChildProcessWithoutNullStreams>,
  ): Promise<DapReverseRequestResult> {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const [name, value] of Object.entries(argumentsValue.env ?? {})) {
      if (value === null) delete environment[name];
      else environment[name] = value;
    }
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
    const cleanup = (async () => {
      for (const unsubscribe of active.unsubscribeEvents) unsubscribe();
      active.unsubscribeEvents.clear();
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
      this.state = terminatedDapSessionState(active, cleanup, terminationReason);
    }
    this.settleExecutionWaiters();
    await cleanup;
  }

  private snapshot(): DapSessionSnapshot {
    if (this.state.kind === "idle") return { state: "idle" };
    if (this.state.kind === "terminated") {
      if (this.state.exitCode !== undefined && this.state.terminationReason !== undefined) {
        return {
          state: "terminated",
          adapterId: this.state.adapterId,
          profileId: this.state.profileId,
          exitCode: this.state.exitCode,
          terminationReason: this.state.terminationReason,
        };
      }
      if (this.state.exitCode !== undefined) {
        return {
          state: "terminated",
          adapterId: this.state.adapterId,
          profileId: this.state.profileId,
          exitCode: this.state.exitCode,
        };
      }
      if (this.state.terminationReason !== undefined) {
        return {
          state: "terminated",
          adapterId: this.state.adapterId,
          profileId: this.state.profileId,
          terminationReason: this.state.terminationReason,
        };
      }
      return {
        state: "terminated",
        adapterId: this.state.adapterId,
        profileId: this.state.profileId,
      };
    }
    const active = this.state.active;
    if (active.phase === "stopped") {
      if (active.threadId !== undefined) {
        return {
          state: "stopped",
          adapterId: active.adapter.id,
          profileId: active.profile.id,
          stopReason: active.stopReason ?? "unknown",
          threadId: active.threadId,
        };
      }
      return {
        state: "stopped",
        adapterId: active.adapter.id,
        profileId: active.profile.id,
        stopReason: active.stopReason ?? "unknown",
      };
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
