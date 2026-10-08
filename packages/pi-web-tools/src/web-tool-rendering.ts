import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  getMarkdownTheme,
  truncateHead,
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  sliceByColumn,
  Spacer,
  stripTerminalSequences,
  Text,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { WebFetchDetails, WebFetchParameters } from "./web-fetch.js";
import type { WebSearchDetails, WebSearchParameters } from "./web-search.js";
import type { WebToolTruncationDetails } from "./web-tool-output.js";
import { redactWebUrlUserinfo, webFetchUrlTarget } from "./web-url.js";
import { stripControlCharacters } from "@ian-pascoe/pi-utils";
import {
  COLLAPSED_LINES,
  appendDurationFooter,
  callDurationFooter,
  joinInline,
  previewBody,
  summaryExpandHint,
  toolHeader,
  type DurationContext,
} from "@ian-pascoe/pi-utils/ui";

/** Theme operations used by Web Search and Web Fetch Transcript Presentation. */
export type WebToolRenderTheme = Pick<Theme, "bold" | "fg">;

function sanitizeWebToolPresentationText(text: string): string {
  return stripControlCharacters(stripTerminalSequences(text));
}

function boundedWebToolPreview(text: string, width = 72): string {
  const singleLine = sanitizeWebToolPresentationText(text).replace(/\s+/g, " ").trim();
  if (visibleWidth(singleLine) <= width) return singleLine;
  return `${sliceByColumn(singleLine, 0, width - 3, true).trimEnd()}...`;
}

function boundedWebToolText(text: string): string {
  const safe = sanitizeWebToolPresentationText(text);
  const bounded = truncateHead(safe, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  return bounded.truncated ? `${bounded.content}\n... output truncated in Transcript` : safe;
}

function toolResultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
}

/** The parts of Pi's render context the Web Tool call rows read. */
export type WebToolCallContext = DurationContext & { expanded: boolean };

function argumentLine(theme: WebToolRenderTheme, key: string, value: string | number): string {
  return theme.fg("muted", `${key}: ${sanitizeWebToolPresentationText(String(value))}`);
}

function appendField(
  container: Container,
  theme: WebToolRenderTheme,
  label: string,
  value: string | number,
): void {
  container.addChild(new Text(argumentLine(theme, label, value), 0, 0));
}

function appendTruncationDetails(
  container: Container,
  theme: WebToolRenderTheme,
  truncation: WebToolTruncationDetails,
): void {
  appendField(
    container,
    theme,
    "visible",
    `${truncation.outputLines} of ${truncation.totalLines} lines · ${truncation.outputBytes} of ${truncation.totalBytes} bytes`,
  );
  appendField(container, theme, "complete output", truncation.fullOutputPath);
}

function renderWebToolCall(
  toolName: "web_search" | "web_fetch",
  target: string,
  argumentLines: readonly string[],
  theme: WebToolRenderTheme,
  context: WebToolCallContext,
): Component {
  const container = new Container();
  container.addChild(new Text(toolHeader(theme, toolName, boundedWebToolPreview(target)), 0, 0));
  if (context.expanded && argumentLines.length > 0) {
    container.addChild(new Text(argumentLines.join("\n"), 0, 0));
  }
  container.addChild(callDurationFooter(theme, context));
  return container;
}

/** Render a Web Search call with its query and, expanded, its explicit search controls. */
export function renderWebSearchToolCall(
  parameters: WebSearchParameters,
  theme: WebToolRenderTheme,
  context: WebToolCallContext,
): Component {
  const query = JSON.stringify(sanitizeWebToolPresentationText(parameters.query));
  const argumentLines: string[] = [];
  if (parameters.numResults !== undefined)
    argumentLines.push(argumentLine(theme, "numResults", parameters.numResults));
  if (parameters.contextMaxCharacters !== undefined)
    argumentLines.push(
      argumentLine(theme, "contextMaxCharacters", parameters.contextMaxCharacters),
    );
  return renderWebToolCall("web_search", query, argumentLines, theme, context);
}

/** Render a Web Fetch call with a credential-safe URL and, expanded, its retrieval controls. */
export function renderWebFetchToolCall(
  parameters: WebFetchParameters,
  theme: WebToolRenderTheme,
  context: WebToolCallContext,
): Component {
  const argumentLines = [argumentLine(theme, "url", redactWebUrlUserinfo(parameters.url))];
  if (parameters.format !== undefined)
    argumentLines.push(argumentLine(theme, "format", parameters.format));
  if (parameters.timeout !== undefined)
    argumentLines.push(argumentLine(theme, "timeout", `${parameters.timeout}s`));
  if (parameters.offset !== undefined)
    argumentLines.push(argumentLine(theme, "offset", parameters.offset));
  if (parameters.limit !== undefined)
    argumentLines.push(argumentLine(theme, "limit", parameters.limit));
  return renderWebToolCall(
    "web_fetch",
    webFetchUrlTarget(parameters.url),
    argumentLines,
    theme,
    context,
  );
}

