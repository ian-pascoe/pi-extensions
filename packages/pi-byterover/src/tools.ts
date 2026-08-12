import type { BrvBridge, SearchResultItem } from "@byterover/brv-bridge";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { ConfigSchema } from "./config.js";
import { stripEchoedRecallQuery } from "./recall.js";

type Config = ReturnType<typeof ConfigSchema.parse>;

type BridgeOverride = {
  cwd?: string;
  searchTimeoutMs?: number;
  recallTimeoutMs?: number;
  persistTimeoutMs?: number;
};

export type RegisterManualToolsInput = {
  pi: ExtensionAPI;
  bridge: BrvBridge;
  config: Config;
  createBridge: (override?: BridgeOverride) => BrvBridge;
};

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

const textResult = (text: string): AgentToolResult<undefined> => ({
  content: [{ type: "text", text }],
  details: undefined,
});

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const formatSearchResults = (
  results: Array<SearchResultItem>,
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

export const registerManualTools = ({
  pi,
  bridge,
  config,
  createBridge,
}: RegisterManualToolsInput) => {
  if (!config.manualTools) return;

  pi.registerTool({
    name: "brv_recall",
    label: "ByteRover Recall",
    description: "Recall relevant context from ByteRover memory for a raw query.",
    parameters: RecallParameters,
    execute: async (_toolCallId, params: RecallParameters, signal, _onUpdate, ctx) => {
      const query = params.query.trim();

      try {
        if (!(await bridge.ready())) return textResult("ByteRover bridge is not ready.");

        const recallBridge =
          params.timeoutMs === undefined
            ? bridge
            : createBridge({ cwd: ctx.cwd, recallTimeoutMs: params.timeoutMs });
        const brvResult = await recallBridge.recall(query, {
          cwd: ctx.cwd,
          ...(signal === undefined ? {} : { signal }),
        });
        const content = stripEchoedRecallQuery(brvResult.content, query);
        return textResult(content || "No relevant ByteRover context found.");
      } catch (error) {
        return textResult(`ByteRover recall failed: ${errorMessage(error)}`);
      }
    },
  });

  pi.registerTool({
    name: "brv_search",
    label: "ByteRover Search",
    description: "Search ByteRover memory for ranked file-level context results.",
    parameters: SearchParameters,
    execute: async (_toolCallId, params: SearchParameters, _signal, _onUpdate, ctx) => {
      const query = params.query.trim();

      try {
        if (!(await bridge.ready())) return textResult("ByteRover bridge is not ready.");

        const searchOptions = {
          cwd: ctx.cwd,
          ...(params.limit === undefined ? {} : { limit: params.limit }),
          ...(params.scope === undefined ? {} : { scope: params.scope.trim() }),
        };
        const searchBridge =
          params.timeoutMs === undefined
            ? bridge
            : createBridge({ cwd: ctx.cwd, searchTimeoutMs: params.timeoutMs });
        const brvResult = await searchBridge.search(query, searchOptions);
        return textResult(
          formatSearchResults(brvResult.results, brvResult.totalFound, brvResult.message),
        );
      } catch (error) {
        return textResult(`ByteRover search failed: ${errorMessage(error)}`);
      }
    },
  });

  pi.registerTool({
    name: "brv_persist",
    label: "ByteRover Persist",
    description: "Persist raw memory text into ByteRover without automatic curation wrapping.",
    parameters: PersistParameters,
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
      } catch (error) {
        return textResult(`ByteRover persist failed: ${errorMessage(error)}`);
      }
    },
  });
};
