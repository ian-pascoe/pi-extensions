import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { extractMainContent, type HtmlMainContent } from "./html-main-content.js";
import { convertHtmlInChunks } from "./html-markdown.js";
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
  type WebToolLineWindow,
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
 * `content` is the converted text of the selected `offset`/`limit` window (the whole page when
 * neither is given) up to 1 MiB, without the model's continuation note. Two separate cuts are
 * reported, as in pi-lsp: `truncated` means the model-visible output was cut at 50 KiB / 2,000
 * lines, and is true exactly when `full_output_path` names the private file holding the complete
 * window; `structured_truncated` means `content` itself was cut at 1 MiB, so the window is longer
 * than the script received. A `structured_truncated` result is always also `truncated`, and
 * `full_output_path` then holds the text `content` lost. `total_lines` and `next_offset` let a
 * script page; they are present only when `offset` or `limit` was passed.
 */
export const WebFetchOutputSchema = Type.Object(
  {
    url: Type.String({ description: "Final URL after redirects, without credentials" }),
    content_type: Type.String({ description: "Response Content-Type header" }),
    format: WebFetchFormatSchema,
    content: Type.String({
      description: "Fetched text in the requested format, limited to the offset/limit window",
    }),
    truncated: Type.Boolean({
      description:
        "The model-visible output was cut at 50 KiB or 2,000 lines; true exactly when full_output_path is present",
    }),
    structured_truncated: Type.Boolean({
      description:
        "content itself was cut at 1 MiB; full_output_path holds the complete offset/limit window",
    }),
    full_output_path: Type.Optional(
      Type.String({
        description:
          "Private file with the complete offset/limit window (the whole text without one) when truncated",
      }),
    ),
    total_lines: Type.Optional(
      Type.Number({
        description: "Lines in the whole converted text; present when offset or limit was passed",
      }),
    ),
    next_offset: Type.Optional(
      Type.Integer({
        description:
          "Offset of the first line after the offset/limit window; present when lines remain after it",
      }),
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
    offset: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Line to start reading from (1-indexed), counted in the returned format after conversion",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Maximum number of lines to return; the result says how many lines remain and the offset to continue from",
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
  "Fetch one HTTP or HTTPS URL as text, Markdown, or HTML. HTML pages are converted to their main content, with the page title, when text or Markdown is requested; HTML format returns the page unchanged. Model-visible output is truncated to 50 KiB or 2,000 lines, with complete output saved to a private temporary file. Use offset and limit (lines, like the read tool) to page through a long result.";

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

const MAX_MIME_MESSAGE_LENGTH = 100;

function truncatedMime(mime: string): string {
  return mime.length > MAX_MIME_MESSAGE_LENGTH
    ? `${mime.slice(0, MAX_MIME_MESSAGE_LENGTH)}…`
    : mime;
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

/** Block elements that end the current line and separate a following block with a blank line. */
const PARAGRAPH_ELEMENTS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "dl",
  "table",
  "figure",
  "form",
  "hr",
]);

/** Block elements that only start a new line. */
const LINE_ELEMENTS = new Set([
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "nav",
  "aside",
  "li",
  "dt",
  "dd",
  "tr",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "figcaption",
  "fieldset",
  "address",
  "details",
  "summary",
  "body",
  "html",
]);

const CELL_ELEMENTS = new Set(["td", "th"]);

function extractTextFromHtml(html: string): string {
  // Output is accumulated as parts and joined once; state tracks the tail so no step rescans it.
  const parts: string[] = [];
  let trailingNewlines = 0;
  let pendingSpace = false;
  let skipDepth = 0;
  let preDepth = 0;
  const omittedElements = new Set([
    "script",
    "style",
    "noscript",
    "iframe",
    "object",
    "embed",
    "template",
  ]);
  const emit = (value: string): void => {
    if (value.length === 0) return;
    parts.push(value);
    let newlines = 0;
    while (newlines < value.length && value[value.length - 1 - newlines] === "\n") newlines++;
    trailingNewlines = newlines === value.length ? trailingNewlines + newlines : newlines;
  };
  // Ensure the text ends with at least `newlines` line breaks, without adding to existing ones.
  const breakLine = (newlines: number): void => {
    pendingSpace = false;
    if (parts.length === 0) return;
    emit("\n".repeat(Math.max(0, newlines - trailingNewlines)));
  };
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || omittedElements.has(name)) {
        skipDepth++;
        return;
      }
      if (name === "br") {
        pendingSpace = false;
        if (parts.length > 0 && (preDepth > 0 || trailingNewlines < 2)) emit("\n");
      } else if (PARAGRAPH_ELEMENTS.has(name)) breakLine(2);
      else if (LINE_ELEMENTS.has(name)) breakLine(1);
      if (name === "pre") preDepth++;
    },
    ontext(value) {
      if (skipDepth > 0) return;
      if (preDepth > 0) {
        emit(value);
        return;
      }
      const core = value.trim().replace(/\s+/g, " ");
      const atLineStart = parts.length === 0 || trailingNewlines > 0;
      const spaceBefore = pendingSpace || /^\s/.test(value);
      if (core.length > 0) {
        emit(spaceBefore && !atLineStart ? ` ${core}` : core);
        pendingSpace = /\s$/.test(value);
      } else if (!atLineStart && /\s/.test(value)) {
        pendingSpace = true;
      }
    },
    onclosetag(name) {
      if (skipDepth > 0) {
        skipDepth--;
        return;
      }
      if (name === "pre") preDepth = Math.max(0, preDepth - 1);
      if (PARAGRAPH_ELEMENTS.has(name)) breakLine(2);
      else if (LINE_ELEMENTS.has(name)) breakLine(1);
      else if (CELL_ELEMENTS.has(name) && trailingNewlines === 0) pendingSpace = true;
    },
  });
  parser.write(html);
  parser.end();
  return parts.join("").replace(/^\n+/, "").trimEnd();
}

