import type { RecallOptions, SearchOptions, SearchResultItem } from "@byterover/brv-bridge";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
import type { ByteRoverBridge, ByteRoverBridgeFactory } from "./byterover-bridge.js";
import { stripEchoedRecallQuery } from "./recall.js";

export type RegisterManualToolsInput = {
  pi: ByteRoverManualToolHost;
  bridge: ByteRoverBridge;
  createBridge: ByteRoverBridgeFactory;
};

/** Runtime context read by manually invoked ByteRover tools. */
export interface ByteRoverManualToolContext {
  cwd: string;
}

const RecallParameters = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      pattern: "\\S",
      description: "Raw recall query.",
    }),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Optional recall timeout in milliseconds for this memory query.",
      }),
    ),
  },
  { additionalProperties: false },
);

type RecallParameters = Static<typeof RecallParameters>;

const SearchParameters = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      pattern: "\\S",
      description: "Raw search query.",
    }),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        description: "Maximum number of results to return, from 1 to 50.",
      }),
    ),
    scope: Type.Optional(
      Type.String({
        minLength: 1,
        pattern: "\\S",
        description: "Optional ByteRover path prefix to scope search results.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Optional search timeout in milliseconds for this memory lookup.",
      }),
    ),
  },
  { additionalProperties: false },
);

type SearchParameters = Static<typeof SearchParameters>;

const PersistParameters = Type.Object(
  {
    context: Type.String({
      minLength: 1,
      pattern: "\\S",
      description: "Raw memory text to persist.",
    }),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Optional persist timeout in milliseconds for this memory write.",
      }),
    ),
  },
  { additionalProperties: false },
);

type PersistParameters = Static<typeof PersistParameters>;

const ManualToolOutputSchema = Type.Undefined();

type ManualToolDefinition<TName extends string, TParams extends TSchema> = Omit<
  ToolDefinition<TParams, undefined>,
  "name" | "execute"
> & {
  name: TName;
  outputSchema: typeof ManualToolOutputSchema;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<undefined> | undefined,
    context: ByteRoverManualToolContext,
  ): Promise<AgentToolResult<undefined>>;
};

/** A ByteRover tool definition whose execution context exposes only the working directory. */
export type ByteRoverManualToolDefinition =
  | ManualToolDefinition<"brv_recall", typeof RecallParameters>
  | ManualToolDefinition<"brv_search", typeof SearchParameters>
  | ManualToolDefinition<"brv_persist", typeof PersistParameters>;

/** Lists the three registered manual-memory tool names. */
export const BYTE_ROVER_MANUAL_TOOL_NAMES = ["brv_recall", "brv_search", "brv_persist"] as const;

/** Narrows any tool definition to one of the three ByteRover manual tools by name. */
export const isByteRoverManualToolDefinition = (tool: {
  readonly name: string;
}): tool is ByteRoverManualToolDefinition =>
  // SAFETY: widening the const tuple to readonly string[] only relaxes literal checking for includes().
  (BYTE_ROVER_MANUAL_TOOL_NAMES as readonly string[]).includes(tool.name);

/** Registers ByteRover manual tools with Pi or a faithful recording host. */
export interface ByteRoverManualToolHost {
  registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = unknown>(
    tool: ToolDefinition<TParams, TDetails, TState> & { outputSchema?: TSchema },
  ): void;
}

const textResult = (text: string): AgentToolResult<undefined> => ({
  content: [{ type: "text", text }],
  details: undefined,
});

