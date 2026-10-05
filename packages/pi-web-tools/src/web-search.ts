import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  cancelResponse,
  describeWebFailure,
  readBoundedResponseBody,
  requestSignal,
  WebHttpStatusError,
  WebInputError,
  type WebFailure,
} from "./web-response.js";
import { TROUBLESHOOTING_HINT } from "./troubleshooting-skill.js";
import { renderWebSearchToolCall, renderWebSearchToolResult } from "./web-tool-rendering.js";
import { createWebToolOutput, WebToolTruncationDetailsSchema } from "./web-tool-output.js";

const DEFAULT_EXA_URL = "https://mcp.exa.ai/mcp";
const DEFAULT_PARALLEL_URL = "https://search.parallel.ai/mcp";
const MAX_SEARCH_RESPONSE_BYTES = 256 * 1024;
const NO_SEARCH_RESULTS = "No search results found. Please try a different query.";
const MAX_PROVIDER_MESSAGE_CHARACTERS = 500;
const EXA_RATE_LIMITED_META = "ai.exa/rateLimited";

/** Total Web Search request budget, including response reading. */
export const WEB_SEARCH_TIMEOUT_MS = 25_000;

const SearchProviderSchema = Type.Union([Type.Literal("exa"), Type.Literal("parallel")]);

/** Hosted Search Provider selected deterministically for one Pi session. */
export type SearchProvider = Static<typeof SearchProviderSchema>;

const redactedWebSearchApiKey = Symbol("RedactedWebSearchApiKey");

/** API key whose raw value may only be revealed while constructing provider transport data. */
export type RedactedWebSearchApiKey = {
  readonly [redactedWebSearchApiKey]: true;
  /** Reveal the key only at the final provider request boundary. */
  readonly reveal: () => string;
  /** Keep accidental JSON diagnostics redacted. */
  readonly toJSON: () => "[REDACTED]";
};

/** Wrap an environment API key before it enters Web Search composition. */
export function redactWebSearchApiKey(value: string): RedactedWebSearchApiKey {
  return Object.freeze({
    [redactedWebSearchApiKey]: true as const,
    reveal: () => value,
    toJSON: () => "[REDACTED]" as const,
  });
}

/** Native transport and hosted endpoints used by a Web Search definition. */
export type WebSearchToolOptions = {
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly exaUrl?: string | undefined;
  readonly parallelUrl?: string | undefined;
  readonly exaApiKey?: RedactedWebSearchApiKey | undefined;
  readonly parallelApiKey?: RedactedWebSearchApiKey | undefined;
};

/** Runtime contract for model-invisible Web Search execution metadata. */
export const WebSearchDetailsSchema = Type.Object(
  {
    provider: SearchProviderSchema,
    truncation: Type.Optional(WebToolTruncationDetailsSchema),
  },
  { additionalProperties: false },
);

/** Model-invisible Web Search execution metadata. */
export type WebSearchDetails = Static<typeof WebSearchDetailsSchema>;

/**
 * JSON Schema of the `structuredContent` codemode scripts receive instead of the model-facing text.
 * `content` is the Search Provider's complete text answer (at most 256 KiB), which is free-form
 * rather than a result list; `full_output_path` is present when the model saw it truncated.
 */
export const WebSearchOutputSchema = Type.Object(
  {
    provider: SearchProviderSchema,
    content: Type.String({ description: "Search Provider's complete text answer" }),
    full_output_path: Type.Optional(
      Type.String({ description: "Private file with the full text" }),
    ),
  },
  { additionalProperties: false },
);

/** Value a codemode script receives from Web Search. */
export type WebSearchOutput = Static<typeof WebSearchOutputSchema>;

const WEB_SEARCH_PARAMETERS = Type.Object(
  {
    query: Type.String({ description: "Web Search query" }),
    numResults: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 20,
        default: 8,
        description: "Number of results (default: 8, maximum: 20)",
      }),
    ),
    livecrawl: Type.Optional(
      StringEnum(["fallback", "preferred"] as const, {
        default: "fallback",
        description: "Live crawl mode (default: fallback)",
      }),
    ),
    type: Type.Optional(
      StringEnum(["auto", "fast", "deep"] as const, {
        default: "auto",
        description: "Search type (default: auto)",
      }),
    ),
    contextMaxCharacters: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50_000,
        description: "Maximum model context characters (effective default: 10000)",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Validated arguments accepted by Web Search execution and Transcript Presentation. */
export type WebSearchParameters = Static<typeof WEB_SEARCH_PARAMETERS>;

