import { resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type AgentToolResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type {
  DapEvaluateInput,
  DapLaunchInput,
  DapSession,
  DapSessionResult,
  DapStackInput,
} from "./dap-session.js";
import type { DapSessionFiles } from "./dap-session-files.js";
import {
  DapToolParametersSchema,
  DapToolResultDetailsSchema,
  type DapPresentationDetails,
  type DapToolParameters,
  type DapToolRenderDetails,
  type DapToolResultDetails,
} from "./dap-tool-contract.js";
import { renderDapToolCall, renderDapToolResult } from "./dap-tool-rendering.js";

type DapToolDefinition = ToolDefinition<typeof DapToolParametersSchema, DapToolRenderDetails> & {
  readonly outputSchema: typeof DapToolResultDetailsSchema;
};

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

function piDapError(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(message.startsWith("Pi DAP:") ? message : `Pi DAP: ${message}`, { cause });
}

function parseDapToolParameters(input: DapToolParameters): DapToolParameters {
  try {
    return Value.Parse(DapToolParametersSchema, input);
  } catch (cause) {
    throw piDapError(
      `invalid tool arguments: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function isDapExecutionWaitOperation(
  operation: DapToolParameters["operation"],
): operation is "launch" | "continue" | "next" | "step_in" | "step_out" {
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
      for (const variable of group.variables) appendVariable(variable, group.scope.name);
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

function toolResultDetails(
  operation: DapToolParameters["operation"],
  result: DapSessionResult,
  executionWaitCancelled: boolean,
): DapToolResultDetails {
  const snapshot = result.snapshot;
  const details: DapToolResultDetails = {
    operation,
    state: snapshot.state,
    output_discarded_bytes: result.discardedOutputBytes,
    output_truncated: result.discardedOutputBytes > 0,
  };
  if ("adapterId" in snapshot) details.adapter_id = snapshot.adapterId;
  if ("profileId" in snapshot) details.profile_id = snapshot.profileId;
  if (snapshot.state === "stopped") details.stop_reason = snapshot.stopReason;
  if (snapshot.state === "stopped" && snapshot.threadId !== undefined) {
    details.thread_id = snapshot.threadId;
  }
  if (result.stackFrames !== undefined) {
    details.stack_frame_ids = result.stackFrames.map((frame) => frame.id);
  }
  if (snapshot.state === "terminated" && snapshot.exitCode !== undefined) {
    details.exit_code = snapshot.exitCode;
  }
  if (snapshot.state === "terminated" && snapshot.terminationReason !== undefined) {
    details.termination_reason = snapshot.terminationReason;
  }
  const presentation =
    executionWaitCancelled && isDapExecutionWaitOperation(operation)
      ? { kind: "execution_wait" as const, operation, cancelled: true as const }
      : dapPresentationDetails(result);
  if (presentation !== undefined) details.presentation = presentation;
  return Value.Parse(DapToolResultDetailsSchema, details);
}

function formatDapToolResult(
  operation: DapToolParameters["operation"],
  result: DapSessionResult,
): string {
  const { output, ...summary } = result;
  const heading = `DAP ${operation}: ${JSON.stringify(summary)}`;
  if (output.length === 0) return heading;
  const discardNotice =
    result.discardedOutputBytes === 0
      ? ""
      : ` (${result.discardedOutputBytes} older bytes discarded)`;
  return `${heading}\n\nDebuggee output${discardNotice}:\n${output}`;
}

async function createDapToolOutput(
  operation: DapToolParameters["operation"],
  result: DapSessionResult,
  sessionFiles: DapSessionFiles,
  executionWaitCancelled: boolean,
): Promise<AgentToolResult<DapToolResultDetails>> {
  const text = formatDapToolResult(operation, result);
  const details = toolResultDetails(operation, result, executionWaitCancelled);
  const truncation = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) return { content: [{ type: "text", text }], details };

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
        text: `${truncation.content}\n\n[Pi DAP: output truncated; complete Result Spill: ${spillPath}]`,
      },
    ],
    details: normalizedDetails,
  };
}

async function dispatchDapOperation(
  parameters: DapToolParameters,
  session: DapToolSession,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<DapSessionResult> {
  switch (parameters.operation) {
    case "launch": {
      const input: DapLaunchInput = {
        ...(parameters.profile !== undefined && { profile: parameters.profile }),
        ...(parameters.program !== undefined && {
          program: resolve(cwd, parameters.program),
        }),
        ...(parameters.args !== undefined && { args: parameters.args }),
        ...(parameters.cwd !== undefined && { cwd: resolve(cwd, parameters.cwd) }),
      };
      return session.launch(input, signal);
    }
    case "set_breakpoints":
      return session.setBreakpoints(
        { filePath: resolve(cwd, parameters.file_path), breakpoints: parameters.breakpoints },
        signal,
      );
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
      const input: DapStackInput = {
        ...(parameters.thread_id !== undefined && { threadId: parameters.thread_id }),
        ...(parameters.start !== undefined && { start: parameters.start }),
        ...(parameters.count !== undefined && { count: parameters.count }),
      };
      return session.stack(input, signal);
    }
    case "variables": {
      const page = {
        ...(parameters.start !== undefined && { start: parameters.start }),
        ...(parameters.count !== undefined && { count: parameters.count }),
      };
      return "frame_id" in parameters
        ? session.variables({ ...page, frameId: parameters.frame_id }, signal)
        : session.variables(
            { ...page, variablesReference: parameters.variables_reference },
            signal,
          );
    }
    case "evaluate": {
      const input: DapEvaluateInput = {
        expression: parameters.expression,
        ...(parameters.frame_id !== undefined && { frameId: parameters.frame_id }),
      };
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

/** Create the single strict Pi DAP ToolDefinition bound to current session resources. */
export function createDapToolDefinition(
  getRuntime: () => DapToolRuntime | undefined,
): DapToolDefinition {
  return {
    name: "dap",
    label: "DAP",
    description:
      "Launch and inspect one configured Debug Session through the Debug Adapter Protocol. Paths are relative to Pi's project directory. Output is limited to 2,000 lines or 50 KB; complete truncated output is saved as a Result Spill.",
    promptSnippet: "Debug a program through one configured Debug Session",
    promptGuidelines: [
      "Use dap to set source breakpoints, launch a configured Debug Session, control the Debuggee, and inspect stopped Stack Frames and variables.",
    ],
    parameters: DapToolParametersSchema,
    outputSchema: DapToolResultDetailsSchema,
    renderCall: (argumentsValue, theme, context) =>
      renderDapToolCall(argumentsValue, theme, context.expanded, context.cwd),
    renderResult: (result, options, theme, context) =>
      renderDapToolResult(result, options, theme, context.isError, context.cwd),
    async execute(_toolCallId, input, signal, onUpdate, context) {
      const parameters = parseDapToolParameters(input);
      const runtime = getRuntime();
      if (runtime === undefined) throw piDapError("Pi conversation session is not active");
      notifyDapToolObserver(() => runtime.observer?.onToolStart(parameters));
      const startedAt = Date.now();
      const updateProgress = () => {
        if (!isDapExecutionWaitOperation(parameters.operation)) return;
        onUpdate?.({
          content: [{ type: "text", text: `${parameters.operation} waiting` }],
          details: {
            kind: "progress",
            operation: parameters.operation,
            elapsed_ms: Date.now() - startedAt,
          },
        });
      };
      updateProgress();
      const progressInterval = isDapExecutionWaitOperation(parameters.operation)
        ? setInterval(updateProgress, 1_000)
        : undefined;
      progressInterval?.unref?.();
      try {
        const result = await dispatchDapOperation(parameters, runtime.session, context.cwd, signal);
        const output = await createDapToolOutput(
          parameters.operation,
          result,
          runtime.sessionFiles,
          isDapExecutionWaitOperation(parameters.operation) && signal?.aborted === true,
        );
        notifyDapToolObserver(() => runtime.observer?.onToolSuccess(parameters, result));
        return output;
      } catch (cause) {
        const error = piDapError(cause);
        notifyDapToolObserver(() => runtime.observer?.onToolFailure(parameters, error));
        throw error;
      } finally {
        if (progressInterval !== undefined) clearInterval(progressInterval);
      }
    },
  };
}