export const formatSearchResults = (
  results: readonly SearchResultItem[],
  totalFound: number,
  message: string,
) => {
  if (results.length === 0) return message || "No ByteRover search results found.";

  const header = `Found ${totalFound} ByteRover ${totalFound === 1 ? "result" : "results"}.`;
  const lines = results.flatMap((result, index) => {
    const details = [
      `score: ${result.score}`,
      result.symbolKind ? `kind: ${result.symbolKind}` : undefined,
      result.backlinkCount === undefined ? undefined : `backlinks: ${result.backlinkCount}`,
    ].filter(Boolean);
    const output = [
      `${index + 1}. ${result.title} (${result.path})`,
      details.length > 0 ? `   ${details.join(", ")}` : undefined,
      `   ${result.excerpt}`,
    ];
    if (result.relatedPaths && result.relatedPaths.length > 0) {
      output.push(`   related: ${result.relatedPaths.join(", ")}`);
    }
    return output.filter((line) => line !== undefined);
  });

  return [header, ...lines].join("\n");
};

/** Registers the three public ByteRover manual-memory tools against the extension host. */
export const registerManualTools = ({
  pi,
  bridge,
  createBridge,
}: Omit<RegisterManualToolsInput, "config">) => {
  // ponytail: the session-start caller gates on config.manualTools before reaching this registration.
  pi.registerTool({
    name: "brv_recall",
    label: "ByteRover Recall",
    description: "Recall relevant context from ByteRover memory for a raw query.",
    parameters: RecallParameters,
    outputSchema: ManualToolOutputSchema,
    execute: async (_toolCallId, params: RecallParameters, signal, _onUpdate, ctx) => {
      const query = params.query.trim();

      try {
        if (!(await bridge.ready())) return textResult("ByteRover bridge is not ready.");

        const recallBridge =
          params.timeoutMs === undefined
            ? bridge
            : createBridge({ cwd: ctx.cwd, recallTimeoutMs: params.timeoutMs });
        const recallOptions: RecallOptions = { cwd: ctx.cwd };
        if (signal !== undefined) recallOptions.signal = signal;
        const brvResult = await recallBridge.recall(query, recallOptions);
        const content = stripEchoedRecallQuery(brvResult.content, query);
        return textResult(content || "No relevant ByteRover context found.");
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        return textResult(`ByteRover recall failed: ${error.message}`);
      }
    },
  });

  pi.registerTool({
    name: "brv_search",
    label: "ByteRover Search",
    description: "Search ByteRover memory for ranked file-level context results.",
    parameters: SearchParameters,
    outputSchema: ManualToolOutputSchema,
    execute: async (_toolCallId, params: SearchParameters, _signal, _onUpdate, ctx) => {
      const query = params.query.trim();

      try {
        if (!(await bridge.ready())) return textResult("ByteRover bridge is not ready.");

        const searchOptions: SearchOptions = { cwd: ctx.cwd };
        if (params.limit !== undefined) searchOptions.limit = params.limit;
        if (params.scope !== undefined) searchOptions.scope = params.scope.trim();
        const searchBridge =
          params.timeoutMs === undefined
            ? bridge
            : createBridge({ cwd: ctx.cwd, searchTimeoutMs: params.timeoutMs });
        const brvResult = await searchBridge.search(query, searchOptions);
        return textResult(
          formatSearchResults(brvResult.results, brvResult.totalFound, brvResult.message),
        );
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        return textResult(`ByteRover search failed: ${error.message}`);
      }
    },
  });

  pi.registerTool({
    name: "brv_persist",
    label: "ByteRover Persist",
    description: "Persist raw memory text into ByteRover without automatic curation wrapping.",
    parameters: PersistParameters,
    outputSchema: ManualToolOutputSchema,
    execute: async (_toolCallId, params: PersistParameters, _signal, _onUpdate, ctx) => {
      const memory = params.context.trim();

      try {
        const persistBridge =
          params.timeoutMs === undefined
            ? bridge
            : createBridge({
                cwd: ctx.cwd,
                persistTimeoutMs: params.timeoutMs,
              });
        const brvResult = await persistBridge.persist(memory, {
          cwd: ctx.cwd,
          detach: true,
        });
        const suffix = brvResult.message ? `: ${brvResult.message}` : "";
        return textResult(`ByteRover persist ${brvResult.status}${suffix}`);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        return textResult(`ByteRover persist failed: ${error.message}`);
      }
    },
  });
};