const MCP_RESPONSE_SCHEMA = Type.Object(
  {
    result: Type.Optional(
      Type.Object(
        {
          content: Type.Optional(
            Type.Array(
              Type.Object(
                { type: Type.String(), text: Type.Optional(Type.String()) },
                { additionalProperties: true },
              ),
            ),
          ),
          isError: Type.Optional(Type.Boolean()),
          _meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        },
        { additionalProperties: true },
      ),
    ),
    error: Type.Optional(
      Type.Object(
        {
          code: Type.Optional(Type.Number()),
          message: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const WEB_SEARCH_DESCRIPTION =
  "Discover current public web information using Exa or Parallel. Results are textual and model-visible output is truncated to 50 KiB or 2,000 lines, with complete output saved to a private temporary file.";

type ExaSearchArguments = {
  query: string;
  type: "auto" | "fast" | "deep";
  numResults: number;
  livecrawl: "fallback" | "preferred";
  contextMaxCharacters?: number;
};

type SearchRequestHeaders = {
  Accept: string;
  "Content-Type": string;
  "User-Agent"?: string;
  Authorization?: string;
};

type SearchProviderRequest = {
  readonly url: string;
  readonly headers: SearchRequestHeaders;
  readonly body: {
    readonly jsonrpc: "2.0";
    readonly id: 1;
    readonly method: "tools/call";
    readonly params:
      | { readonly name: "web_search_exa"; readonly arguments: ExaSearchArguments }
      | {
          readonly name: "web_search";
          readonly arguments: {
            readonly objective: string;
            readonly search_queries: string[];
            readonly session_id: string;
          };
        };
  };
};

function fnv1aChecksum(content: string): string | undefined {
  if (content.length === 0) return undefined;
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Select Exa or Parallel with OpenCode's stable FNV-1a checksum parity. */
export function selectSearchProvider(sessionId: string): SearchProvider {
  const checksum = fnv1aChecksum(sessionId);
  return Number.parseInt(checksum ?? "0", 36) % 2 === 0 ? "exa" : "parallel";
}

/** A failure the Search Provider itself reported, carrying its own message. */
class SearchProviderError extends Error {
  readonly diagnosable: boolean;

  constructor(message: string, diagnosable = false) {
    super(message);
    this.name = "SearchProviderError";
    this.diagnosable = diagnosable;
  }
}

function providerName(provider: SearchProvider): string {
  return provider === "exa" ? "Exa" : "Parallel";
}

/** Collapse whitespace and cap a provider message so it stays one short line. */
function boundProviderMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_PROVIDER_MESSAGE_CHARACTERS
    ? `${collapsed.slice(0, MAX_PROVIDER_MESSAGE_CHARACTERS)}…`
    : collapsed;
}

function firstText(content: readonly { type: string; text?: string | undefined }[] | undefined) {
  return content?.find(({ type, text }) => type === "text" && text !== undefined && text.length > 0)
    ?.text;
}

/** Return provider text, throw a provider failure, or return undefined when a payload has neither. */
function parseMcpPayload(payload: string, provider: SearchProvider): string | undefined {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) return undefined;
  const parsed: unknown = JSON.parse(trimmed);
  const response = Value.Parse(MCP_RESPONSE_SCHEMA, parsed);
  const name = providerName(provider);
  if (response.error !== undefined) {
    const code = response.error.code === undefined ? "" : ` ${response.error.code}`;
    const detail = boundProviderMessage(response.error.message ?? "");
    throw new SearchProviderError(
      `${name} returned error${code}${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  if (response.result === undefined) {
    throw new SearchProviderError(`${name} returned an unrecognized response`);
  }
  const text = firstText(response.result.content);
  if (response.result._meta?.[EXA_RATE_LIMITED_META] === true) {
    // An API key lifts the free-tier limit, so the troubleshooting Skill can help.
    throw new SearchProviderError(
      `${name} rate limit reached${text === undefined ? "" : `: ${boundProviderMessage(text)}`}`,
      true,
    );
  }
  if (response.result.isError === true) {
    throw new SearchProviderError(
      `${name} reported an error${text === undefined ? "" : `: ${boundProviderMessage(text)}`}`,
    );
  }
  return text;
}

function parseMcpResponse(body: string, provider: SearchProvider): string | undefined {
  const trimmed = body.trim();
  const payloads = trimmed.startsWith("{")
    ? [trimmed]
    : body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6));
  for (const payload of payloads) {
    const text = parseMcpPayload(payload, provider);
    if (text !== undefined) return text;
  }
  return undefined;
}

function exaEndpoint(baseUrl: string, apiKey: RedactedWebSearchApiKey | undefined): string {
  if (apiKey === undefined) return baseUrl;
  const url = new URL(baseUrl);
  url.searchParams.set("exaApiKey", apiKey.reveal());
  return url.toString();
}

async function callSearchProvider(
  provider: SearchProvider,
  sessionId: string,
  parameters: WebSearchParameters,
  options: WebSearchToolOptions,
  signal: AbortSignal,
): Promise<string> {
  let request: SearchProviderRequest;
  if (provider === "exa") {
    const arguments_: ExaSearchArguments = {
      query: parameters.query,
      type: parameters.type ?? "auto",
      numResults: parameters.numResults ?? 8,
      livecrawl: parameters.livecrawl ?? "fallback",
    };
    if (parameters.contextMaxCharacters !== undefined) {
      arguments_.contextMaxCharacters = parameters.contextMaxCharacters;
    }
    request = {
      url: exaEndpoint(options.exaUrl ?? DEFAULT_EXA_URL, options.exaApiKey),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "web_search_exa", arguments: arguments_ },
      },
    };
  } else {
    const headers: SearchRequestHeaders = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "User-Agent": "pi-web-tools",
    };
    if (options.parallelApiKey !== undefined) {
      headers.Authorization = `Bearer ${options.parallelApiKey.reveal()}`;
    }
    request = {
      url: options.parallelUrl ?? DEFAULT_PARALLEL_URL,
      headers,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search",
          arguments: {
            objective: parameters.query,
            search_queries: [parameters.query],
            session_id: sessionId,
          },
        },
      },
    };
  }

  const response = await (options.fetch ?? globalThis.fetch)(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal,
  });
  if (!response.ok) {
    await cancelResponse(response);
    throw new WebHttpStatusError(response.status);
  }

  const body = await readBoundedResponseBody(response, MAX_SEARCH_RESPONSE_BYTES, signal);
  try {
    return parseMcpResponse(new TextDecoder().decode(body), provider) ?? NO_SEARCH_RESULTS;
  } catch (error) {
    if (error instanceof SearchProviderError) {
      throw new SearchProviderError(redactApiKeys(error.message, options), error.diagnosable);
    }
    throw new SearchProviderError(`${providerName(provider)} returned an unrecognized response`);
  }
}

/** Remove configured API keys, raw or URL-encoded, from text a Search Provider echoed back. */
function redactApiKeys(message: string, options: WebSearchToolOptions): string {
  let redacted = message;
  for (const key of [options.exaApiKey, options.parallelApiKey]) {
    const secret = key?.reveal();
    if (secret === undefined || secret === "") continue;
    for (const variant of new Set([secret, encodeURIComponent(secret)])) {
      redacted = redacted.replaceAll(variant, "[REDACTED]");
    }
  }
  return redacted;
}

function unableToSearch(query: string | undefined, failure: WebFailure): Error {
  const subject =
    query === undefined ? "Unable to search the web" : `Unable to search the web for ${query}`;
  const message = `${subject}: ${failure.cause}`;
  return new Error(failure.diagnosable ? `${message}\n\n${TROUBLESHOOTING_HINT}` : message);
}

/** Create the model-invoked Web Search definition. */
export function createWebSearchTool(
  options: WebSearchToolOptions = {},
): ToolDefinition<typeof WEB_SEARCH_PARAMETERS, WebSearchDetails> {
  return defineTool<typeof WEB_SEARCH_PARAMETERS, WebSearchDetails>({
    name: "web_search",
    label: "Web Search",
    description: WEB_SEARCH_DESCRIPTION,
    promptSnippet: "Search the web for current information",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: WEB_SEARCH_PARAMETERS,
    outputSchema: WebSearchOutputSchema,
    renderCall: (parameters, theme, context) =>
      renderWebSearchToolCall(parameters, theme, context.expanded),
    renderResult: (result, renderOptions, theme, context) =>
      renderWebSearchToolResult(
        result,
        renderOptions,
        theme,
        context.isError,
        Value.Check(WebSearchDetailsSchema, result.details) ? result.details : undefined,
      ),
    async execute(_toolCallId, parameters, callerSignal, onUpdate, context) {
      const provider = selectSearchProvider(context.sessionManager.getSessionId());
      onUpdate?.({ content: [], details: { provider } });
      let input: WebSearchParameters;
      try {
        input = Value.Parse(WEB_SEARCH_PARAMETERS, parameters);
      } catch {
        throw unableToSearch(
          undefined,
          describeWebFailure(
            new WebInputError(
              "invalid parameters (expected a query string with optional numResults, livecrawl, type, and contextMaxCharacters)",
            ),
          ),
        );
      }
      if (input.query.trim() === "") {
        throw unableToSearch(
          undefined,
          describeWebFailure(
            new WebInputError("query is empty (provide the text to search the web for)"),
          ),
        );
      }
      const sessionId = context.sessionManager.getSessionId();
      let search: string;
      try {
        search = await callSearchProvider(
          provider,
          sessionId,
          input,
          options,
          requestSignal(callerSignal, WEB_SEARCH_TIMEOUT_MS),
        );
      } catch (error) {
        // User cancellation and provider-reported rejections are not failures the Skill diagnoses.
        const failure =
          error instanceof SearchProviderError && callerSignal?.aborted !== true
            ? { cause: error.message, diagnosable: error.diagnosable }
            : describeWebFailure(error, { callerSignal, timeoutMs: WEB_SEARCH_TIMEOUT_MS });
        throw unableToSearch(input.query, failure);
      }
      // Spilling the full output is local work; its failures are not Web Search request failures.
      const output = await createWebToolOutput(search);
      const structuredContent: WebSearchOutput = { provider, content: search };
      if (output.truncation !== undefined) {
        structuredContent.full_output_path = output.truncation.fullOutputPath;
      }
      return {
        content: [{ type: "text", text: output.content }],
        details:
          output.truncation === undefined
            ? { provider }
            : { provider, truncation: output.truncation },
        structuredContent,
      };
    },
  });
}
