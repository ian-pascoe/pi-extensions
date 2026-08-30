import { Buffer } from "node:buffer";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  CODEMODE_CONSOLE_METHODS,
  type CodeModeConsoleEntry,
  type CodeModeConsoleMethod,
} from "./codemode-console-output.js";

const CODEMODE_TOOL_NAMES = {
  execute: "codemode_execute",
  result: "codemode_result",
  cancel: "codemode_cancel",
  sessions: "codemode_sessions",
  search: "codemode_search",
} as const;

/** Exact direct and guest name for progressive CodeMode tool declaration search. */
export const CODEMODE_SEARCH_TOOL_NAME = CODEMODE_TOOL_NAMES.search;

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
  "eviction",
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

/** Strict empty arguments accepted by the read-only `codemode_sessions` tool. */
export const CodeModeSessionsParametersSchema = Type.Object({}, { additionalProperties: false });

/** Strict arguments shared by direct and in-Cell `codemode_search`. */
export const CodeModeToolSearchParametersSchema = Type.Object(
  {
    query: Type.Optional(Type.String({ maxLength: 512 })),
    group: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    offset: Type.Optional(NonNegativeSafeIntegerSchema),
  },
  { additionalProperties: false },
);

/** Parsed arguments for `codemode_execute`. */
export type CodeModeExecuteParameters = Static<typeof CodeModeExecuteParametersSchema>;
/** Parsed arguments for `codemode_result`. */
export type CodeModeResultParameters = Static<typeof CodeModeResultParametersSchema>;
/** Parsed arguments for `codemode_cancel`. */
export type CodeModeCancelParameters = Static<typeof CodeModeCancelParametersSchema>;
/** Parsed arguments for the read-only `codemode_sessions` tool. */
export type CodeModeSessionsParameters = Static<typeof CodeModeSessionsParametersSchema>;
/** Parsed arguments shared by direct and in-Cell `codemode_search`. */
export type CodeModeToolSearchParameters = Static<typeof CodeModeToolSearchParametersSchema>;

/** A JSON object accepted in a successful CodeMode result. */
export type CodeModeJsonObject = { readonly [key: string]: CodeModeJsonValue };

/** JSON data accepted in a successful CodeMode result. */
export type CodeModeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CodeModeJsonValue[]
  | CodeModeJsonObject;

const CodeModeJsonObjectSchema = Type.Object({}, { additionalProperties: true });
const CodeModeJsonStringSchema = Type.String();

/** Refines an already-parsed CodeMode JSON value to its object arm. */
export function isCodeModeJsonObject(value: CodeModeJsonValue): value is CodeModeJsonObject {
  return Value.Check(CodeModeJsonObjectSchema, value);
}

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
const CodeModeConsoleMethodSchema = Type.Unsafe<CodeModeConsoleMethod>({
  type: "string",
  enum: [...CODEMODE_CONSOLE_METHODS],
});
const CodeModeConsoleEntrySchema = Type.Object(
  { method: CodeModeConsoleMethodSchema, text: Type.String() },
  { additionalProperties: false },
);
const CodeModeConsoleOutputSchema = Type.Array(CodeModeConsoleEntrySchema, { minItems: 1 });

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
    reclaimedSessionId: Type.Optional(SessionIdSchema),
    console: Type.Optional(CodeModeConsoleOutputSchema),
  },
  { additionalProperties: false },
);

/** One live CodeMode Session with its Unix-epoch last-activity time. */
export const CodeModeSessionListEntrySchema = Type.Object(
  {
    sessionId: SessionIdSchema,
    state: Type.Union([Type.Literal("idle"), Type.Literal("running")]),
    cellCount: NonNegativeSafeIntegerSchema,
    lastActivityAtMs: NonNegativeSafeIntegerSchema,
  },
  { additionalProperties: false },
);

/** Idle-LRU-first, then running-LRU aggregate returned by `codemode_sessions`. */
export const CodeModeSessionsResultSchema = Type.Object(
  {
    result: Type.Literal("success"),
    sessions: Type.Array(CodeModeSessionListEntrySchema),
  },
  { additionalProperties: false },
);

/** Schema-derived live Session list ordered by reclamation priority. */
export type CodeModeSessionsResult = Static<typeof CodeModeSessionsResultSchema>;

const CodeModeToolSearchItemBaseSchema = {
  name: Type.String(),
  group: Type.String(),
  description: Type.Optional(Type.String()),
};

