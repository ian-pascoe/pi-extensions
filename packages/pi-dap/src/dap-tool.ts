import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  defineTool,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type Theme,
  type ToolAnnotations,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { DapProtocolClientError } from "./dap-protocol-client.js";
import {
  DapSessionError,
  type DapEvaluateInput,
  type DapLaunchInput,
  type DapSession,
  type DapSessionResult,
  type DapSessionSnapshot,
  type DapStackInput,
  type DapVariablesInput,
} from "./dap-session.js";
import type { DapSessionFiles } from "./dap-session-files.js";
import {
  DapEvaluateParametersSchema,
  DapLaunchParametersSchema,
  DapNoParametersSchema,
  DapSetBreakpointsParametersSchema,
  DapStackParametersSchema,
  DapToolOutputSchemas,
  DapToolResultDetailsSchema,
  DapVariablesParametersSchema,
  DapVariablesStrictParametersSchema,
  type DapExecutionWaitOperation,
  type DapOperation,
  type DapPresentationDetails,
  type DapToolOutput,
  type DapToolParameters,
  type DapToolRenderDetails,
  type DapToolResultDetails,
} from "./dap-tool-contract.js";
import { renderDapToolCall, renderDapToolResult } from "./dap-tool-rendering.js";
import { formatDapToolText, visibleDapText } from "./dap-tool-text.js";
import { TROUBLESHOOTING_HINT } from "./troubleshooting-skill.js";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

type DapToolResult = AgentToolResult<DapToolRenderDetails | undefined>;

type DapToolSession = Pick<
  DapSession,
  | "launch"
  | "setBreakpoints"
  | "continue"
  | "next"
  | "stepIn"
  | "stepOut"
  | "pause"
  | "stack"
  | "variables"
  | "evaluate"
  | "status"
  | "stop"
  | "snapshot"
>;

/** Session-scoped resources resolved at execution time so Pi reloads replace settings safely. */
export interface DapToolRuntime {
  /** Active Debug Session owner for this Pi conversation session. */
  readonly session: DapToolSession;
  /** Private Result Spill storage owned by the same Pi conversation session. */
  readonly sessionFiles: DapSessionFiles;
  /** Non-authoritative Observer UI hooks for tool presentation context. */
  readonly observer?: DapToolObserver;
}

/** Narrow Observer UI dependency that cannot dispatch Debug Adapter requests. */
export interface DapToolObserver {
  /** Record explicit tool arguments before execution begins. */
  onToolStart(parameters: DapToolParameters): void;
  /** Record one successful operation and its already-returned Debug Session result. */
  onToolSuccess(parameters: DapToolParameters, result: DapSessionResult): void;
  /** Record one failed operation without changing its error. */
  onToolFailure(parameters: DapToolParameters, error: Error): void;
}

/**
 * Namespace shared by every DAP tool; codemode lists the tools under it. `instructions` exists only
 * in Pi 1.0.0's `ToolNamespace`: there, codemode's `describeNamespace()` returns it and `tool_search`
 * ranks with it. The object is deliberately untyped so it also type-checks against 0.99.0, whose
 * `ToolNamespace` lacks the field and would reject it as an excess property in a typed literal.
 */
export const DAP_TOOL_NAMESPACE = {
  name: "dap",
  description:
    "Debug one program through one configured Debug Session (Debug Adapter Protocol): breakpoints, execution control, and stopped-state inspection.",
  instructions: [
    "Every dap_* tool acts on the same single Debug Session of this Pi session. dap_launch fails while one is active; dap_stop ends it.",
    "Relative paths resolve from Pi's project directory.",
    "Desired Breakpoints set with dap_set_breakpoints apply to the active Debug Session and to every later launch.",
    "dap_launch, dap_continue, dap_next, dap_step_in, and dap_step_out wait until the Debuggee stops, exits, or the execution timeout passes; after a timeout the state is running, so use dap_pause or dap_stop.",
    "dap_stack, dap_variables, and dap_evaluate need a stopped Debuggee. Stack Frame ids from dap_stack feed dap_variables and dap_evaluate; a non-zero variables_reference lists child values with dap_variables, and dap_variables with frame_id lists expensive scopes such as Global without expanding them.",
    "Each successful call drains unread Debuggee output. Text results are limited to 2,000 lines or 50 KB and save the complete result as a Result Spill; script results carry complete data (a frame's expensive scopes stay unexpanded).",
    "A call that fails because of the Debug Session state returns the current state with an error field instead of throwing.",
  ].join("\n"),
};

