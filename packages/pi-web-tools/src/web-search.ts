import { StringEnum } from "@earendil-works/pi-ai";
import { stripControlCharacters } from "@ian-pascoe/pi-utils";
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
import {
  createWebToolOutput,
  webToolWarningNotice,
  WebToolTruncationDetailsSchema,
} from "./web-tool-output.js";

const DEFAULT_EXA_URL = "https://mcp.exa.ai/mcp";
const DEFAULT_PARALLEL_URL = "https://search.parallel.ai/mcp";
const MAX_SEARCH_RESPONSE_BYTES = 256 * 1024;
const NO_SEARCH_RESULTS = "No search results found. Please try a different query.";
const MAX_PROVIDER_MESSAGE_CHARACTERS = 500;
const MAX_ERROR_BODY_BYTES = 4 * 1024;
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

/** Optional Web Search parameter names, in the stable order warnings list them. */
const OPTIONAL_SEARCH_PARAMETERS = [
  "numResults",
  "type",
  "livecrawl",
  "contextMaxCharacters",
] as const;

type OptionalSearchParameter = (typeof OPTIONAL_SEARCH_PARAMETERS)[number];

/**
 * Which Search Providers honor each optional parameter. This is the single source of truth for the
 * parameter descriptions and the ignored-parameter warning; update it when a provider schema changes.
 * Verified against the live `tools/list` schemas: Exa `web_search_exa` accepts only `numResults`, and
 * Parallel `web_search` accepts none. Pi still sends every supplied control to Exa, which ignores
 * unknown keys; removing the ignored parameters from the schema would be a breaking change.
 */
export const SEARCH_PARAMETER_SUPPORT = {
  numResults: ["exa"],
  type: [],
  livecrawl: [],
  contextMaxCharacters: [],
} as const satisfies { readonly [Parameter in OptionalSearchParameter]: readonly SearchProvider[] };

function honoringProviders(parameter: OptionalSearchParameter): readonly SearchProvider[] {
  return SEARCH_PARAMETER_SUPPORT[parameter];
}

const SEARCH_PROVIDERS: readonly SearchProvider[] = ["exa", "parallel"];

function providerName(provider: SearchProvider): string {
  return provider === "exa" ? "Exa" : "Parallel";
}

/** Static sentence naming the Search Providers that honor a parameter. */
function searchParameterSupportNote(parameter: OptionalSearchParameter): string {
  const honoring = honoringProviders(parameter);
  const ignoring = SEARCH_PROVIDERS.filter((provider) => !honoring.includes(provider));
  if (honoring.length === 0) return "Currently ignored by both Search Providers.";
  if (ignoring.length === 0) return "Honored by both Search Providers.";
  return `Honored by ${honoring.map(providerName).join(", ")}; ${ignoring.map(providerName).join(", ")} ignores it.`;
}

/** Explicitly supplied parameters the Search Provider ignores, or nothing to warn about. */
function ignoredParameterWarnings(
  provider: SearchProvider,
  supplied: Pick<WebSearchParameters, OptionalSearchParameter>,
): string[] {
  const ignored = OPTIONAL_SEARCH_PARAMETERS.filter(
    (parameter) =>
      supplied[parameter] !== undefined && !honoringProviders(parameter).includes(provider),
  );
  return ignored.length === 0 ? [] : [`${providerName(provider)} ignores: ${ignored.join(", ")}.`];
}

/** Native transport and hosted endpoints used by a Web Search definition. */
export type WebSearchToolOptions = {
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly exaUrl?: string | undefined;
  readonly parallelUrl?: string | undefined;
  readonly exaApiKey?: RedactedWebSearchApiKey | undefined;
  readonly parallelApiKey?: RedactedWebSearchApiKey | undefined;
};

const WarningsSchema = Type.Array(Type.String(), {
  minItems: 1,
  description: "Present only when the Search Provider ignored parameters the call supplied",
});

/** Runtime contract for model-invisible Web Search execution metadata. */
export const WebSearchDetailsSchema = Type.Object(
  {
    provider: SearchProviderSchema,
    warnings: Type.Optional(WarningsSchema),
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
    warnings: Type.Optional(WarningsSchema),
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
        description: `Number of results (default: 8, maximum: 20). ${searchParameterSupportNote("numResults")}`,
      }),
    ),
    livecrawl: Type.Optional(
      StringEnum(["fallback", "preferred"] as const, {
        default: "fallback",
        description: `Live crawl mode (default: fallback). ${searchParameterSupportNote("livecrawl")}`,
      }),
    ),
    type: Type.Optional(
      StringEnum(["auto", "fast", "deep"] as const, {
        default: "auto",
        description: `Search type (default: auto). ${searchParameterSupportNote("type")}`,
      }),
    ),
    contextMaxCharacters: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50_000,
        description: `Maximum model context characters (effective default: 10000). ${searchParameterSupportNote("contextMaxCharacters")}`,
      }),
    ),
  },
  { additionalProperties: false },
);