/** One exact CodeMode tool declaration, or an explicit size-bound failure for that declaration. */
export const CodeModeToolSearchItemSchema = Type.Union([
  Type.Object(
    { ...CodeModeToolSearchItemBaseSchema, declaration: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...CodeModeToolSearchItemBaseSchema, declarationError: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);

/** Stable progressive declaration-search page shared by direct and in-Cell search. */
export const CodeModeToolSearchPageSchema = Type.Object(
  {
    items: Type.Array(CodeModeToolSearchItemSchema, { maxItems: 20 }),
    total: NonNegativeSafeIntegerSchema,
    hasMore: Type.Boolean(),
    nextOffset: Type.Union([NonNegativeSafeIntegerSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

/** Schema-derived progressive declaration-search page. */
export type CodeModeToolSearchPage = Static<typeof CodeModeToolSearchPageSchema>;

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
    console: Type.Optional(CodeModeConsoleOutputSchema),
  },
  { additionalProperties: false },
);

/** Schema-derived result union shared by the execute, result, and cancel tools. */
export const CodeModeResultSchema = Type.Union([
  CodeModeSuccessSchema,
  CodeModePendingSchema,
  CodeModeFailedSchema,
]);

/** Schema-derived result returned by one session-scoped CodeMode operation. */
export type CodeModeResult = Static<typeof CodeModeResultSchema>;

const CodeModeSuccessDetailsSchema = Type.Object(
  {
    result: Type.Literal("success"),
    sessionId: SessionIdSchema,
    data: Type.Optional(CodeModeJsonValueSchema),
    reclaimedSessionId: Type.Optional(SessionIdSchema),
    console: Type.Optional(CodeModeConsoleOutputSchema),
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
    console: Type.Optional(CodeModeConsoleOutputSchema),
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
/** Schema-derived details retained by one session-scoped CodeMode operation. */
export type CodeModeResultDetails = Static<typeof CodeModeResultDetailsSchema>;

/** A success with optional data and non-empty Cell Console output; empty Console lists are omitted. */
export function createCodeModeSuccess(
  sessionId: string,
  data?: CodeModeJsonValue,
  consoleEntries?: readonly CodeModeConsoleEntry[],
): CodeModeResult {
  const result =
    data === undefined
      ? { result: "success" as const, sessionId }
      : { result: "success" as const, sessionId, data };
  return consoleEntries === undefined || consoleEntries.length === 0
    ? result
    : { ...result, console: [...consoleEntries] };
}

/** A polling result for a live Cell. */
export function createCodeModePending(sessionId: string): CodeModeResult {
  return { result: "pending", sessionId };
}

/** A stable expected failure with non-empty Cell Console output; empty Console lists are omitted. */
export function createCodeModeFailure(
  sessionId: string,
  code: CodeModeErrorCode,
  message: string,
  consoleEntries?: readonly CodeModeConsoleEntry[],
): CodeModeResult {
  const result = { result: "failed" as const, sessionId, error: { code, message } };
  return consoleEntries === undefined || consoleEntries.length === 0
    ? result
    : { ...result, console: [...consoleEntries] };
}

/** A bounded JSON compatibility parse that never invokes getters or `toJSON`. */
export function parseCodeModeJsonValue(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Arbitrary guest values enter only through this descriptor-based parser; the hostile-values test proves accessors, proxies, functions, symbols, and cycles fail closed.
  value: unknown,
  options: {
    readonly allowUndefined?: boolean;
    readonly maxBytes?: number;
    readonly normalizeUndefinedForJsonTransport?: boolean;
  } = {},
):
  | { readonly ok: true; readonly value?: CodeModeJsonValue }
  | { readonly ok: false; readonly message: string } {
  const seen = new WeakSet<object>();
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Data descriptors recursively expose arbitrary guest values without invoking them; the hostile-values test proves this recursive boundary fails closed.
  const inspect = (candidate: unknown, path: string): CodeModeJsonValue | undefined => {
    if (candidate === null) return null;
    if (candidate === undefined) {
      if (path === "$" && options.allowUndefined === true) return undefined;
      throw new Error(`${path} must be JSON data`);
    }
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: Primitive classification avoids coercion or guest methods; the hostile-values test proves non-JSON runtime kinds fail closed.
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
          if (!Value.Check(CodeModeJsonStringSchema, key)) {
            throw new Error(`${path} has a symbol property`);
          }
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
          if (
            descriptor.value === undefined &&
            options.normalizeUndefinedForJsonTransport === true
          ) {
            output.push(null);
            continue;
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
        if (!Value.Check(CodeModeJsonStringSchema, key)) {
          throw new Error(`${path} has a symbol property`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error(`${path}.${key} is non-enumerable or accessor-backed`);
        }
        if (descriptor.value === undefined && options.normalizeUndefinedForJsonTransport === true) {
          continue;
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

/** Operations supplied by the session coordinator and catalogue to build the five Pi tools. */
export interface CodeModeToolOperations {
  execute(
    input: CodeModeExecuteParameters,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<CodeModeResultDetails> | undefined,
    context: ExtensionContext,
  ): Promise<CodeModeToolOperationResult>;
  result(input: CodeModeResultParameters): Promise<CodeModeToolOperationResult>;
  cancel(input: CodeModeCancelParameters): Promise<CodeModeToolOperationResult>;
  sessions(): Promise<CodeModeSessionsResult>;
  search(input: CodeModeToolSearchParameters): Promise<CodeModeToolSearchPage>;
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
  ToolDefinition<typeof CodeModeSessionsParametersSchema, CodeModeSessionsResult>,
  ToolDefinition<typeof CodeModeToolSearchParametersSchema, CodeModeToolSearchPage> & {
    readonly outputSchema: typeof CodeModeToolSearchPageSchema;
  },
];

function structuredCodeModeSessionsResult(
  result: CodeModeSessionsResult,
): AgentToolResult<CodeModeSessionsResult> {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    details: result,
  };
}

function structuredCodeModeToolSearchPage(
  page: CodeModeToolSearchPage,
): AgentToolResult<CodeModeToolSearchPage> {
  return {
    content: [{ type: "text", text: JSON.stringify(page) }],
    details: page,
  };
}

/** Creates the five stable Pi definitions while leaving admission and session policy to the coordinator. */
export function createCodeModeToolDefinitions(
  operations: CodeModeToolOperations,
  executeDescription = "Execute TypeScript in a persistent isolated Deno CodeMode Session.",
): CodeModeToolDefinitions {
  const executeTool: ToolDefinition<typeof CodeModeExecuteParametersSchema, CodeModeResultDetails> =
    {
      name: CODEMODE_TOOL_NAMES.execute,
      label: "CodeMode Execute",
      description: executeDescription,
      promptSnippet:
        "Batch, filter, and aggregate Pi tool calls in TypeScript with less latency and context usage.",
      promptGuidelines: [
        "Prefer codemode_execute when multiple Pi tool calls can be filtered, joined, aggregated, paginated, or used to drive later calls, or when one large result can be reduced before returning. Use direct parallel calls for a few small results needed verbatim.",
        "Return only decision-relevant CodeMode data while preserving paths, line numbers, IDs, URLs, source names, and concise evidence needed for verification.",
        "Reuse a CodeMode Session for related work. Prefer direct tools for simple one-off calls, full raw output, and confirmation-sensitive or destructive actions; use CodeMode mutations only when conditional sequencing is the point, and fall back to direct tools when the CodeMode boundary does not fit.",
      ],
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
    description: "Cancel a live CodeMode Session, free its capacity, and retain its result.",
    parameters: CodeModeCancelParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, input) {
      return structuredCodeModeResult(await operations.cancel(input));
    },
  };
  const sessionsTool: ToolDefinition<
    typeof CodeModeSessionsParametersSchema,
    CodeModeSessionsResult
  > = {
    name: CODEMODE_TOOL_NAMES.sessions,
    label: "List Sessions",
    description: "List live CodeMode Sessions without changing their recency or state.",
    parameters: CodeModeSessionsParametersSchema,
    executionMode: "sequential",
    async execute() {
      return structuredCodeModeSessionsResult(await operations.sessions());
    },
  };
  const searchTool: CodeModeToolDefinitions[4] = {
    name: CODEMODE_TOOL_NAMES.search,
    label: "Search CodeMode Tools",
    description:
      "Search CodeMode-exposed Pi tools and return exact flat names with complete TypeScript declarations.",
    parameters: CodeModeToolSearchParametersSchema,
    outputSchema: CodeModeToolSearchPageSchema,
    async execute(_toolCallId, input) {
      return structuredCodeModeToolSearchPage(await operations.search(input));
    },
  };
  return [executeTool, resultTool, cancelTool, sessionsTool, searchTool];
}
