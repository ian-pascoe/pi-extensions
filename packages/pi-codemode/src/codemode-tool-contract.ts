import { Buffer } from "node:buffer";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

const CODEMODE_TOOL_NAMES = {
  execute: "codemode_execute",
  result: "codemode_result",
  cancel: "codemode_cancel",
} as const;
const RESERVED_CODEMODE_TOOL_NAMES = new Set<string>(Object.values(CODEMODE_TOOL_NAMES));

/** Reports whether a registered name belongs to CodeMode itself and must remain direct-only. */
export function isReservedCodeModeToolName(name: string): boolean {
  return RESERVED_CODEMODE_TOOL_NAMES.has(name);
}

/** Stable machine-readable failures returned in a CodeModeResult. */
export const CODEMODE_ERROR_CODES = [
  "unknown",
  "busy",
  "capacity",
  "script",
  "serialization",
  "timeout",
  "cancellation",
  "termination",
  "runtime",
] as const;

/** A stable CodeMode failure code. */
export type CodeModeErrorCode = (typeof CODEMODE_ERROR_CODES)[number];

const SessionIdSchema = Type.String({ minLength: 1 });
const ScriptSchema = Type.String();
const PositiveSafeIntegerSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});
const NonNegativeSafeIntegerSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});
const CodeModePresentationNameSchema = Type.String({ minLength: 1, maxLength: 256 });
const CodeModeNestedToolPresentationSchema = Type.Object(
  {
    name: CodeModePresentationNameSchema,
    outcome: Type.Union([
      Type.Literal("success"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
    elapsed_ms: NonNegativeSafeIntegerSchema,
  },
  { additionalProperties: false },
);

/** Strict, bounded version-one facts used to render final and partial CodeMode results. */
export const CodeModePresentationSnapshotSchema = Type.Object(
  {
    version: Type.Literal(1),
    cell_ordinal: Type.Optional(PositiveSafeIntegerSchema),
    cell_state: Type.Union([
      Type.Literal("running"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
      Type.Literal("timed_out"),
    ]),
    session_state: Type.Union([Type.Literal("live"), Type.Literal("closed")]),
    // Parent wall-clock duration of the current or settled Cell.
    elapsed_ms: NonNegativeSafeIntegerSchema,
    // Bounded active names; active_tool_count remains exact when names are omitted.
    active_tool_names: Type.Array(CodeModePresentationNameSchema, { maxItems: 32 }),
    active_tool_count: NonNegativeSafeIntegerSchema,
    // Exact totals paired with at most twenty retained per-tool summaries.
    nested_tool_count: NonNegativeSafeIntegerSchema,
    succeeded_nested_tool_count: NonNegativeSafeIntegerSchema,
    failed_nested_tool_count: NonNegativeSafeIntegerSchema,
    nested_tools: Type.Array(CodeModeNestedToolPresentationSchema, { maxItems: 20 }),
    omitted_nested_tool_count: NonNegativeSafeIntegerSchema,
    spill_path: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
  },
  { additionalProperties: false },
);

/** Schema-derived bounded presentation facts retained outside model-facing result JSON. */
export type CodeModePresentationSnapshot = Static<typeof CodeModePresentationSnapshotSchema>;

/** Strict arguments accepted by `codemode_execute`. */
export const CodeModeExecuteParametersSchema = Type.Object(
  {
    script: ScriptSchema,
    timeoutMs: Type.Optional(PositiveSafeIntegerSchema),
    wait: Type.Optional(Type.Boolean()),
    sessionId: Type.Optional(SessionIdSchema),
  },
  { additionalProperties: false },
);

/** Strict arguments accepted by `codemode_result`. */
export const CodeModeResultParametersSchema = Type.Object(
  { sessionId: SessionIdSchema },
  { additionalProperties: false },
);

/** Strict arguments accepted by `codemode_cancel`. */
export const CodeModeCancelParametersSchema = Type.Object(
  { sessionId: SessionIdSchema },
  { additionalProperties: false },
);

/** Parsed arguments for `codemode_execute`. */
export type CodeModeExecuteParameters = Static<typeof CodeModeExecuteParametersSchema>;
/** Parsed arguments for `codemode_result`. */
export type CodeModeResultParameters = Static<typeof CodeModeResultParametersSchema>;
/** Parsed arguments for `codemode_cancel`. */
export type CodeModeCancelParameters = Static<typeof CodeModeCancelParametersSchema>;

/** JSON data accepted in a successful CodeMode result. */
export type CodeModeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CodeModeJsonValue[]
  | { readonly [key: string]: CodeModeJsonValue };

/** Recursive TypeBox schema for JSON-safe CodeMode values crossing the worker boundary. */
export const CodeModeJsonValueSchema = Type.Unsafe<CodeModeJsonValue>({
  $id: "CodeModeJsonValue",
  anyOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    { type: "array", items: { $ref: "CodeModeJsonValue" } },
    {
      type: "object",
      additionalProperties: { $ref: "CodeModeJsonValue" },
    },
  ],
});

const CodeModeErrorCodeSchema = Type.Unsafe<CodeModeErrorCode>({
  type: "string",
  enum: [...CODEMODE_ERROR_CODES],
});

/** Stable error retained by a failed CodeMode result. */
export const CodeModeErrorSchema = Type.Object(
  {
    code: CodeModeErrorCodeSchema,
    message: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const CodeModeSuccessSchema = Type.Object(
  {
    result: Type.Literal("success"),
    sessionId: SessionIdSchema,
    data: Type.Optional(CodeModeJsonValueSchema),
  },
  { additionalProperties: false },
);
const CodeModePendingSchema = Type.Object(
  {
    result: Type.Literal("pending"),
    sessionId: SessionIdSchema,
  },
  { additionalProperties: false },
);
const CodeModeFailedSchema = Type.Object(
  {
    result: Type.Literal("failed"),
    sessionId: SessionIdSchema,
    error: CodeModeErrorSchema,
  },
  { additionalProperties: false },
);

/** Schema-derived result union shared by all three public CodeMode tools. */
export const CodeModeResultSchema = Type.Union([
  CodeModeSuccessSchema,
  CodeModePendingSchema,
  CodeModeFailedSchema,
]);

/** Schema-derived result returned by every public CodeMode tool. */
export type CodeModeResult = Static<typeof CodeModeResultSchema>;

const CodeModeSuccessDetailsSchema = Type.Object(
  {
    result: Type.Literal("success"),
    sessionId: SessionIdSchema,
    data: Type.Optional(CodeModeJsonValueSchema),
    presentation: Type.Optional(CodeModePresentationSnapshotSchema),
  },
  { additionalProperties: false },
);
const CodeModePendingDetailsSchema = Type.Object(
  {
    result: Type.Literal("pending"),
    sessionId: SessionIdSchema,
    presentation: Type.Optional(CodeModePresentationSnapshotSchema),
  },
  { additionalProperties: false },
);
const CodeModeFailedDetailsSchema = Type.Object(
  {
    result: Type.Literal("failed"),
    sessionId: SessionIdSchema,
    error: CodeModeErrorSchema,
    presentation: Type.Optional(CodeModePresentationSnapshotSchema),
  },
  { additionalProperties: false },
);

/** Strict final or partial tool details, including optional versioned presentation facts. */
export const CodeModeResultDetailsSchema = Type.Union([
  CodeModeSuccessDetailsSchema,
  CodeModePendingDetailsSchema,
  CodeModeFailedDetailsSchema,
]);
/** Schema-derived details retained by every public CodeMode tool. */
export type CodeModeResultDetails = Static<typeof CodeModeResultDetailsSchema>;

/** A successful result with optional JSON data. */
export function createCodeModeSuccess(sessionId: string, data?: CodeModeJsonValue): CodeModeResult {
  return data === undefined
    ? { result: "success", sessionId }
    : { result: "success", sessionId, data };
}

/** A polling result for a live Cell. */
export function createCodeModePending(sessionId: string): CodeModeResult {
  return { result: "pending", sessionId };
}

/** A stable expected failure result. */
export function createCodeModeFailure(
  sessionId: string,
  code: CodeModeErrorCode,
  message: string,
): CodeModeResult {
  return { result: "failed", sessionId, error: { code, message } };
}

/** A bounded JSON compatibility parse that never invokes getters or `toJSON`. */
export function parseCodeModeJsonValue(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This parser owns the JSON protocol boundary and refines arbitrary runtime values.
  value: unknown,
  options: { readonly allowUndefined?: boolean; readonly maxBytes?: number } = {},
):
  | { readonly ok: true; readonly value?: CodeModeJsonValue }
  | { readonly ok: false; readonly message: string } {
  const seen = new WeakSet<object>();
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Recursive inspection continues the same JSON protocol parse.
  const inspect = (candidate: unknown, path: string): CodeModeJsonValue | undefined => {
    if (candidate === null) return null;
    if (candidate === undefined) {
      if (path === "$" && options.allowUndefined === true) return undefined;
      throw new Error(`${path} must be JSON data`);
    }
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Primitive refinement is required while parsing the JSON protocol representation.
    switch (typeof candidate) {
      case "boolean":
      case "string":
        return candidate;
      case "number":
        if (!Number.isFinite(candidate)) throw new Error(`${path} must be finite`);
        return candidate;
      case "bigint":
      case "function":
      case "symbol":
      case "undefined":
        throw new Error(`${path} is not JSON data`);
      case "object":
        break;
      default:
        throw new Error(`${path} is not JSON data`);
    }

    if (seen.has(candidate)) throw new Error(`${path} is cyclic`);
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const output: CodeModeJsonValue[] = [];
        for (const key of Reflect.ownKeys(candidate)) {
          if (key === "length") continue;
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reflect.ownKeys returns strings and symbols; JSON permits only strings.
          if (typeof key !== "string") throw new Error(`${path} has a symbol property`);
          const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
          if (descriptor === undefined || !descriptor.enumerable) {
            throw new Error(`${path}.${key} is non-enumerable`);
          }
          const index = Number(key);
          if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key) {
            throw new Error(`${path}.${key} is not a JSON array index`);
          }
        }
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (descriptor === undefined || !("value" in descriptor)) {
            throw new Error(`${path}[${index}] is sparse or accessor-backed`);
          }
          const item = inspect(descriptor.value, `${path}[${index}]`);
          if (item === undefined) {
            throw new Error(`${path}[${index}] must be JSON data`);
          }
          output.push(item);
        }
        return output;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${path} must be a plain object`);
      }
      const output: Record<string, CodeModeJsonValue> = {};
      for (const key of Reflect.ownKeys(candidate)) {
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reflect.ownKeys returns strings and symbols; JSON permits only strings.
        if (typeof key !== "string") throw new Error(`${path} has a symbol property`);
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error(`${path}.${key} is non-enumerable or accessor-backed`);
        }
        const property = inspect(descriptor.value, `${path}.${key}`);
        if (property === undefined) throw new Error(`${path}.${key} must be JSON data`);
        output[key] = property;
      }
      return output;
    } finally {
      seen.delete(candidate);
    }
  };

  try {
    const parsed = inspect(value, "$");
    if (parsed === undefined && value !== undefined) {
      return { ok: false, message: "CodeMode JSON parser produced no value" };
    }
    if (options.maxBytes !== undefined) {
      const encoded = JSON.stringify(parsed);
      if (encoded !== undefined && Buffer.byteLength(encoded, "utf8") > options.maxBytes) {
        return { ok: false, message: `CodeMode JSON exceeds ${options.maxBytes} UTF-8 bytes` };
      }
    }
    return parsed === undefined ? { ok: true } : { ok: true, value: parsed };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : "CodeMode JSON is invalid",
    };
  }
}

/** Pi-only metadata accumulated by nested calls and attached to one outer terminal result. */
export type CodeModeToolOperationMetadata = {
  readonly usage?: Usage;
  readonly addedToolNames?: readonly string[];
  readonly terminate?: boolean;
};

/** One public CodeMode result plus Pi-only metadata and bounded presentation facts. */
export type CodeModeToolOperationResult = {
  readonly result: CodeModeResult;
  readonly metadata?: CodeModeToolOperationMetadata;
  readonly presentation?: CodeModePresentationSnapshot;
};

/** Operations supplied by the session coordinator to build the three Pi tools. */
export interface CodeModeToolOperations {
  execute(
    input: CodeModeExecuteParameters,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<CodeModeResultDetails> | undefined,
    context: ExtensionContext,
  ): Promise<CodeModeToolOperationResult>;
  result(input: CodeModeResultParameters): Promise<CodeModeToolOperationResult>;
  cancel(input: CodeModeCancelParameters): Promise<CodeModeToolOperationResult>;
}

function structuredCodeModeResult(
  operation: CodeModeToolOperationResult,
): AgentToolResult<CodeModeResultDetails> {
  const metadata = operation.metadata;
  const details: CodeModeResultDetails =
    operation.presentation === undefined
      ? operation.result
      : { ...operation.result, presentation: operation.presentation };
  const output: AgentToolResult<CodeModeResultDetails> = {
    content: [{ type: "text", text: JSON.stringify(operation.result) }],
    details,
  };
  if (metadata?.usage !== undefined) output.usage = metadata.usage;
  if (metadata?.addedToolNames !== undefined) {
    output.addedToolNames = [...metadata.addedToolNames];
  }
  if (metadata?.terminate !== undefined) output.terminate = metadata.terminate;
  return output;
}

type CodeModeToolDefinitions = readonly [
  ToolDefinition<typeof CodeModeExecuteParametersSchema, CodeModeResultDetails>,
  ToolDefinition<typeof CodeModeResultParametersSchema, CodeModeResultDetails>,
  ToolDefinition<typeof CodeModeCancelParametersSchema, CodeModeResultDetails>,
];

/** Creates the three stable Pi definitions while leaving admission and session policy to the coordinator. */
export function createCodeModeToolDefinitions(
  operations: CodeModeToolOperations,
  executeDescription = "Execute TypeScript in a persistent isolated Deno CodeMode Session.",
): CodeModeToolDefinitions {
  const executeTool: ToolDefinition<typeof CodeModeExecuteParametersSchema, CodeModeResultDetails> =
    {
      name: CODEMODE_TOOL_NAMES.execute,
      label: "CodeMode Execute",
      description: executeDescription,
      parameters: CodeModeExecuteParametersSchema,
      executionMode: "sequential",
      async execute(_toolCallId, input, signal, onUpdate, context) {
        return structuredCodeModeResult(await operations.execute(input, signal, onUpdate, context));
      },
    };
  const resultTool: ToolDefinition<typeof CodeModeResultParametersSchema, CodeModeResultDetails> = {
    name: CODEMODE_TOOL_NAMES.result,
    label: "CodeMode Result",
    description: "Poll a CodeMode session without consuming its latest result.",
    parameters: CodeModeResultParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, input) {
      return structuredCodeModeResult(await operations.result(input));
    },
  };
  const cancelTool: ToolDefinition<typeof CodeModeCancelParametersSchema, CodeModeResultDetails> = {
    name: CODEMODE_TOOL_NAMES.cancel,
    label: "CodeMode Cancel",
    description: "Cancel a live CodeMode session and retain its terminal result.",
    parameters: CodeModeCancelParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, input) {
      return structuredCodeModeResult(await operations.cancel(input));
    },
  };
  return [executeTool, resultTool, cancelTool];
}