/** Validated arguments accepted by Web Search execution and Transcript Presentation. */
export type WebSearchParameters = Static<typeof WEB_SEARCH_PARAMETERS>;

const MCP_RESPONSE_SCHEMA = Type.Object(
  {
    id: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Null()])),
    method: Type.Optional(Type.String()),
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
  "Discover current public web information using Exa or Parallel. Optional parameters are honored only by some Search Providers; each parameter says which, and a warning names supplied parameters the active provider ignored. Results are textual and model-visible output is truncated to 50 KiB or 2,000 lines, with complete output saved to a private temporary file.";

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

/** Turns provider-controlled text into one short, key-free, control-free line. */
type SanitizeProviderText = (text: string) => string;

/** Request id Web Search sends, which a Search Provider echoes on its response. */
const REQUEST_ID = 1;

function firstText(content: readonly { type: string; text?: string | undefined }[] | undefined) {
  return content?.find(({ type, text }) => type === "text" && text !== undefined && text.length > 0)
    ?.text;
}

function withDetail(summary: string, detail: string): string {
  return detail === "" ? summary : `${summary}: ${detail}`;
}

function describeJsonRpcError(
  provider: SearchProvider,
  error: { readonly code?: number | undefined; readonly message?: string | undefined },
  sanitize: SanitizeProviderText,
): string {
  const code = error.code === undefined ? "" : ` ${error.code}`;
  return withDetail(
    `${providerName(provider)} returned error${code}`,
    sanitize(error.message ?? ""),
  );
}

/** The outcome of one JSON-RPC payload that is not a Search Provider failure. */
type McpPayload =
  | { readonly kind: "skipped" }
  | { readonly kind: "result"; readonly text: string | undefined };

/** Return provider text, throw a provider failure, or skip a payload that answers nothing. */
function parseMcpPayload(
  payload: string,
  provider: SearchProvider,
  sanitize: SanitizeProviderText,
): McpPayload {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) return { kind: "skipped" };
  const response = Value.Parse(MCP_RESPONSE_SCHEMA, JSON.parse(trimmed));
  // Notifications carry a method but no result or error; responses to other requests are not ours.
  if (response.result === undefined && response.error === undefined) return { kind: "skipped" };
  if (response.id !== undefined && response.id !== null && response.id !== REQUEST_ID) {
    return { kind: "skipped" };
  }
  const name = providerName(provider);
  if (response.error !== undefined) {
    throw new SearchProviderError(describeJsonRpcError(provider, response.error, sanitize));
  }
  const result = response.result;
  if (result === undefined) return { kind: "skipped" };
  const text = firstText(result.content);
  const detail = text === undefined ? "" : sanitize(text);
  if (provider === "exa" && result._meta?.[EXA_RATE_LIMITED_META] === true) {
    // An API key lifts the free-tier limit, so the troubleshooting Skill can help.
    throw new SearchProviderError(withDetail(`${name} rate limit reached`, detail), true);
  }
  if (result.isError === true) {
    throw new SearchProviderError(withDetail(`${name} reported an error`, detail));
  }
  return { kind: "result", text };
}

/** Split a Server-Sent Events body into events, joining each event's `data:` lines with newlines. */
function sseEventPayloads(body: string): string[] {
  const events: string[] = [];
  let data: string[] = [];
  const flush = () => {
    if (data.length > 0) events.push(data.join("\n"));
    data = [];
  };
  for (const line of body.split(/\r\n|\n|\r/)) {
    if (line === "") flush();
    else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
  }
  flush();
  return events;
}

/**
 * Read the answer to Web Search's request from a JSON or SSE body. The first payload carrying text
 * or a failure decides the outcome, so a later error never replaces an earlier answer. Returns
 * undefined for a valid result without text and throws for anything that is not JSON-RPC.
 */
