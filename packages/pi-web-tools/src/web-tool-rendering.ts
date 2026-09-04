import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  getMarkdownTheme,
  keyText,
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

/** Theme operations used by Web Search and Web Fetch Transcript Presentation. */
export type WebToolRenderTheme = Pick<Theme, "bold" | "fg">;

function sanitizeWebToolPresentationText(text: string): string {
  return (
    stripTerminalSequences(text)
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      // oxlint-disable-next-line eslint/no-control-regex -- Transcript text permits tabs/newlines but must remove every remaining C0/C1 terminal control.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
  );
}

function boundedWebToolPreview(text: string, width = 72): string {
  const singleLine = sanitizeWebToolPresentationText(text).replace(/\s+/g, " ").trim();
  if (visibleWidth(singleLine) <= width) return singleLine;
  return `${sliceByColumn(singleLine, 0, width - 1, true).trimEnd()}…`;
}

function boundedWebToolText(text: string): string {
  const safe = sanitizeWebToolPresentationText(text);
  const bounded = truncateHead(safe, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  return bounded.truncated ? `${bounded.content}\n… output truncated in Transcript` : safe;
}

function toolResultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
}

function expansionHint(theme: WebToolRenderTheme): string {
  return `${theme.fg("dim", `  ·  ${keyText("app.tools.expand")}`)}${theme.fg("muted", " to expand")}`;
}

function appendField(
  container: Container,
  theme: WebToolRenderTheme,
  label: string,
  value: string | number,
): void {
  container.addChild(
    new Text(
      `${theme.fg("muted", `${label}:`)} ${sanitizeWebToolPresentationText(String(value))}`,
      0,
      0,
    ),
  );
}

function appendTruncationDetails(
  container: Container,
  theme: WebToolRenderTheme,
  truncation: WebToolTruncationDetails,
): void {
  appendField(
    container,
    theme,
    "Visible",
    `${truncation.outputLines} of ${truncation.totalLines} lines · ${truncation.outputBytes} of ${truncation.totalBytes} bytes`,
  );
  appendField(container, theme, "Complete output", truncation.fullOutputPath);
}

function renderWebToolCallHeader(
  operation: "Search" | "Fetch",
  target: string,
  theme: WebToolRenderTheme,
): string {
  return [
    theme.fg("toolTitle", theme.bold("Web")),
    theme.fg("accent", operation),
    theme.fg("muted", boundedWebToolPreview(target)),
  ].join("  ");
}

/** Render a Web Search call with its query and explicit search controls. */
export function renderWebSearchToolCall(
  parameters: WebSearchParameters,
  theme: WebToolRenderTheme,
  expanded: boolean,
): Component {
  const container = new Container();
  const query = JSON.stringify(sanitizeWebToolPresentationText(parameters.query));
  container.addChild(new Text(renderWebToolCallHeader("Search", query, theme), 0, 0));
  const hasOptions =
    parameters.numResults !== undefined ||
    parameters.type !== undefined ||
    parameters.livecrawl !== undefined ||
    parameters.contextMaxCharacters !== undefined;
  if (!expanded || !hasOptions) return container;
  container.addChild(new Spacer(1));
  if (parameters.numResults !== undefined)
    appendField(container, theme, "Results", parameters.numResults);
  if (parameters.type !== undefined) appendField(container, theme, "Search type", parameters.type);
  if (parameters.livecrawl !== undefined)
    appendField(container, theme, "Live crawl", parameters.livecrawl);
  if (parameters.contextMaxCharacters !== undefined)
    appendField(container, theme, "Context", `${parameters.contextMaxCharacters} characters`);
  return container;
}

/** Render a Web Fetch call with a credential-safe URL and explicit retrieval controls. */
export function renderWebFetchToolCall(
  parameters: WebFetchParameters,
  theme: WebToolRenderTheme,
  expanded: boolean,
): Component {
  const container = new Container();
  container.addChild(
    new Text(renderWebToolCallHeader("Fetch", webFetchUrlTarget(parameters.url), theme), 0, 0),
  );
  if (!expanded) return container;
  container.addChild(new Spacer(1));
  appendField(container, theme, "URL", redactWebUrlUserinfo(parameters.url));
  if (parameters.format !== undefined) appendField(container, theme, "Format", parameters.format);
  if (parameters.timeout !== undefined)
    appendField(container, theme, "Timeout", `${parameters.timeout}s`);
  return container;
}

