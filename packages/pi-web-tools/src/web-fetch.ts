import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { readBoundedResponseBody } from "./web-response.js";
import { renderWebFetchToolCall, renderWebFetchToolResult } from "./web-tool-rendering.js";
import { createWebToolOutput, WebToolTruncationDetailsSchema } from "./web-tool-output.js";
import { redactWebUrlUserinfo } from "./web-url.js";

/** Maximum accepted Web Fetch response body size. */
export const WEB_FETCH_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Default total Web Fetch request budget in seconds. */
export const WEB_FETCH_DEFAULT_TIMEOUT_SECONDS = 30;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const HONEST_USER_AGENT = "pi-web-tools";

const WebFetchFormatSchema = StringEnum(["text", "markdown", "html"] as const, {
  default: "markdown",
  description: "Returned format (default: markdown)",
});

/** Textual representation requested from Web Fetch. */
export type WebFetchFormat = Static<typeof WebFetchFormatSchema>;

/** Native transport used by a Web Fetch definition. */
export type WebFetchToolOptions = {
  readonly fetch?: typeof globalThis.fetch | undefined;
};

/** Runtime contract for model-invisible Web Fetch response metadata. */
export const WebFetchDetailsSchema = Type.Object(
  {
    url: Type.String(),
    contentType: Type.String(),
    format: WebFetchFormatSchema,
    truncation: Type.Optional(WebToolTruncationDetailsSchema),
  },
  { additionalProperties: false },
);

/** Model-invisible Web Fetch response metadata. */
export type WebFetchDetails = Static<typeof WebFetchDetailsSchema>;

const WEB_FETCH_PARAMETERS = Type.Object(
  {
    url: Type.String({ description: "Absolute HTTP or HTTPS URL to fetch" }),
    format: Type.Optional(WebFetchFormatSchema),
    timeout: Type.Optional(
      Type.Number({
        exclusiveMinimum: 0,
        maximum: 120,
        default: WEB_FETCH_DEFAULT_TIMEOUT_SECONDS,
        description: "Total timeout in seconds (default: 30, maximum: 120)",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Validated arguments accepted by Web Fetch execution and Transcript Presentation. */
export type WebFetchParameters = Static<typeof WEB_FETCH_PARAMETERS>;

type WebFetchRequestHeaders = {
  readonly Accept: string;
  readonly "Accept-Language": string;
  readonly "User-Agent": string;
};

type FetchedText = {
  readonly content: string;
  readonly contentType: string;
  readonly finalUrl: string;
};

const WEB_FETCH_DESCRIPTION =
  "Fetch one HTTP or HTTPS URL as text, Markdown, or HTML. HTML is converted when requested. Model-visible output is truncated to 50 KiB or 2,000 lines, with complete output saved to a private temporary file.";

class WebFetchFailure extends Error {
  readonly _tag = "WebFetchFailure" as const;
  readonly operation = "fetch" as const;
  readonly status: number | undefined;
  readonly contentType: string | undefined;

  constructor(
    readonly kind: "url" | "transport" | "status" | "mime" | "body" | "conversion",
    readonly url: string,
    readonly retryCount: number,
    cause?: unknown,
    status?: number,
    contentType?: string,
  ) {
    super(`Web Fetch ${kind} failure for ${url}`, cause === undefined ? undefined : { cause });
    this.status = status;
    this.contentType = contentType;
  }
}

type WebFetchResult<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: WebFetchFailure };

function parseHttpUrl(input: string, safeUrl: string): WebFetchResult<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    return { _tag: "err", error: new WebFetchFailure("url", safeUrl, 0, cause) };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { _tag: "err", error: new WebFetchFailure("url", safeUrl, 0) };
  }
  return { _tag: "ok", value: url };
}

function acceptHeader(format: WebFetchFormat): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }
}

function requestHeaders(format: WebFetchFormat, userAgent: string): WebFetchRequestHeaders {
  return {
    Accept: acceptHeader(format),
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": userAgent,
  };
}

function requestSignal(callerSignal: AbortSignal | undefined, timeoutSeconds: number): AbortSignal {
  const deadline = AbortSignal.timeout(Math.ceil(timeoutSeconds * 1000));
  return callerSignal === undefined ? deadline : AbortSignal.any([callerSignal, deadline]);
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function fetchOnce(
  fetch: typeof globalThis.fetch,
  url: string,
  safeUrl: string,
  format: WebFetchFormat,
  userAgent: string,
  signal: AbortSignal,
  retryCount: number,
): Promise<WebFetchResult<Response>> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: requestHeaders(format, userAgent),
      signal,
    });
    return { _tag: "ok", value: response };
  } catch (cause) {
    return {
      _tag: "err",
      error: new WebFetchFailure("transport", safeUrl, retryCount, cause),
    };
  }
}

function isCloudflareChallenge(response: Response): boolean {
  return response.status === 403 && response.headers.get("cf-mitigated") === "challenge";
}

function normalizedMime(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isTextualMime(mime: string): boolean {
  return (
    mime.length === 0 ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/javascript" ||
    mime === "application/x-javascript"
  );
}

function extractTextFromHtml(html: string): string {
  let text = "";
  let skipDepth = 0;
  const omittedElements = new Set(["script", "style", "noscript", "iframe", "object", "embed"]);
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || omittedElements.has(name)) skipDepth++;
    },
    ontext(value) {
      if (skipDepth === 0) text += value;
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--;
    },
  });
  parser.write(html);
  parser.end();
  return text.trim();
}

function convertHtmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  turndown.remove(["script", "style", "meta", "link"]);
  return turndown.turndown(html);
}

function convertFetchedContent(
  content: string,
  mime: string,
  format: WebFetchFormat,
  safeUrl: string,
  retryCount: number,
): WebFetchResult<string> {
  if (mime !== "text/html") return { _tag: "ok", value: content };
  try {
    if (format === "markdown") return { _tag: "ok", value: convertHtmlToMarkdown(content) };
    if (format === "text") return { _tag: "ok", value: extractTextFromHtml(content) };
    return { _tag: "ok", value: content };
  } catch (cause) {
    return {
      _tag: "err",
      error: new WebFetchFailure("conversion", safeUrl, retryCount, cause),
    };
  }
}

async function fetchText(
  parsedUrl: URL,
  safeUrl: string,
  format: WebFetchFormat,
  signal: AbortSignal,
  options: WebFetchToolOptions,
): Promise<WebFetchResult<FetchedText>> {
  const fetch = options.fetch ?? globalThis.fetch;
  const first = await fetchOnce(
    fetch,
    parsedUrl.toString(),
    safeUrl,
    format,
    BROWSER_USER_AGENT,
    signal,
    0,
  );
  if (first._tag === "err") return first;
  let response = first.value;
  let retryCount = 0;
  if (isCloudflareChallenge(response)) {
    await cancelResponse(response);
    const retry = await fetchOnce(
      fetch,
      parsedUrl.toString(),
      safeUrl,
      format,
      HONEST_USER_AGENT,
      signal,
      1,
    );
    if (retry._tag === "err") return retry;
    response = retry.value;
    retryCount = 1;
  }
  if (!response.ok) {
    await cancelResponse(response);
    return {
      _tag: "err",
      error: new WebFetchFailure("status", safeUrl, retryCount, undefined, response.status),
    };
  }

  const contentType = response.headers.get("content-type") ?? "";
  const mime = normalizedMime(contentType);
  if (!isTextualMime(mime)) {
    await cancelResponse(response);
    return {
      _tag: "err",
      error: new WebFetchFailure("mime", safeUrl, retryCount, undefined, undefined, contentType),
    };
  }

  const body = await readBoundedResponseBody(response, WEB_FETCH_MAX_RESPONSE_BYTES, signal);
  if (body._tag === "err") {
    return {
      _tag: "err",
      error: new WebFetchFailure("body", safeUrl, retryCount, body.error),
    };
  }
  const converted = convertFetchedContent(
    new TextDecoder().decode(body.value),
    mime,
    format,
    safeUrl,
    retryCount,
  );
  if (converted._tag === "err") return converted;
  return {
    _tag: "ok",
    value: {
      content: converted.value,
      contentType,
      finalUrl: redactWebUrlUserinfo(response.url || parsedUrl.toString()),
    },
  };
}

function unableToFetch(safeUrl: string): Error {
  return new Error(`Unable to fetch ${safeUrl}`);
}

/** Create the model-invoked Web Fetch definition. */
export function createWebFetchTool(
  options: WebFetchToolOptions = {},
): ToolDefinition<typeof WEB_FETCH_PARAMETERS, WebFetchDetails> {
  return defineTool<typeof WEB_FETCH_PARAMETERS, WebFetchDetails>({
    name: "web_fetch",
    label: "Web Fetch",
    description: WEB_FETCH_DESCRIPTION,
    promptSnippet: "Fetch one HTTP or HTTPS URL as text, Markdown, or HTML",
    parameters: WEB_FETCH_PARAMETERS,
    renderCall: (parameters, theme, context) =>
      renderWebFetchToolCall(parameters, theme, context.expanded),
    renderResult: (result, renderOptions, theme, context) =>
      renderWebFetchToolResult(
        result,
        renderOptions,
        theme,
        context.isError,
        Value.Check(WebFetchDetailsSchema, result.details) ? result.details : undefined,
      ),
    async execute(_toolCallId, parameters, callerSignal, onUpdate) {
      let input: WebFetchParameters;
      try {
        input = Value.Parse(WEB_FETCH_PARAMETERS, parameters);
      } catch {
        throw unableToFetch("requested URL");
      }
      const safeUrl = redactWebUrlUserinfo(input.url);
      const parsedUrl = parseHttpUrl(input.url, safeUrl);
      if (parsedUrl._tag === "err") throw unableToFetch(safeUrl);
      const format = input.format ?? "markdown";
      const signal = requestSignal(
        callerSignal,
        input.timeout ?? WEB_FETCH_DEFAULT_TIMEOUT_SECONDS,
      );
      onUpdate?.({ content: [], details: { url: safeUrl, contentType: "", format } });
      const fetched = await fetchText(parsedUrl.value, safeUrl, format, signal, options);
      if (fetched._tag === "err") throw unableToFetch(safeUrl);
      const output = await createWebToolOutput(fetched.value.content);
      if (output._tag === "err") throw unableToFetch(safeUrl);
      return {
        content: [{ type: "text", text: output.value.content }],
        details:
          output.value.truncation === undefined
            ? {
                url: fetched.value.finalUrl,
                contentType: fetched.value.contentType,
                format,
              }
            : {
                url: fetched.value.finalUrl,
                contentType: fetched.value.contentType,
                format,
                truncation: output.value.truncation,
              },
      };
    },
  });
}
