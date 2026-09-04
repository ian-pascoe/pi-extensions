import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { readBoundedResponseBody } from "./web-response.js";
import { createWebToolOutput, type WebToolTruncationDetails } from "./web-tool-output.js";

const DEFAULT_EXA_URL = "https://mcp.exa.ai/mcp";
const DEFAULT_PARALLEL_URL = "https://search.parallel.ai/mcp";
const MAX_SEARCH_RESPONSE_BYTES = 256 * 1024;
const NO_SEARCH_RESULTS = "No search results found. Please try a different query.";

/** Total Web Search request budget, including response reading. */
export const WEB_SEARCH_TIMEOUT_MS = 25_000;

/** Hosted Search Provider selected deterministically for one Pi session. */
export type SearchProvider = "exa" | "parallel";

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

/** Model-invisible Web Search execution metadata. */
export type WebSearchDetails = {
  readonly provider: SearchProvider;
  readonly truncation?: WebToolTruncationDetails;
};

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

const MCP_RESPONSE_SCHEMA = Type.Object(
  {
    result: Type.Object(
      {
        content: Type.Array(
          Type.Object(
            { type: Type.String(), text: Type.Optional(Type.String()) },
            { additionalProperties: true },
          ),
        ),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

const WEB_SEARCH_DESCRIPTION = `Discover current public web information using Exa or Parallel. Results are textual and model-visible output is truncated to 50 KiB or 2,000 lines, with complete output saved to a private temporary file. The current year is ${new Date().getFullYear()}.`;

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
  readonly body: object;
};

class WebSearchFailure extends Error {
  readonly _tag = "WebSearchFailure" as const;
  readonly operation = "search" as const;
  readonly retryCount = 0;

  constructor(
    readonly kind: "transport" | "status" | "body" | "response",
    readonly provider: SearchProvider,
    cause?: unknown,
    readonly status?: number,
  ) {
    super(
      `Web Search ${kind} failure from ${provider}`,
      cause === undefined ? undefined : { cause },
    );
  }
}

type WebSearchResult<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: WebSearchFailure };

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

function parseMcpPayload(payload: string): string | undefined {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) return undefined;
  const parsed: unknown = JSON.parse(trimmed);
  const response = Value.Parse(MCP_RESPONSE_SCHEMA, parsed);
  return response.result.content.find(
    ({ type, text }) => type === "text" && text !== undefined && text.length > 0,
  )?.text;
}

function parseMcpResponse(body: string): string | undefined {
  const direct = body.trim().length === 0 ? undefined : parseMcpPayload(body);
  if (direct !== undefined) return direct;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const text = parseMcpPayload(line.slice(6));
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

function requestSignal(callerSignal: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS);
  return callerSignal === undefined ? deadline : AbortSignal.any([callerSignal, deadline]);
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function callSearchProvider(
  provider: SearchProvider,
  sessionId: string,
  parameters: Static<typeof WEB_SEARCH_PARAMETERS>,
  options: WebSearchToolOptions,
  signal: AbortSignal,
): Promise<WebSearchResult<string>> {
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

  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    });
  } catch (cause) {
    return { _tag: "err", error: new WebSearchFailure("transport", provider, cause) };
  }
  if (!response.ok) {
    await cancelResponse(response);
    return {
      _tag: "err",
      error: new WebSearchFailure("status", provider, undefined, response.status),
    };
  }

  const body = await readBoundedResponseBody(response, MAX_SEARCH_RESPONSE_BYTES, signal);
  if (body._tag === "err") {
    return { _tag: "err", error: new WebSearchFailure("body", provider, body.error) };
  }
  try {
    return {
      _tag: "ok",
      value: parseMcpResponse(new TextDecoder().decode(body.value)) ?? NO_SEARCH_RESULTS,
    };
  } catch (cause) {
    return { _tag: "err", error: new WebSearchFailure("response", provider, cause) };
  }
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
    parameters: WEB_SEARCH_PARAMETERS,
    async execute(_toolCallId, parameters, callerSignal, _onUpdate, context) {
      const provider = selectSearchProvider(context.sessionManager.getSessionId());
      let input: Static<typeof WEB_SEARCH_PARAMETERS>;
      try {
        input = Value.Parse(WEB_SEARCH_PARAMETERS, parameters);
      } catch {
        throw new Error(`Unable to search the web for ${parameters.query}`);
      }
      const search = await callSearchProvider(
        provider,
        context.sessionManager.getSessionId(),
        input,
        options,
        requestSignal(callerSignal),
      );
      if (search._tag === "err") {
        throw new Error(`Unable to search the web for ${input.query}`);
      }
      const output = await createWebToolOutput(search.value);
      if (output._tag === "err") {
        throw new Error(`Unable to search the web for ${input.query}`);
      }
      return {
        content: [{ type: "text", text: output.value.content }],
        details:
          output.value.truncation === undefined
            ? { provider }
            : { provider, truncation: output.value.truncation },
      };
    },
  });
}