const DAP_PROMPT_GUIDELINE =
  "Use the dap_* tools to set source breakpoints, launch one configured Debug Session, control the Debuggee, and inspect stopped Stack Frames and variables. Relative paths resolve from the project directory.";

function piDapError(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(message.startsWith("Pi DAP:") ? message : `Pi DAP: ${message}`, { cause });
}

function isCancelledProtocolError(cause: unknown): boolean {
  return cause instanceof DapProtocolClientError && cause.kind === "cancelled";
}

/** Configuration, adapter, protocol, and timeout failures are diagnosed by the Skill; state errors and adapter-rejected requests are not. */
function needsTroubleshootingHint(cause: unknown): boolean {
  if (cause instanceof DapSessionError) {
    return cause.kind !== "state" && !isCancelledProtocolError(cause.cause);
  }
  return (
    cause instanceof DapProtocolClientError &&
    cause.kind !== "cancelled" &&
    cause.kind !== "request"
  );
}

/** Strict ingress parser for one tool's arguments, run before permission hooks and again at execution. */
function dapArgumentsParser<TParameters extends TSchema>(schema: TParameters) {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Pi arguments are validated against each tool's strict schema at ingress.
  return (input: unknown): Static<TParameters> => {
    if (Value.Check(schema, input)) return Value.Parse(schema, input);
    const [first] = Value.Errors(schema, input);
    const location = first?.instancePath ? first.instancePath : "arguments";
    // A `false` schema is how a strict object rejects an unknown property.
    const reason =
      first === undefined
        ? "arguments do not match the tool's schema"
        : `${location} ${first.keyword === "boolean" ? "is not allowed" : first.message}`;
    throw piDapError(`invalid tool arguments: ${reason}`);
  };
}

function isDapExecutionWaitOperation(
  operation: DapOperation,
): operation is DapExecutionWaitOperation {
  return (
    operation === "launch" ||
    operation === "continue" ||
    operation === "next" ||
    operation === "step_in" ||
    operation === "step_out"
  );
}

function boundedDapPresentationText(value: string): string {
  if (value.length <= 500) return value;
  const end = value.charCodeAt(498) >= 0xd800 && value.charCodeAt(498) <= 0xdbff ? 498 : 499;
  return `${value.slice(0, end)}…`;
}

function dapVariablePresentation(result: DapSessionResult): DapPresentationDetails | undefined {
  const rows: Extract<DapPresentationDetails, { kind: "variables" }>["rows"][number][] = [];
  let totalRows = 0;
  const appendVariable = (
    variable: NonNullable<DapSessionResult["variables"]>[number],
    group?: string,
  ) => {
    totalRows++;
    if (rows.length >= 20) return;
    const row: Extract<
      Extract<DapPresentationDetails, { kind: "variables" }>["rows"][number],
      { kind: "variable" }
    > = {
      kind: "variable",
      name: boundedDapPresentationText(variable.name),
      value: boundedDapPresentationText(variable.value),
      variables_reference: variable.variablesReference,
    };
    if (group !== undefined) row.group = boundedDapPresentationText(group);
    if (variable.type !== undefined) row.type = boundedDapPresentationText(variable.type);
    rows.push(row);
  };
  if (result.variableGroups !== undefined) {
    for (const group of result.variableGroups) {
      totalRows++;
      if (rows.length < 20) {
        rows.push({
          kind: "group",
          name: boundedDapPresentationText(group.scope.name),
          variables_reference: group.scope.variablesReference,
          expensive: group.scope.expensive,
        });
      }
      for (const variable of group.variables ?? []) appendVariable(variable, group.scope.name);
    }
  } else if (result.variables !== undefined) {
    for (const variable of result.variables) appendVariable(variable);
  } else {
    return undefined;
  }
  return { kind: "variables", rows, omitted_count: Math.max(0, totalRows - rows.length) };
}