function webSearchSummary(details: WebSearchDetails, theme: WebToolRenderTheme): string {
  return joinInline(theme, [
    theme.fg("muted", details.provider === "exa" ? "Exa" : "Parallel"),
    details.truncation === undefined ? undefined : theme.fg("warning", "truncated"),
  ]);
}

function webFetchSummary(details: WebFetchDetails, theme: WebToolRenderTheme): string {
  return joinInline(theme, [
    theme.fg("muted", details.format),
    details.contentType.length === 0
      ? undefined
      : theme.fg("muted", sanitizeWebToolPresentationText(details.contentType)),
    details.truncation === undefined ? undefined : theme.fg("warning", "truncated"),
  ]);
}

function outputLines(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

function renderWebToolFailure(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: WebToolRenderTheme,
  context: DurationContext,
  fallback: string,
): Component {
  const lines = outputLines(boundedWebToolText(toolResultText(result)));
  const container = new Container();
  container.addChild(
    new Text(
      previewBody(theme, lines.length === 0 ? [fallback] : lines, {
        limit: COLLAPSED_LINES.fallback,
        expanded: options.expanded,
        color: "error",
      }).join("\n"),
      0,
      0,
    ),
  );
  appendDurationFooter(container, theme, context, { isPartial: false });
  return container;
}

function appendWebToolMarkdown(container: Container, output: string): void {
  container.addChild(new Spacer(1));
  container.addChild(new Markdown(output || "(no output)", 0, 0, getMarkdownTheme()));
}

function appendWebToolText(container: Container, output: string, theme: WebToolRenderTheme): void {
  container.addChild(new Spacer(1));
  container.addChild(
    new Text(
      (output || "(no output)")
        .split("\n")
        .map((line) => theme.fg("toolOutput", line))
        .join("\n"),
      0,
      0,
    ),
  );
}

/** Render a Web Search result like grep: provenance, then up to 15 lines, Markdown on expansion. */
export function renderWebSearchToolResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: WebToolRenderTheme,
  context: DurationContext,
  isError: boolean,
  details: WebSearchDetails | undefined,
): Component {
  if (options.isPartial) {
    const container = new Container();
    appendDurationFooter(container, theme, context, { isPartial: true });
    return container;
  }
  if (isError || details === undefined) {
    return renderWebToolFailure(result, options, theme, context, "Web Search failed");
  }
  const container = new Container();
  container.addChild(new Text(webSearchSummary(details, theme), 0, 0));
  const output = boundedWebToolText(toolResultText(result));
  if (options.expanded) {
    if (details.truncation !== undefined)
      appendTruncationDetails(container, theme, details.truncation);
    appendWebToolMarkdown(container, output);
  } else {
    const lines = outputLines(output);
    if (lines.length > 0) {
      container.addChild(
        new Text(
          previewBody(theme, lines, { limit: COLLAPSED_LINES.search, expanded: false }).join("\n"),
          0,
          0,
        ),
      );
    }
  }
  appendDurationFooter(container, theme, context, { isPartial: false });
  return container;
}

/** Render a Web Fetch result like read: format metadata only, the page content on expansion. */
export function renderWebFetchToolResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: WebToolRenderTheme,
  context: DurationContext,
  isError: boolean,
  details: WebFetchDetails | undefined,
): Component {
  if (options.isPartial) {
    const container = new Container();
    appendDurationFooter(container, theme, context, { isPartial: true });
    return container;
  }
  if (isError || details === undefined) {
    return renderWebToolFailure(result, options, theme, context, "Web Fetch failed");
  }
  const summary = webFetchSummary(details, theme);
  const container = new Container();
  if (!options.expanded) {
    container.addChild(new Text(`${summary}${summaryExpandHint(theme)}`, 0, 0));
    appendDurationFooter(container, theme, context, { isPartial: false });
    return container;
  }
  container.addChild(new Text(summary, 0, 0));
  appendField(container, theme, "url", redactWebUrlUserinfo(details.url));
  if (details.truncation !== undefined)
    appendTruncationDetails(container, theme, details.truncation);
  const output = boundedWebToolText(toolResultText(result));
  if (details.format === "markdown") appendWebToolMarkdown(container, output);
  else appendWebToolText(container, output, theme);
  appendDurationFooter(container, theme, context, { isPartial: false });
  return container;
}