function webSearchSummary(details: WebSearchDetails, theme: WebToolRenderTheme): string {
  const provider = details.provider === "exa" ? "Exa" : "Parallel";
  return [
    theme.fg("success", "✓ completed"),
    theme.fg("muted", provider),
    details.truncation === undefined ? undefined : theme.fg("warning", "truncated"),
  ]
    .filter((part): part is string => part !== undefined)
    .join(theme.fg("dim", "  ·  "));
}

function webFetchSummary(details: WebFetchDetails, theme: WebToolRenderTheme): string {
  return [
    theme.fg("success", "✓ fetched"),
    theme.fg("muted", details.format),
    details.contentType.length === 0 ? undefined : theme.fg("muted", details.contentType),
    details.truncation === undefined ? undefined : theme.fg("warning", "truncated"),
  ]
    .filter((part): part is string => part !== undefined)
    .join(theme.fg("dim", "  ·  "));
}

function renderWebToolFallback(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: WebToolRenderTheme,
  isError: boolean,
  fallback: string,
): Component {
  const output = boundedWebToolText(toolResultText(result));
  const firstLine = output.split("\n").find((line) => line.trim().length > 0) ?? fallback;
  const visible = options.expanded ? output || fallback : firstLine;
  const hint = !options.expanded && output.includes("\n") ? expansionHint(theme) : "";
  return new Text(theme.fg(isError ? "error" : "toolOutput", `${visible}${hint}`), 0, 0);
}

function appendWebToolOutput(
  container: Container,
  output: string,
  markdown: boolean,
  theme: WebToolRenderTheme,
): void {
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", theme.bold("Result")), 0, 0));
  const visible = output || "(no output)";
  container.addChild(
    markdown
      ? new Markdown(visible, 0, 0, getMarkdownTheme())
      : new Text(theme.fg("toolOutput", visible), 0, 0),
  );
}

/** Render a Web Search result as provider provenance with Markdown on expansion. */
export function renderWebSearchToolResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: WebToolRenderTheme,
  isError: boolean,
  details: WebSearchDetails | undefined,
): Component {
  if (options.isPartial) return new Text(theme.fg("accent", "Searching…"), 0, 0);
  if (isError || details === undefined) {
    return renderWebToolFallback(result, options, theme, isError, "Web Search failed");
  }
  const summary = webSearchSummary(details, theme);
  if (!options.expanded) {
    return new Text(`${summary}${expansionHint(theme)}`, 0, 0);
  }
  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  container.addChild(new Spacer(1));
  appendField(container, theme, "Provider", details.provider === "exa" ? "Exa" : "Parallel");
  if (details.truncation !== undefined)
    appendTruncationDetails(container, theme, details.truncation);
  appendWebToolOutput(container, boundedWebToolText(toolResultText(result)), true, theme);
  return container;
}

/** Render a Web Fetch result as format metadata with format-aware expanded content. */
export function renderWebFetchToolResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: WebToolRenderTheme,
  isError: boolean,
  details: WebFetchDetails | undefined,
): Component {
  if (options.isPartial) return new Text(theme.fg("accent", "Fetching…"), 0, 0);
  if (isError || details === undefined) {
    return renderWebToolFallback(result, options, theme, isError, "Web Fetch failed");
  }
  const summary = webFetchSummary(details, theme);
  if (!options.expanded) {
    return new Text(`${summary}${expansionHint(theme)}`, 0, 0);
  }
  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  container.addChild(new Spacer(1));
  appendField(container, theme, "URL", redactWebUrlUserinfo(details.url));
  appendField(container, theme, "Format", details.format);
  appendField(container, theme, "Content type", details.contentType || "(not provided)");
  if (details.truncation !== undefined)
    appendTruncationDetails(container, theme, details.truncation);
  appendWebToolOutput(
    container,
    boundedWebToolText(toolResultText(result)),
    details.format === "markdown",
    theme,
  );
  return container;
}