function dapPresentationDetails(result: DapSessionResult): DapPresentationDetails | undefined {
  if (result.breakpoints !== undefined) {
    return {
      kind: "breakpoints",
      rows: result.breakpoints.slice(0, 20).map((breakpoint) => {
        const row: Extract<DapPresentationDetails, { kind: "breakpoints" }>["rows"][number] = {
          verified: breakpoint.verified,
        };
        if (breakpoint.id !== undefined) row.id = breakpoint.id;
        if (breakpoint.message !== undefined) {
          row.message = boundedDapPresentationText(breakpoint.message);
        }
        if (breakpoint.line !== undefined) row.line = breakpoint.line;
        if (breakpoint.source?.name !== undefined) {
          row.source_name = boundedDapPresentationText(breakpoint.source.name);
        }
        if (breakpoint.source?.path !== undefined) {
          row.source_path = boundedDapPresentationText(breakpoint.source.path);
        }
        return row;
      }),
      omitted_count: Math.max(0, result.breakpoints.length - 20),
    };
  }
  if (result.stackFrames !== undefined) {
    const totalCount = result.totalFrames ?? result.stackFrames.length;
    return {
      kind: "stack_frames",
      rows: result.stackFrames.slice(0, 20).map((frame) => {
        const row: Extract<DapPresentationDetails, { kind: "stack_frames" }>["rows"][number] = {
          id: frame.id,
          name: boundedDapPresentationText(frame.name),
          line: frame.line,
          column: frame.column,
        };
        if (frame.source?.name !== undefined) {
          row.source_name = boundedDapPresentationText(frame.source.name);
        }
        if (frame.source?.path !== undefined) {
          row.source_path = boundedDapPresentationText(frame.source.path);
        }
        return row;
      }),
      total_count: totalCount,
      omitted_count: Math.max(0, totalCount - Math.min(20, result.stackFrames.length)),
    };
  }
  const variables = dapVariablePresentation(result);
  if (variables !== undefined) return variables;
  if (result.evaluation === undefined) return undefined;
  const evaluation: Extract<DapPresentationDetails, { kind: "evaluation" }> = {
    kind: "evaluation",
    value: boundedDapPresentationText(result.evaluation.result),
    variables_reference: result.evaluation.variablesReference,
  };
  if (result.evaluation.type !== undefined) {
    evaluation.type = boundedDapPresentationText(result.evaluation.type);
  }
  return evaluation;
}

/** Snake-case lifecycle fields shared by Observer UI details and script-facing results. */
interface DapSnapshotFields {
  state: DapSessionSnapshot["state"];
  adapter_id?: string;
  profile_id?: string;
  stop_reason?: string;
  thread_id?: number;
  exit_code?: number;
  termination_reason?: string;
}

function snapshotFields(snapshot: DapSessionSnapshot): DapSnapshotFields {
  const fields: DapSnapshotFields = { state: snapshot.state };
  if ("adapterId" in snapshot) fields.adapter_id = snapshot.adapterId;
  if ("profileId" in snapshot) fields.profile_id = snapshot.profileId;
  if (snapshot.state === "stopped") {
    fields.stop_reason = snapshot.stopReason;
    if (snapshot.threadId !== undefined) fields.thread_id = snapshot.threadId;
  }
  if (snapshot.state === "terminated") {
    if (snapshot.exitCode !== undefined) fields.exit_code = snapshot.exitCode;
    if (snapshot.terminationReason !== undefined) {
      fields.termination_reason = snapshot.terminationReason;
    }
  }
  return fields;
}

function toolResultDetails(
  operation: DapOperation,
  result: DapSessionResult,
  executionWaitCancelled: boolean,
): DapToolResultDetails {
  const details: DapToolResultDetails = {
    operation,
    ...snapshotFields(result.snapshot),
    output_discarded_bytes: result.discardedOutputBytes,
    output_truncated: result.discardedOutputBytes > 0,
  };
  if (result.stackFrames !== undefined) {
    details.stack_frame_ids = result.stackFrames.map((frame) => frame.id);
  }
  const presentation =
    executionWaitCancelled && isDapExecutionWaitOperation(operation)
      ? { kind: "execution_wait" as const, operation, cancelled: true as const }
      : dapPresentationDetails(result);
  if (presentation !== undefined) details.presentation = presentation;
  return Value.Parse(DapToolResultDetailsSchema, details);
}

type DapBaseOutput = DapToolOutput<"status">;
type DapStopOutput = Pick<
  DapToolOutput<"status">,
  "stop_description" | "hit_breakpoint_ids" | "top_frame"
>;
type DapVariableOutput = NonNullable<DapToolOutput<"variables">["variables"]>[number];
type DapSourceOutput = Pick<
  DapVariableOutput & { source_name?: string; source_path?: string },
  "source_name" | "source_path"