const CHROME_REMOVED_STEM = "Site chrome outside the main content was removed";
const CHROME_REMOVED_NOTE = `${CHROME_REMOVED_STEM}.`;

/** The note for a page whose chrome removal dropped `main`'s text, or undefined when none was dropped. */
function chromeNote(main: HtmlMainContent): string | undefined {
  if (main.largeRemovalPercent !== undefined) {
    return `${CHROME_REMOVED_STEM} (${main.largeRemovalPercent}% of page text); use format: html for the full page.`;
  }
  return main.chromeRemoved ? CHROME_REMOVED_NOTE : undefined;
}

function firstLine(text: string): string {
  return text.trimStart().split("\n", 1)[0]?.trim() ?? "";
}

function newTurndown(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  turndown.remove(["script", "style", "meta", "link"]);
  return turndown;
}

function turndownInChunks(turndown: TurndownService, html: string): string {
  return convertHtmlInChunks(html, (chunk) => turndown.turndown(chunk), extractTextFromHtml);
}

/**
 * Convert HTML to Markdown or plain text, keeping the main content, the page title, and a note when
 * chrome was dropped. Pages without identifiable main content convert whole.
 */
function convertHtmlPage(html: string, format: "markdown" | "text"): string {
  const main = extractMainContent(html);
  if (main === undefined) {
    return format === "markdown"
      ? turndownInChunks(newTurndown(), html)
      : extractTextFromHtml(html);
  }
  if (format === "text") {
    const body = extractTextFromHtml(main.html);
    const note = chromeNote(main);
    const bracketed = note === undefined ? undefined : `[${note}]`;
    const heading = firstLine(body) === main.title ? undefined : main.title;
    return [heading, bracketed, body].filter((part) => part !== undefined).join("\n\n");
  }
  const turndown = newTurndown();
  const body = turndownInChunks(turndown, main.html);
  // Escape the title as Turndown escapes text, so `Foo_bar` matches a `# Foo\_bar` heading.
  const title = main.title === undefined ? undefined : turndown.escape(main.title);
  const heading =
    title === undefined || firstLine(body).replace(/^#+\s*/, "") === title
      ? undefined
      : `# ${title}`;
  const note = chromeNote(main);
  const emphasized = note === undefined ? undefined : `*${note}*`;
  return [heading, emphasized, body].filter((part) => part !== undefined).join("\n\n");
}

function convertFetchedContent(content: string, mime: string, format: WebFetchFormat): string {
  if (mime !== "text/html" || format === "html") return content;
  return convertHtmlPage(content, format);
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
    throw new WebHttpStatusError(response.status);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const mime = normalizedMime(contentType);
  if (!isTextualMime(mime)) {
    await cancelResponse(response);
    throw new WebInputError(
      `unsupported content type ${truncatedMime(mime)} (Web Fetch returns text only; for a document such as a PDF, download it and convert it to text locally)`,
    );
  }

  const body = await readBoundedResponseBody(response, WEB_FETCH_MAX_RESPONSE_BYTES, signal);
  return {
    content: convertFetchedContent(new TextDecoder().decode(body), mime, format),
    contentType,
    finalUrl: redactWebUrlUserinfo(response.url || parsedUrl.toString()),
  };
}

/** The lines of fetched text a call asked for, and where they sit in the whole text. */
type LineWindow = {
  readonly text: string;
  readonly window: WebToolLineWindow;
  /** Last source line `text` holds. */
  readonly lastLine: number;
  /** Whether the call asked for a window at all. */
  readonly requested: boolean;
};

/**
 * Select `limit` lines from the 1-indexed `offset`, counted like Pi's `read` tool. Without either
 * argument the text is returned whole.
 */
function selectLineWindow(
  content: string,
  offset: number | undefined,
  limit: number | undefined,
): LineWindow {
  const lines = content.split("\n");
  const start = (offset ?? 1) - 1;
  if (start >= lines.length) {
    throw new WebInputError(
      `Offset ${offset} is beyond end of content (${lines.length} lines total)`,
    );
  }
  const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
  const window = { firstLine: start + 1, totalLines: lines.length };
  const requested = offset !== undefined || limit !== undefined;
  const text = requested ? lines.slice(start, end).join("\n") : content;
  return { text, window, lastLine: end, requested };
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
              "invalid parameters (expected a url string with optional format, timeout, offset, and limit)",
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
      let fetched: FetchedText;
      try {
        fetched = await fetchText(parsedUrl, format, signal, options);
      } catch (error) {
        // Dead links, blocked pages, bad input, and user cancellation are not failures the Skill diagnoses.
        throw unableToFetch(safeUrl, describeWebFailure(error, { callerSignal, timeoutMs }));
      }
      let selected: LineWindow;
      try {
        selected = selectLineWindow(fetched.content, input.offset, input.limit);
      } catch (error) {
        throw unableToFetch(safeUrl, describeWebFailure(error));
      }
      // Spilling the full output is local work; its failures are not Web Fetch transport failures.
      const output = await createWebToolOutput(selected.text, { window: selected.window });
      const structured = boundWebToolStructuredText(selected.text);
      const structuredContent: WebFetchOutput = {
        url: fetched.finalUrl,
        content_type: fetched.contentType,
        format,
        content: structured.content,
        truncated: output.truncation !== undefined,
        structured_truncated: structured.truncated,
      };
      if (selected.requested) {
        structuredContent.total_lines = selected.window.totalLines;
        // A cut `content` ends inside the window, so the next line after the window would skip lines.
        if (!structured.truncated && selected.lastLine < selected.window.totalLines) {
          structuredContent.next_offset = selected.lastLine + 1;
        }
      }
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
    },
  });
}