function parseMcpResponse(
  body: string,
  provider: SearchProvider,
  sanitize: SanitizeProviderText,
): string | undefined {
  const trimmed = body.trim();
  const payloads = trimmed.startsWith("{") ? [trimmed] : sseEventPayloads(body);
  let sawResult = false;
  for (const payload of payloads) {
    const parsed = parseMcpPayload(payload, provider, sanitize);
    if (parsed.kind === "skipped") continue;
    sawResult = true;
    if (parsed.text !== undefined) return parsed.text;
  }
  if (!sawResult) {
    throw new SearchProviderError(`${providerName(provider)} returned an unrecognized response`);
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
  const sanitize = providerTextSanitizer(options);
  if (!response.ok) throw await httpFailure(response, provider, sanitize, signal);

  const body = await readBoundedResponseBody(response, MAX_SEARCH_RESPONSE_BYTES, signal);
  try {
    return (
      parseMcpResponse(new TextDecoder().decode(body), provider, sanitize) ?? NO_SEARCH_RESULTS
    );
  } catch (error) {
    if (error instanceof SearchProviderError) throw error;
    throw new SearchProviderError(`${providerName(provider)} returned an unrecognized response`);
  }
}

/** Key or rate-limit rejections that the troubleshooting Skill can fix, besides server errors. */
function isDiagnosableStatus(status: number): boolean {
  return status >= 500 || status === 401 || status === 403 || status === 429;
}

/** Name the HTTP status and, for a small JSON body, the JSON-RPC error the provider explained it with. */
async function httpFailure(
  response: Response,
  provider: SearchProvider,
  sanitize: SanitizeProviderText,
  signal: AbortSignal,
): Promise<SearchProviderError> {
  const { cause } = describeWebFailure(new WebHttpStatusError(response.status));
  let detail = "";
  if ((response.headers.get("content-type") ?? "").toLowerCase().includes("json")) {
    try {
      const body = await readBoundedResponseBody(response, MAX_ERROR_BODY_BYTES, signal);
      const parsed = Value.Parse(MCP_RESPONSE_SCHEMA, JSON.parse(new TextDecoder().decode(body)));
      if (parsed.error !== undefined)
        detail = describeJsonRpcError(provider, parsed.error, sanitize);
    } catch {
      // An oversized, unreadable, or non-JSON-RPC error body leaves only the status.
    }
  } else {
    await cancelResponse(response);
  }
  return new SearchProviderError(withDetail(cause, detail), isDiagnosableStatus(response.status));
}

function secretVariants(secret: string): Set<string> {
  return new Set([
    secret,
    encodeURIComponent(secret),
    new URLSearchParams({ k: secret }).toString().slice(2),
  ]);
}

/** Remove configured API keys, in every encoding a URL might carry, from echoed text. */
function redactApiKeys(message: string, options: WebSearchToolOptions): string {
  let redacted = message;
  for (const key of [options.exaApiKey, options.parallelApiKey]) {
    const secret = key?.reveal();
    if (secret === undefined || secret === "") continue;
    for (const variant of secretVariants(secret)) {
      redacted = redacted.replaceAll(variant, "[REDACTED]");
    }
  }
  return redacted;
}

// Terminal escape sequences start with ESC; they are removed from provider text.
const TERMINAL_SEQUENCE =
  // oxlint-disable-next-line eslint/no-control-regex -- SAFETY: Matching ESC and BEL is the purpose of this expression.
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;

/**
 * Build the sanitizer for text a Search Provider controls. Keys are redacted before anything is cut
 * and again after control characters are removed, so no key fragment survives truncation.
 */
function providerTextSanitizer(options: WebSearchToolOptions): SanitizeProviderText {
  return (text) => {
    const stripped = stripControlCharacters(
      redactApiKeys(text, options).replace(TERMINAL_SEQUENCE, ""),
    ).replace(/\p{Cf}/gu, "");
    const collapsed = redactApiKeys(stripped, options).replace(/\s+/g, " ").trim();
    const characters = Array.from(collapsed);
    return characters.length > MAX_PROVIDER_MESSAGE_CHARACTERS
      ? `${characters.slice(0, MAX_PROVIDER_MESSAGE_CHARACTERS).join("")}…`
      : collapsed;
  };
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
      const warnings = ignoredParameterWarnings(provider, parameters);
      // The warning leads the model-visible text, so the shared output limits account for it.
      const output = await createWebToolOutput(
        warnings.length === 0 ? search : `${webToolWarningNotice(warnings)}\n\n${search}`,
      );
      const structuredContent: WebSearchOutput = { provider, content: search };
      if (warnings.length > 0) structuredContent.warnings = warnings;
      if (output.truncation !== undefined) {
        structuredContent.full_output_path = output.truncation.fullOutputPath;
      }
      const details: WebSearchDetails = { provider };
      if (warnings.length > 0) details.warnings = warnings;
      if (output.truncation !== undefined) details.truncation = output.truncation;
      return {
        content: [{ type: "text", text: output.content }],
        details,
        structuredContent,
      };
    },
  });
}
