import { resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type AgentToolResult,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type {
  DapEvaluateInput,
  DapLaunchInput,
  DapSession,
  DapSessionResult,
  DapStackInput,
  DapVariablesInput,
} from "./dap-session.js";
import type { DapSessionFiles } from "./dap-session-files.js";

const NonEmptyStringSchema = Type.String({ minLength: 1 });
const DapIdSchema = Type.Integer({ minimum: 0 });
const EmptyOperationSchema = <TOperation extends string>(operation: TOperation) =>
  Type.Object({ operation: Type.Literal(operation) }, { additionalProperties: false });

const LaunchParametersSchema = Type.Object(
  {
    operation: Type.Literal("launch"),
    profile: Type.Optional(NonEmptyStringSchema),
    program: Type.Optional(NonEmptyStringSchema),
    args: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);
const SetBreakpointsParametersSchema = Type.Object(
  {
    operation: Type.Literal("set_breakpoints"),
    file_path: NonEmptyStringSchema,
    breakpoints: Type.Array(
      Type.Object(
        {
          line: Type.Integer({ minimum: 1 }),
          condition: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const StackParametersSchema = Type.Object(
  {
    operation: Type.Literal("stack"),
    thread_id: Type.Optional(DapIdSchema),
    start: Type.Optional(Type.Integer({ minimum: 0 })),
    count: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
const VariablesPageSchema = {
  start: Type.Optional(Type.Integer({ minimum: 0 })),
  count: Type.Optional(Type.Integer({ minimum: 1 })),
};
const VariablesParametersSchema = Type.Union([
  Type.Object(
    {
      operation: Type.Literal("variables"),
      frame_id: DapIdSchema,
      ...VariablesPageSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("variables"),
      variables_reference: DapIdSchema,
      ...VariablesPageSchema,
    },
    { additionalProperties: false },
  ),
]);
const EvaluateParametersSchema = Type.Object(
  {
    operation: Type.Literal("evaluate"),
    expression: NonEmptyStringSchema,
    frame_id: Type.Optional(DapIdSchema),
  },
  { additionalProperties: false },
);

/** Strict model-facing contract for the package's twelve DAP operations. */
export const DapToolParametersSchema = Type.Union([
  LaunchParametersSchema,
  SetBreakpointsParametersSchema,
  EmptyOperationSchema("continue"),
  EmptyOperationSchema("next"),
  EmptyOperationSchema("step_in"),
  EmptyOperationSchema("step_out"),
  EmptyOperationSchema("pause"),
  StackParametersSchema,
  VariablesParametersSchema,
  EvaluateParametersSchema,
  EmptyOperationSchema("status"),
  EmptyOperationSchema("stop"),
]);

/** Parsed input for one invocation of the strict `dap` tool. */
export type DapToolParameters = Static<typeof DapToolParametersSchema>;

const DapStateSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("launching"),
  Type.Literal("running"),
  Type.Literal("stopped"),
  Type.Literal("terminated"),
]);
const DapOperationSchema = Type.Union([
  Type.Literal("launch"),
  Type.Literal("set_breakpoints"),
  Type.Literal("continue"),
  Type.Literal("next"),
  Type.Literal("step_in"),
  Type.Literal("step_out"),
  Type.Literal("pause"),
  Type.Literal("stack"),
  Type.Literal("variables"),
  Type.Literal("evaluate"),
  Type.Literal("status"),
  Type.Literal("stop"),
]);

/** Structured, runtime-validated details returned with every successful DAP operation. */
export const DapToolResultDetailsSchema = Type.Object(
  {
    operation: DapOperationSchema,
    state: DapStateSchema,
    adapter_id: Type.Optional(NonEmptyStringSchema),
    profile_id: Type.Optional(NonEmptyStringSchema),
    stop_reason: Type.Optional(Type.String()),
    thread_id: Type.Optional(DapIdSchema),
    stack_frame_ids: Type.Optional(Type.Array(DapIdSchema)),
    exit_code: Type.Optional(Type.Integer()),
    output_discarded_bytes: Type.Integer({ minimum: 0 }),
    output_truncated: Type.Boolean(),
    spill_path: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

/** Validated metadata accompanying one successful DAP tool result. */
export type DapToolResultDetails = Static<typeof DapToolResultDetailsSchema>;

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

function toolResultDetails(
  operation: DapToolParameters["operation"],
  result: DapSessionResult,
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
): Promise<AgentToolResult<DapToolResultDetails>> {
  const text = formatDapToolResult(operation, result);
  const details = toolResultDetails(operation, result);
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
      let input: DapLaunchInput = {};
      if (parameters.profile !== undefined) input = { ...input, profile: parameters.profile };
      if (parameters.program !== undefined) {
        input = { ...input, program: resolve(cwd, parameters.program) };
      }
      if (parameters.args !== undefined) input = { ...input, args: parameters.args };
      if (parameters.cwd !== undefined) input = { ...input, cwd: resolve(cwd, parameters.cwd) };
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
      let input: DapStackInput = {};
      if (parameters.thread_id !== undefined) input = { ...input, threadId: parameters.thread_id };
      if (parameters.start !== undefined) input = { ...input, start: parameters.start };
      if (parameters.count !== undefined) input = { ...input, count: parameters.count };
      return session.stack(input, signal);
    }
    case "variables": {
      let page: Pick<DapVariablesInput, "start" | "count"> = {};
      if (parameters.start !== undefined) page = { ...page, start: parameters.start };
      if (parameters.count !== undefined) page = { ...page, count: parameters.count };
      return "frame_id" in parameters
        ? session.variables({ ...page, frameId: parameters.frame_id }, signal)
        : session.variables(
            { ...page, variablesReference: parameters.variables_reference },
            signal,
          );
    }
    case "evaluate": {
      let input: DapEvaluateInput = { expression: parameters.expression };
      if (parameters.frame_id !== undefined) input = { ...input, frameId: parameters.frame_id };
      return session.evaluate(input, signal);
    }
    case "status":
      return session.status();
    case "stop":
      return session.stop();
  }
}

/** Create the single strict Pi DAP ToolDefinition bound to current session resources. */
export function createDapToolDefinition(
  getRuntime: () => DapToolRuntime | undefined,
): ToolDefinition<typeof DapToolParametersSchema, DapToolResultDetails> {
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
    async execute(_toolCallId, input, signal, _onUpdate, context) {
      const parameters = parseDapToolParameters(input);
      const runtime = getRuntime();
      if (runtime === undefined) throw piDapError("Pi conversation session is not active");
      try {
        const result = await dispatchDapOperation(parameters, runtime.session, context.cwd, signal);
        return await createDapToolOutput(parameters.operation, result, runtime.sessionFiles);
      } catch (cause) {
        throw piDapError(cause);
      }
    },
  };
}

/** Register exactly one strict `dap` tool whose runtime follows Pi session reloads. */
export function registerDapTool(
  pi: Pick<ExtensionAPI, "registerTool">,
  getRuntime: () => DapToolRuntime | undefined,
): void {
  pi.registerTool(createDapToolDefinition(getRuntime));
}
