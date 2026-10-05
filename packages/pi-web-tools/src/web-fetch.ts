import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import { type Static, Type } from "typebox";
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
import { renderWebFetchToolCall, renderWebFetchToolResult } from "./web-tool-rendering.js";
import {
  boundWebToolStructuredText,
  createWebToolOutput,
  WebToolTruncationDetailsSchema,
} from "./web-tool-output.js";
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

/**
 * JSON Schema of the `structuredContent` codemode scripts receive instead of the model-facing text.
 * `content` is the complete fetched text up to 1 MiB; `truncated` marks a longer page cut at that
 * limit. `full_output_path` names the private file holding the complete text whenever it exceeded the
 * model-visible 50 KiB / 2,000-line limit.
 */
export const WebFetchOutputSchema = Type.Object(
  {
    url: Type.String({ description: "Final URL after redirects, without credentials" }),
    content_type: Type.String({ description: "Response Content-Type header" }),
    format: WebFetchFormatSchema,
    content: Type.String({ description: "Fetched text in the requested format" }),
    truncated: Type.Boolean({ description: "content was cut at 1 MiB" }),
    full_output_path: Type.Optional(
      Type.String({ description: "Private file with the full text" }),
    ),
  },
  { additionalProperties: false },
);

/** Value a codemode script receives from Web Fetch. */
export type WebFetchOutput = Static<typeof WebFetchOutputSchema>;

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

function parseHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebInputError("invalid URL (expected an absolute HTTP or HTTPS URL)");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebInputError(
      `unsupported URL scheme ${url.protocol} (Web Fetch requires an HTTP or HTTPS URL)`,
    );
  }
  return url;
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

async function fetchOnce(
  fetch: typeof globalThis.fetch,
  url: string,
  format: WebFetchFormat,
  userAgent: string,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers: requestHeaders(format, userAgent),
    signal,
  });
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

function convertFetchedContent(content: string, mime: string, format: WebFetchFormat): string {
  if (mime !== "text/html" || format === "html") return content;
  return format === "markdown" ? convertHtmlToMarkdown(content) : extractTextFromHtml(content);
}

async function fetchText(
  parsedUrl: URL,
  format: WebFetchFormat,
  signal: AbortSignal,
  options: WebFetchToolOptions,
): Promise<FetchedText> {
  const fetch = options.fetch ?? globalThis.fetch;
  let response = await fetchOnce(fetch, parsedUrl.toString(), format, BROWSER_USER_AGENT, signal);
  if (isCloudflareChallenge(response)) {
    await cancelResponse(response);
    response = await fetchOnce(fetch, parsedUrl.toString(), format, HONEST_USER_AGENT, signal);
  }
  if (!response.ok) {
    await cancelResponse(response);
    throw new WebHttpStatusError(response.status, response.statusText);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const mime = normalizedMime(contentType);
  if (!isTextualMime(mime)) {
    await cancelResponse(response);
    throw new WebInputError(
      `unsupported content type ${mime} (Web Fetch returns text only; for a document such as a PDF, download it and convert it to text locally)`,
    );
  }

  const body = await readBoundedResponseBody(response, WEB_FETCH_MAX_RESPONSE_BYTES, signal);
  return {
    content: convertFetchedContent(new TextDecoder().decode(body), mime, format),
    contentType,
    finalUrl: redactWebUrlUserinfo(response.url || parsedUrl.toString()),
  };
}

function unableToFetch(safeUrl: string, failure: WebFailure): Error {
  const message = `Unable to fetch ${safeUrl}: ${failure.cause}`;
  return new Error(failure.diagnosable ? `${message}\n\n${TROUBLESHOOTING_HINT}` : message);
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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: WEB_FETCH_PARAMETERS,
    outputSchema: WebFetchOutputSchema,
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
        throw unableToFetch(
          "requested URL",
          describeWebFailure(
            new WebInputError(
              "invalid parameters (expected a url string with optional format and timeout)",
            ),
          ),
        );
      }
      const safeUrl = redactWebUrlUserinfo(input.url);
      let parsedUrl: URL;
      try {
        parsedUrl = parseHttpUrl(input.url);
      } catch (error) {
        throw unableToFetch(safeUrl, describeWebFailure(error));
      }
      const format = input.format ?? "markdown";
      const timeoutMs = Math.ceil((input.timeout ?? WEB_FETCH_DEFAULT_TIMEOUT_SECONDS) * 1000);
      const signal = requestSignal(callerSignal, timeoutMs);
      onUpdate?.({ content: [], details: { url: safeUrl, contentType: "", format } });
      try {
        const fetched = await fetchText(parsedUrl, format, signal, options);
        const output = await createWebToolOutput(fetched.content);
        const structured = boundWebToolStructuredText(fetched.content);
        const structuredContent: WebFetchOutput = {
          url: fetched.finalUrl,
          content_type: fetched.contentType,
          format,
          content: structured.content,
          truncated: structured.truncated,
        };
        if (output.truncation !== undefined) {
          structuredContent.full_output_path = output.truncation.fullOutputPath;
        }
        return {
          content: [{ type: "text", text: output.content }],
          details:
            output.truncation === undefined
              ? {
                  url: fetched.finalUrl,
                  contentType: fetched.contentType,
                  format,
                }
              : {
                  url: fetched.finalUrl,
                  contentType: fetched.contentType,
                  format,
                  truncation: output.truncation,
                },
          structuredContent,
        };
      } catch (error) {
        // Dead links, blocked pages, bad input, and user cancellation are not failures the Skill diagnoses.
        throw unableToFetch(safeUrl, describeWebFailure(error, { callerSignal, timeoutMs }));
      }
    },
  });
}