>;

function sourceOutput(
  source: { readonly name?: string; readonly path?: string } | undefined,
): DapSourceOutput {
  const fields: DapSourceOutput = {};
  if (source?.name !== undefined) fields.source_name = source.name;
  if (source?.path !== undefined) fields.source_path = source.path;
  return fields;
}

function variableOutput(
  variable: NonNullable<DapSessionResult["variables"]>[number],
): DapVariableOutput {
  const row: DapVariableOutput = {
    name: variable.name,
    value: variable.value,
    variables_reference: variable.variablesReference,
  };
  if (variable.type !== undefined) row.type = variable.type;
  if (variable.evaluateName !== undefined) row.evaluate_name = variable.evaluateName;
  return row;
}

/** Why and where the Debuggee stopped, in the script-facing shape; empty unless it is stopped. */
function stopOutput(result: DapSessionResult): DapStopOutput {
  const fields: DapStopOutput = {};
  const stop = result.stop;
  if (stop?.description !== undefined) fields.stop_description = stop.description;
  if (stop?.hitBreakpointIds !== undefined) fields.hit_breakpoint_ids = [...stop.hitBreakpointIds];
  if (stop?.topFrame !== undefined) {
    fields.top_frame = {
      id: stop.topFrame.id,
      name: stop.topFrame.name,
      line: stop.topFrame.line,
      column: stop.topFrame.column,
      ...sourceOutput(stop.topFrame.source),
    };
  }
  return fields;
}

/** Fields every script-facing result carries: state, drained Debuggee output, Desired Breakpoints. */
function baseOutput(result: DapSessionResult): DapBaseOutput {
  return {
    ...snapshotFields(result.snapshot),
    output: result.output,
    output_discarded_bytes: result.discardedOutputBytes,
    desired_breakpoints: result.desiredBreakpoints.map((file) => ({
      file_path: file.filePath,
      breakpoints: file.breakpoints.map((breakpoint) =>
        breakpoint.condition === undefined
          ? { line: breakpoint.line }
          : { line: breakpoint.line, condition: breakpoint.condition },
      ),
    })),
  };
}

/**
 * Complete script-facing result of one operation: every row, full values, and all drained Debuggee
 * output. It carries only the fields the operation's output schema declares.
 */
function toolOutput(
  operation: DapOperation,
  result: DapSessionResult,
  executionWaitCancelled: boolean,
  warnings: readonly string[],
): DapToolOutput {
  const base = baseOutput(result);
  switch (operation) {
    case "launch":
    case "continue":
    case "next":
    case "step_in":
    case "step_out": {
      const output = { ...base, ...stopOutput(result) };
      return executionWaitCancelled ? { ...output, execution_wait_cancelled: true } : output;
    }
    case "set_breakpoints": {
      const output: DapToolOutput<"set_breakpoints"> = { ...base };
      if (warnings.length > 0) output.warnings = [...warnings];
      return result.breakpoints === undefined
        ? output
        : {
            ...output,
            breakpoints: result.breakpoints.map((breakpoint) => {
              const row: NonNullable<DapToolOutput<"set_breakpoints">["breakpoints"]>[number] = {
                verified: breakpoint.verified,
                ...sourceOutput(breakpoint.source),
              };
              if (breakpoint.id !== undefined) row.id = breakpoint.id;
              if (breakpoint.message !== undefined) row.message = breakpoint.message;
              if (breakpoint.line !== undefined) row.line = breakpoint.line;
              if (breakpoint.column !== undefined) row.column = breakpoint.column;
              return row;
            }),
          };
    }
    case "stack":
      return result.stackFrames === undefined
        ? base
        : {
            ...base,
            stack_frames: result.stackFrames.map((frame) => ({
              id: frame.id,
              name: frame.name,
              line: frame.line,
              column: frame.column,
              ...sourceOutput(frame.source),
            })),
            total_frames: result.totalFrames ?? result.stackFrames.length,
          };
    case "variables": {
      const output: DapToolOutput<"variables"> = { ...base };
      if (result.variableGroups !== undefined) {
        output.scopes = result.variableGroups.map(({ scope, variables }) => {
          const row: NonNullable<DapToolOutput<"variables">["scopes"]>[number] = {
            name: scope.name,
            variables_reference: scope.variablesReference,
            expensive: scope.expensive,
          };
          if (variables !== undefined) row.variables = variables.map(variableOutput);
          return row;
        });
      }
      if (result.variables !== undefined) output.variables = result.variables.map(variableOutput);
      return output;
    }
    case "evaluate": {
      if (result.evaluation === undefined) return base;
      const evaluation: NonNullable<DapToolOutput<"evaluate">["evaluation"]> = {
        result: result.evaluation.result,
        variables_reference: result.evaluation.variablesReference,
      };
      if (result.evaluation.type !== undefined) evaluation.type = result.evaluation.type;
      return { ...base, evaluation };
    }
    case "pause":
    case "status":
      return { ...base, ...stopOutput(result) };
    case "stop":
      return base;
  }
}

async function createDapToolOutput(
  operation: DapOperation,
  result: DapSessionResult,
  sessionFiles: DapSessionFiles,
  cwd: string,
  executionWaitCancelled: boolean,
  warnings: readonly string[],
): Promise<DapToolResult> {
  const text = formatDapToolText({ operation, result, cwd, executionWaitCancelled, warnings });
  const details = toolResultDetails(operation, result, executionWaitCancelled);
  const structuredContent = toolOutput(operation, result, executionWaitCancelled, warnings);
  const visible = visibleDapText(text);
  if (!visible.truncated) {
    return { content: [{ type: "text", text }], details, structuredContent };
  }

  const spillPath = await sessionFiles.writeResultSpill(text);
  const normalizedDetails = Value.Parse(DapToolResultDetailsSchema, {
    ...details,
    output_truncated: true,
    spill_path: spillPath,
  });
  return {
    content: [
      {
        type: "text",
        text: `${visible.text}\n\n[Pi DAP: output truncated; complete Result Spill: ${spillPath}]`,
      },
    ],
    details: normalizedDetails,
    structuredContent,
  };
}

/** A Debug Session state failure still reports the current state, without draining output. */
function stateFailureResult(error: Error, snapshot: DapSessionSnapshot): DapToolResult {
  const state = snapshotFields(snapshot);
  return {
    content: [{ type: "text", text: `${error.message}\nDebug Session: ${JSON.stringify(state)}` }],
    details: undefined,
    structuredContent: { ...state, error: error.message },
    isError: true,
  };
}

/** A Desired Breakpoint can precede its source file, but it cannot bind until a file exists. */
async function sourceFileWarnings(filePath: string): Promise<readonly string[]> {
  try {
    if ((await stat(filePath)).isFile()) return [];
    return [`not a file: ${filePath}; breakpoints will not bind`];
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? String(cause.code) : "unknown";
    return code === "ENOENT"
      ? [`file not found: ${filePath}; breakpoints will not bind until it exists`]
      : [`could not check ${filePath}: ${code}`];
  }
}

interface DapDispatch {
  readonly result: DapSessionResult;
  readonly warnings: readonly string[];
}

async function dispatchDapOperation(
  parameters: DapToolParameters,
  session: DapToolSession,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<DapDispatch> {
  if (parameters.operation !== "set_breakpoints") {
    return {
      result: await dispatchSessionOperation(parameters, session, cwd, signal),
      warnings: [],
    };
  }
  const filePath = resolve(cwd, parameters.file_path);
  const result = await session.setBreakpoints(
    { filePath, breakpoints: parameters.breakpoints },
    signal,
  );
  const warnings = parameters.breakpoints.length === 0 ? [] : await sourceFileWarnings(filePath);
  return { result, warnings };
}

async function dispatchSessionOperation(
  parameters: Exclude<DapToolParameters, { readonly operation: "set_breakpoints" }>,
  session: DapToolSession,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<DapSessionResult> {
  switch (parameters.operation) {
    case "launch": {
      const input: Mutable<DapLaunchInput> = {};
      if (parameters.profile !== undefined) input.profile = parameters.profile;
      if (parameters.program !== undefined) input.program = resolve(cwd, parameters.program);
      if (parameters.args !== undefined) input.args = parameters.args;
      if (parameters.cwd !== undefined) input.cwd = resolve(cwd, parameters.cwd);
      return session.launch(input, signal);
    }
    case "continue":
      return session.continue(signal);
    case "next":
      return session.next(signal);
    case "step_in":
      return session.stepIn(signal);
    case "step_out":
      return session.stepOut(signal);
    case "pause":
      return session.pause(signal);
    case "stack": {
      const input: Mutable<DapStackInput> = {};
      if (parameters.thread_id !== undefined) input.threadId = parameters.thread_id;
      if (parameters.start !== undefined) input.start = parameters.start;
      if (parameters.count !== undefined) input.count = parameters.count;
      return session.stack(input, signal);
    }
    case "variables": {
      const page: Mutable<Pick<DapVariablesInput, "start" | "count">> = {};
      if (parameters.start !== undefined) page.start = parameters.start;
      if (parameters.count !== undefined) page.count = parameters.count;
      return "frame_id" in parameters
        ? session.variables({ ...page, frameId: parameters.frame_id }, signal)
        : session.variables(
            { ...page, variablesReference: parameters.variables_reference },
            signal,
          );
    }
    case "evaluate": {
      // oxlint-disable-next-line anti-slop/no-known-value-widening -- SAFETY: Mutable retains the exact evaluation input fields, permitting optional frame assignment during construction only.
      const input: Mutable<DapEvaluateInput> = { expression: parameters.expression };
      if (parameters.frame_id !== undefined) input.frameId = parameters.frame_id;
      return session.evaluate(input, signal);
    }
    case "status":
      return session.status();
    case "stop":
      return session.stop();
  }
}

function notifyDapToolObserver(operation: () => void): void {
  try {
    operation();
  } catch {
    // Observer UI failures cannot change model-facing Debug Session behavior.
  }
}

async function executeDapOperation(
  parameters: DapToolParameters,
  runtime: DapToolRuntime | undefined,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<DapToolRenderDetails | undefined> | undefined,
): Promise<DapToolResult> {
  if (runtime === undefined) throw piDapError("Pi conversation session is not active");
  notifyDapToolObserver(() => runtime.observer?.onToolStart(parameters));
  const operation = parameters.operation;
  const waits = isDapExecutionWaitOperation(operation);
  const startedAt = Date.now();
  const updateProgress = () => {
    if (!isDapExecutionWaitOperation(operation)) return;
    onUpdate?.({
      content: [{ type: "text", text: `${operation} waiting` }],
      details: { kind: "progress", operation, elapsed_ms: Date.now() - startedAt },
    });
  };
  updateProgress();
  const progressInterval = waits ? setInterval(updateProgress, 1_000) : undefined;
  progressInterval?.unref?.();
  try {
    const { result, warnings } = await dispatchDapOperation(
      parameters,
      runtime.session,
      cwd,
      signal,
    );
    const output = await createDapToolOutput(
      operation,
      result,
      runtime.sessionFiles,
      cwd,
      waits && signal?.aborted === true && result.snapshot.state !== "stopped",
      warnings,
    );
    notifyDapToolObserver(() => runtime.observer?.onToolSuccess(parameters, result));
    return output;
  } catch (cause) {
    const error = piDapError(cause);
    notifyDapToolObserver(() => runtime.observer?.onToolFailure(parameters, error));
    if (cause instanceof DapSessionError && cause.kind === "state") {
      return stateFailureResult(error, runtime.session.snapshot());
    }
    throw needsTroubleshootingHint(cause)
      ? new Error(`${error.message}\n\n${TROUBLESHOOTING_HINT}`, { cause })
      : error;
  } finally {
    if (progressInterval !== undefined) clearInterval(progressInterval);
  }
}

type DapToolDefinition<TParameters extends TSchema> = ToolDefinition<
  TParameters,
  DapToolRenderDetails | undefined
>;

/** Fields every DAP tool shares: naming, namespace, typed script result, ordering, and rendering. */
function dapToolCommon(operation: DapOperation, label: string) {
  return {
    name: `dap_${operation}`,
    label,
    promptGuidelines: [DAP_PROMPT_GUIDELINE],
    outputSchema: DapToolOutputSchemas[operation],
    namespace: DAP_TOOL_NAMESPACE,
    // Every tool acts on the one Debug Session, so batched calls must keep their order.
    executionMode: "sequential" as const,
    renderResult: (
      result: DapToolResult,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: { readonly isError: boolean; readonly cwd: string },
    ) => renderDapToolResult(result, options, theme, context.isError, context.cwd),
  };
}

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** Runs Debuggee code, whose side effects reach beyond Pi DAP: launching, resuming, or evaluating. */
const RUNS_DEBUGGEE_CODE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
const EXECUTION_WAIT =
  "and wait until the Debuggee stops, exits, or the execution timeout passes (then it is still running).";
const STATE_FAILURE =
  "A call the Debug Session state does not allow returns an error result with the current `state`.";

type DapNoParametersOperation = Extract<
  DapToolParameters,
  { readonly operation: "continue" | "next" | "step_in" | "step_out" | "pause" | "status" | "stop" }
>["operation"];

const parseNoParameters = dapArgumentsParser(DapNoParametersSchema);
const parseLaunchParameters = dapArgumentsParser(DapLaunchParametersSchema);
const parseSetBreakpointsParameters = dapArgumentsParser(DapSetBreakpointsParametersSchema);
const parseStackParameters = dapArgumentsParser(DapStackParametersSchema);
const parseVariablesParameters = dapArgumentsParser(DapVariablesStrictParametersSchema);
const parseEvaluateParameters = dapArgumentsParser(DapEvaluateParametersSchema);

function createNoParametersTool(
  operation: DapNoParametersOperation,
  label: string,
  description: string,
  annotations: ToolAnnotations,
  getRuntime: () => DapToolRuntime | undefined,
): DapToolDefinition<typeof DapNoParametersSchema> {
  return defineTool<typeof DapNoParametersSchema, DapToolRenderDetails | undefined>({
    ...dapToolCommon(operation, label),
    description,
    exposure: "direct",
    annotations,
    parameters: DapNoParametersSchema,
    prepareArguments: parseNoParameters,
    renderCall: (_arguments, theme, context) =>
      renderDapToolCall({ operation }, theme, context.expanded, context.cwd),
    execute: async (_toolCallId, input, signal, onUpdate, context) =>
      executeDapOperation(
        { operation, ...parseNoParameters(input) },
        getRuntime(),
        context.cwd,
        signal,
        onUpdate,
      ),
  });
}

/**
 * Create one strict Pi tool per DAP operation, each bound to current session resources. Every
 * tool is `direct` (ADR-0002).
 */
export function createDapToolDefinitions(getRuntime: () => DapToolRuntime | undefined) {
  return [
    defineTool<typeof DapLaunchParametersSchema, DapToolRenderDetails | undefined>({
      ...dapToolCommon("launch", "DAP launch"),
      description: `Start a Debug Session from a Launch Profile ${EXECUTION_WAIT} The profile may be omitted only when exactly one valid Launch Profile exists; program, args, and cwd replace the profile's arguments. Fails while a Debug Session is active. ${STATE_FAILURE}`,
      promptSnippet: "Debug a program through one configured Debug Session",
      exposure: "direct",
      annotations: RUNS_DEBUGGEE_CODE,
      parameters: DapLaunchParametersSchema,
      prepareArguments: parseLaunchParameters,
      renderCall: (input, theme, context) =>
        renderDapToolCall({ ...input, operation: "launch" }, theme, context.expanded, context.cwd),
      execute: async (_toolCallId, input, signal, onUpdate, context) =>
        executeDapOperation(
          { operation: "launch", ...parseLaunchParameters(input) },
          getRuntime(),
          context.cwd,
          signal,
          onUpdate,
        ),
    }),
    defineTool<typeof DapSetBreakpointsParametersSchema, DapToolRenderDetails | undefined>({
      ...dapToolCommon("set_breakpoints", "DAP set breakpoints"),
      description:
        "Replace the Desired Breakpoints of one source file; lines are one-based and [] clears the file. They apply to the active Debug Session and to every later launch. A breakpoint condition runs as Debuggee code.",
      exposure: "direct",
      annotations: { ...RUNS_DEBUGGEE_CODE, idempotentHint: true },
      parameters: DapSetBreakpointsParametersSchema,
      prepareArguments: parseSetBreakpointsParameters,
      renderCall: (input, theme, context) =>
        renderDapToolCall(
          { ...input, operation: "set_breakpoints" },
          theme,
          context.expanded,
          context.cwd,
        ),
      execute: async (_toolCallId, input, signal, onUpdate, context) =>
        executeDapOperation(
          { operation: "set_breakpoints", ...parseSetBreakpointsParameters(input) },
          getRuntime(),
          context.cwd,
          signal,
          onUpdate,
        ),
    }),
    createNoParametersTool(
      "continue",
      "DAP continue",
      `Resume the stopped Debuggee ${EXECUTION_WAIT} ${STATE_FAILURE}`,
      RUNS_DEBUGGEE_CODE,
      getRuntime,
    ),
    createNoParametersTool(
      "next",
      "DAP step over",
      `Step the stopped Debuggee over the current line ${EXECUTION_WAIT} ${STATE_FAILURE}`,
      RUNS_DEBUGGEE_CODE,
      getRuntime,
    ),
    createNoParametersTool(
      "step_in",
      "DAP step in",
      `Step the stopped Debuggee into the call on the current line ${EXECUTION_WAIT} ${STATE_FAILURE}`,
      RUNS_DEBUGGEE_CODE,
      getRuntime,
    ),
    createNoParametersTool(
      "step_out",
      "DAP step out",
      `Run the stopped Debuggee until the current function returns ${EXECUTION_WAIT} ${STATE_FAILURE}`,
      RUNS_DEBUGGEE_CODE,
      getRuntime,
    ),
    createNoParametersTool(
      "pause",
      "DAP pause",
      `Pause the running Debuggee, for example after an execution wait timed out, and wait for it to stop. ${STATE_FAILURE}`,
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      getRuntime,
    ),
    defineTool<typeof DapStackParametersSchema, DapToolRenderDetails | undefined>({
      ...dapToolCommon("stack", "DAP stack"),
      description: `List Stack Frames of the stopped Debuggee. Defaults to the stopped thread, start 0, and count 20. ${STATE_FAILURE}`,
      exposure: "direct",
      annotations: READ_ONLY,
      parameters: DapStackParametersSchema,
      prepareArguments: parseStackParameters,
      renderCall: (input, theme, context) =>
        renderDapToolCall({ ...input, operation: "stack" }, theme, context.expanded, context.cwd),
      execute: async (_toolCallId, input, signal, onUpdate, context) =>
        executeDapOperation(
          { operation: "stack", ...parseStackParameters(input) },
          getRuntime(),
          context.cwd,
          signal,
          onUpdate,
        ),
    }),
    defineTool<typeof DapVariablesParametersSchema, DapToolRenderDetails | undefined>({
      ...dapToolCommon("variables", "DAP variables"),
      description: `List variables of the stopped Debuggee. Exactly one of frame_id (the scopes of a Stack Frame; expensive scopes such as Global are listed but not expanded) or variables_reference (children of a value or of an unexpanded scope) is required, never both; start and count (default 100) page each list. ${STATE_FAILURE}`,
      exposure: "direct",
      annotations: READ_ONLY,
      parameters: DapVariablesParametersSchema,
      prepareArguments: parseVariablesParameters,
      renderCall: (input, theme, context) =>
        renderDapToolCall(
          { ...input, operation: "variables" },
          theme,
          context.expanded,
          context.cwd,
        ),
      execute: async (_toolCallId, input, signal, onUpdate, context) =>
        executeDapOperation(
          { operation: "variables", ...parseVariablesParameters(input) },
          getRuntime(),
          context.cwd,
          signal,
          onUpdate,
        ),
    }),
    defineTool<typeof DapEvaluateParametersSchema, DapToolRenderDetails | undefined>({
      ...dapToolCommon("evaluate", "DAP evaluate"),
      description: `Evaluate an expression in the stopped Debuggee, in frame_id or the top Stack Frame. The expression runs as Debuggee code and can change its state. ${STATE_FAILURE}`,
      exposure: "direct",
      annotations: RUNS_DEBUGGEE_CODE,
      parameters: DapEvaluateParametersSchema,
      prepareArguments: parseEvaluateParameters,
      renderCall: (input, theme, context) =>
        renderDapToolCall(
          { ...input, operation: "evaluate" },
          theme,
          context.expanded,
          context.cwd,
        ),
      execute: async (_toolCallId, input, signal, onUpdate, context) =>
        executeDapOperation(
          { operation: "evaluate", ...parseEvaluateParameters(input) },
          getRuntime(),
          context.cwd,
          signal,
          onUpdate,
        ),
    }),
    createNoParametersTool(
      "status",
      "DAP status",
      "Report the Debug Session state and drain unread Debuggee output without changing the Debuggee.",
      READ_ONLY,
      getRuntime,
    ),
    createNoParametersTool(
      "stop",
      "DAP stop",
      "End the Debug Session and terminate its Debuggee. Desired Breakpoints remain for the next launch. Safe to repeat.",
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      getRuntime,
    ),
  ];
}
