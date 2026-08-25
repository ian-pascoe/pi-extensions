/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- MCP Transcript Presentation owns Pi's untyped historical result, tool-argument, and custom-message rendering boundaries. */
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  keyText,
  truncateHead,
  type AgentToolResult,
  type MessageRenderer,
  type MessageRenderOptions,
  type Theme,
  type ThemeColor,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Spacer,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { McpModelContent } from "./mcp-content.js";

const MCP_DETAILS_OWNER = "pi-mcp";
const MCP_PRESENTATION_ELLIPSIS = "…";
const MCP_PRESENTATION_FULL_RESET = "\u001b[0m";
const MCP_PRESENTATION_TEXT_STYLE_RESET = "\u001b[22;39m";
const MCP_PRESENTATION_METADATA_LIMIT = 20;
const MCP_PRESENTATION_RESERVED_BYTES = 8 * 1024;
const MCP_PRESENTATION_RESERVED_LINES = 64;
const McpResultDetailsMarkerSchema = Type.Object(
  {
    mcp: Type.Object(
      {
        isError: Type.Boolean(),
        operation: Type.Optional(Type.String()),
        outputSchemaError: Type.Optional(Type.String()),
        outputSchemaValid: Type.Optional(Type.Boolean()),
        owner: Type.Literal(MCP_DETAILS_OWNER),
        serverId: Type.Optional(Type.String()),
        toolName: Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),
    result: Type.Any(),
  },
  { additionalProperties: true },
);

/** Theme operations used by MCP Transcript Presentation and custom-message renderers. */
export type McpRenderTheme = Pick<Theme, "bg" | "bold" | "fg">;

/** Exact-value redactor applied only to human-facing MCP presentation copy. */
export type McpPresentationRedactor = (text: string) => string;

/** Existing MCP result marker persisted beside model-visible tool content. */
export interface McpResultMarker {
  readonly isError: boolean;
  readonly operation?: string;
  readonly outputSchemaError?: string;
  readonly outputSchemaValid?: boolean;
  readonly owner: typeof MCP_DETAILS_OWNER;
  readonly serverId?: string;
  readonly toolName?: string;
}

/** Existing persisted MCP tool details consumed without changing their stored shape. */
export interface McpResultDetails {
  readonly mcp: McpResultMarker;
  readonly result: unknown;
}

/** One role-faithful Prompt message persisted for context replay and TUI presentation. */
export interface McpPromptReplayMessage {
  readonly content: readonly McpModelContent[];
  readonly role: "assistant" | "user";
  readonly timestamp: number;
}

/** Version-1 MCP Prompt details already persisted in Pi custom messages. */
export interface McpPromptMessageDetails {
  readonly mcpMessages: readonly unknown[];
  readonly replayMessages: readonly McpPromptReplayMessage[];
  readonly version: 1;
}

/** Durable custom-message fields needed by MCP Prompt and Resource Update renderers. */
export type McpPresentationMessage = Pick<Parameters<MessageRenderer>[0], "content" | "details">;

/** Fixed Resource operation rendered in MCP Transcript Presentation. */
export type McpResourcePresentationOperation =
  | "list_resources"
  | "list_resource_templates"
  | "read_resource";

const identityRedactor: McpPresentationRedactor = (text) => text;

function truncateMcpPresentationToWidth(text: string, width: number): string {
  const availableWidth = Math.max(1, width);
  if (visibleWidth(text) <= availableWidth) return text;
  const truncated = truncateToWidth(text, availableWidth - 1, "");
  const prefix = truncated.endsWith(MCP_PRESENTATION_FULL_RESET)
    ? truncated.slice(0, -MCP_PRESENTATION_FULL_RESET.length)
    : truncated;
  return `${prefix}${MCP_PRESENTATION_TEXT_STYLE_RESET}${MCP_PRESENTATION_ELLIPSIS}${MCP_PRESENTATION_TEXT_STYLE_RESET}`;
}

class McpSingleLine implements Component {
  constructor(private readonly text: string) {}

  invalidate(): void {}

  render(width: number): string[] {
    return [truncateMcpPresentationToWidth(this.text, width)];
  }
}

/** Remove terminal sequences and unsafe C0/C1 controls while preserving line breaks and tabs. */
export function sanitizeMcpPresentationText(text: string): string {
  return (
    stripTerminalSequences(text)
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      // oxlint-disable-next-line eslint/no-control-regex -- SAFETY: Transcript text permits tabs/newlines but no other C0/C1 terminal controls.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
  );
}

function presentationText(text: string, redact: McpPresentationRedactor): string {
  return sanitizeMcpPresentationText(redact(text));
}

function boundedMcpPreview(text: string, redact: McpPresentationRedactor, width = 160): string {
  const safe = presentationText(text, redact).replace(/\s+/g, " ").trim();
  if (visibleWidth(safe) <= width) return safe;
  return truncateMcpPresentationToWidth(safe, width);
}

function boundedMcpMetadataText(
  text: string,
  redact: McpPresentationRedactor,
  width: number,
  maxBytes: number,
): string {
  const columns = truncateMcpPresentationToWidth(
    presentationText(text, redact).replace(/\s+/g, " ").trim(),
    width,
  );
  const bytes = truncateHead(columns, { maxBytes: maxBytes - 3, maxLines: 1 });
  return bytes.truncated ? `${bytes.content}${MCP_PRESENTATION_ELLIPSIS}` : columns;
}

function boundedMcpText(text: string, redact: McpPresentationRedactor): string {
  const safe = presentationText(text, redact);
  const truncation = truncateHead(safe, {
    maxBytes: DEFAULT_MAX_BYTES - MCP_PRESENTATION_RESERVED_BYTES,
    maxLines: DEFAULT_MAX_LINES - MCP_PRESENTATION_RESERVED_LINES,
  });
  if (!truncation.truncated) return safe;
  const omittedLines = Math.max(0, truncation.totalLines - truncation.outputLines);
  const notice =
    omittedLines === 0
      ? "… output truncated"
      : `… ${omittedLines} line${omittedLines === 1 ? "" : "s"} omitted`;
  return truncation.content.length === 0 ? notice : `${truncation.content}\n${notice}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedPresentationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedPresentationValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedPresentationValue(value[key])]),
  );
}

function stringifyPresentationValue(value: unknown, pretty = false): string {
  try {
    return (
      JSON.stringify(sortedPresentationValue(value), undefined, pretty ? 2 : undefined) ?? "null"
    );
  } catch {
    return "(unavailable)";
  }
}

function argumentPreview(arguments_: unknown, redact: McpPresentationRedactor): string | undefined {
  if (!isRecord(arguments_) || Object.keys(arguments_).length === 0) return undefined;
  return Object.keys(arguments_)
    .sort()
    .map(
      (key) =>
        `${presentationText(key, redact)}=${boundedMcpPreview(stringifyPresentationValue(arguments_[key]), redact, 72)}`,
    )
    .join("  ");
}

function expansionHint(theme: McpRenderTheme): string {
  return `${theme.fg("dim", `  ·  ${keyText("app.tools.expand")}`)}${theme.fg("muted", " to expand")}`;
}

function renderMcpCall(
  heading: string,
  arguments_: unknown,
  theme: McpRenderTheme,
  expanded: boolean,
  redact: McpPresentationRedactor,
  previewArguments: boolean,
): Component {
  const container = new Container();
  const preview = previewArguments ? argumentPreview(arguments_, redact) : undefined;
  container.addChild(
    new McpSingleLine(
      `${heading}${preview === undefined ? "" : `  ${theme.fg("muted", preview)}`}`,
    ),
  );
  if (expanded) {
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(boundedMcpText(stringifyPresentationValue(arguments_, true), redact), 0, 0),
    );
  }
  return container;
}

/** Render one dynamic Server Tool call with its original MCP Server and Server Tool identities. */
export function renderMcpServerToolCall(
  serverId: string,
  toolName: string,
  arguments_: unknown,
  theme: McpRenderTheme,
  expanded: boolean,
  redact: McpPresentationRedactor = identityRedactor,
): Component {
  const heading = [
    theme.fg("toolTitle", theme.bold("MCP")),
    theme.fg(
      "accent",
      `${presentationText(serverId, redact)} / ${presentationText(toolName, redact)}`,
    ),
  ].join("  ");
  return renderMcpCall(heading, arguments_, theme, expanded, redact, true);
}

function resourceOperationLabel(operation: McpResourcePresentationOperation): string {
  switch (operation) {
    case "list_resources":
      return "List Resources";
    case "list_resource_templates":
      return "List Resource Templates";
    case "read_resource":
      return "Read Resource";
  }
}

/** Render one fixed Resource tool call with its semantic operation and selected target. */
export function renderMcpResourceToolCall(
  operation: McpResourcePresentationOperation,
  arguments_: unknown,
  theme: McpRenderTheme,
  expanded: boolean,
  redact: McpPresentationRedactor = identityRedactor,
): Component {
  const record = isRecord(arguments_) ? arguments_ : {};
  const server =
    typeof record.server === "string" ? presentationText(record.server, redact) : undefined;
  const uri = typeof record.uri === "string" ? presentationText(record.uri, redact) : undefined;
  const heading = [
    theme.fg("toolTitle", theme.bold("MCP")),
    theme.fg("accent", resourceOperationLabel(operation)),
    server === undefined ? undefined : theme.fg("muted", server),
    uri === undefined ? undefined : theme.fg("muted", uri),
  ]
    .filter((part): part is string => part !== undefined)
    .join("  ");
  return renderMcpCall(heading, arguments_, theme, expanded, redact, false);
}

/** Parse existing MCP result details at the persisted custom-tool boundary. */
export function parseMcpResultDetails(input: unknown): McpResultDetails | undefined {
  if (!Value.Check(McpResultDetailsMarkerSchema, input)) return undefined;
  // SAFETY: The result schema established every typed field consumed by presentation and the result bridge while permitting historical additional fields.
  return input as McpResultDetails;
}

function parseMcpPromptReplayMessage(value: unknown): McpPromptReplayMessage | undefined {
  if (
    !isRecord(value) ||
    (value.role !== "user" && value.role !== "assistant") ||
    typeof value.timestamp !== "number" ||
    !Array.isArray(value.content)
  ) {
    return undefined;
  }
  const content: McpModelContent[] = [];
  for (const block of value.content) {
    if (!isRecord(block)) return undefined;
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ text: block.text, type: "text" });
      continue;
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      content.push({ data: block.data, mimeType: block.mimeType, type: "image" });
      continue;
    }
    return undefined;
  }
  return { content, role: value.role, timestamp: value.timestamp };
}

/** Parse the existing version-1 role-faithful Prompt replay messages without enriching details. */
export function parseMcpPromptReplayMessages(
  value: unknown,
): readonly McpPromptReplayMessage[] | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.replayMessages)) {
    return undefined;
  }
  const messages: McpPromptReplayMessage[] = [];
  for (const item of value.replayMessages) {
    const parsed = parseMcpPromptReplayMessage(item);
    if (parsed === undefined) return undefined;
    messages.push(parsed);
  }
  return messages;
}

function toolResultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter(
      (content): content is Extract<(typeof result.content)[number], { type: "text" }> =>
        content.type === "text",
    )
    .map((content) => content.text)
    .join("\n");
}

function pluralizedCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function contentCountParts(result: AgentToolResult<unknown>): string[] {
  const textCount = result.content.filter((content) => content.type === "text").length;
  const imageCount = result.content.filter((content) => content.type === "image").length;
  const parts: string[] = [];
  if (textCount > 0) parts.push(pluralizedCount(textCount, "text block"));
  if (imageCount > 0) parts.push(pluralizedCount(imageCount, "image"));
  return parts;
}

function firstUsefulLine(text: string, redact: McpPresentationRedactor): string | undefined {
  const line = presentationText(text, redact)
    .split("\n")
    .map((candidate) => candidate.trim())
    .find(Boolean);
  return line === undefined ? undefined : boundedMcpPreview(line, identityRedactor);
}

interface McpResultSummary {
  readonly color: ThemeColor;
  readonly text: string;
}

function mcpResultSummary(
  result: AgentToolResult<unknown>,
  details: McpResultDetails | undefined,
  isError: boolean,
  redact: McpPresentationRedactor,
): McpResultSummary {
  const text = toolResultText(result);
  const error = isError || details?.mcp.isError === true;
  const usefulLine = firstUsefulLine(text, redact);
  if (error && /\b(?:abort(?:ed)?|cancel(?:led|ed|ation)?)\b/iu.test(text)) {
    return {
      color: "warning",
      text: `■ cancelled${usefulLine === undefined ? "" : `  ·  ${usefulLine}`}`,
    };
  }
  if (error) {
    return {
      color: "error",
      text: `× failed${usefulLine === undefined ? "" : `  ·  ${usefulLine}`}`,
    };
  }
  if (details?.mcp.outputSchemaValid === false) {
    return { color: "warning", text: "! completed with output-schema failure" };
  }
  const counts = contentCountParts(result);
  return {
    color: "success",
    text: `✓ completed  ·  ${counts.length === 0 ? "no content" : counts.join("  ·  ")}`,
  };
}

function renderMcpFallback(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: McpRenderTheme,
  isError: boolean,
  redact: McpPresentationRedactor,
): Component {
  const text = toolResultText(result);
  const safe = boundedMcpText(text, redact);
  const usefulLine = firstUsefulLine(text, redact);
  const summary = mcpResultSummary(result, undefined, isError, redact);
  if (isError) {
    if (options.expanded) {
      const container = new Container();
      container.addChild(new Text(theme.fg(summary.color, summary.text), 0, 0));
      if (safe.length > 0) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(safe, 0, 0));
      }
      return container;
    }
    return new McpSingleLine(theme.fg(summary.color, summary.text));
  }
  if (options.expanded && safe.length > 0) return new Text(safe, 0, 0);
  if (usefulLine !== undefined) {
    const hint = !options.isPartial && text.includes("\n") ? expansionHint(theme) : "";
    return new McpSingleLine(theme.fg(isError ? "error" : "toolOutput", `${usefulLine}${hint}`));
  }
  return new McpSingleLine(theme.fg(summary.color, summary.text));
}

function resultMetadata(value: unknown): {
  readonly spillPath?: string;
  readonly storedContent: readonly Record<string, unknown>[];
  readonly summary?: string;
} {
  if (!isRecord(value)) return { storedContent: [] };
  const storedContent = Array.isArray(value.storedContent)
    ? value.storedContent.filter(isRecord)
    : [];
  return {
    ...(typeof value.spillPath === "string" ? { spillPath: value.spillPath } : {}),
    storedContent,
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
  };
}

function appendMcpResultDetails(
  container: Container,
  result: AgentToolResult<unknown>,
  details: McpResultDetails,
  theme: McpRenderTheme,
  redact: McpPresentationRedactor,
): void {
  const counts = contentCountParts(result);
  container.addChild(
    new Text(
      `${theme.fg("muted", "Content:")} ${counts.length === 0 ? "no content" : counts.join(" · ")}`,
      0,
      0,
    ),
  );
  const text = toolResultText(result);
  if (text.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(boundedMcpText(text, redact), 0, 0));
  }
  const metadata = resultMetadata(details.result);
  for (const stored of metadata.storedContent.slice(0, MCP_PRESENTATION_METADATA_LIMIT)) {
    const fields = [stored.kind, stored.mimeType, stored.uri, stored.path]
      .filter((field): field is string => typeof field === "string")
      .map((field) => boundedMcpMetadataText(field, redact, 240, 256));
    container.addChild(
      new Text(`${theme.fg("muted", "Stored content:")} ${fields.join(" · ")}`, 0, 0),
    );
  }
  if (metadata.storedContent.length > MCP_PRESENTATION_METADATA_LIMIT) {
    container.addChild(
      new Text(
        theme.fg(
          "muted",
          `Stored content: ${metadata.storedContent.length - MCP_PRESENTATION_METADATA_LIMIT} more entries omitted`,
        ),
        0,
        0,
      ),
    );
  }
  if (details.mcp.outputSchemaValid === false) {
    const outcome =
      details.mcp.outputSchemaError === undefined
        ? "failed"
        : `failed · ${boundedMcpPreview(details.mcp.outputSchemaError, redact)}`;
    container.addChild(new Text(`${theme.fg("warning", "Output schema:")} ${outcome}`, 0, 0));
  }
  if (metadata.spillPath !== undefined) {
    container.addChild(
      new Text(
        `${theme.fg("muted", "Result Spill:")} ${boundedMcpMetadataText(metadata.spillPath, redact, 1_000, 1_024)}`,
        0,
        0,
      ),
    );
  }
}

/** Render final or partial MCP tool output without changing its model-visible content or details. */
export function renderMcpToolResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: McpRenderTheme,
  isError: boolean,
  redact: McpPresentationRedactor = identityRedactor,
): Component {
  if (options.isPartial) {
    const details = isRecord(result.details) ? result.details : undefined;
    const progress =
      details === undefined || !("progress" in details)
        ? undefined
        : boundedMcpPreview(stringifyPresentationValue(details.progress), redact, 120);
    return new McpSingleLine(
      theme.fg("accent", `Running…${progress === undefined ? "" : `  ·  ${progress}`}`),
    );
  }
  const details = parseMcpResultDetails(result.details);
  if (details === undefined) return renderMcpFallback(result, options, theme, isError, redact);
  const summary = mcpResultSummary(result, details, isError, redact);
  if (!options.expanded) {
    const hasDetails =
      toolResultText(result).length > 0 || resultMetadata(details.result).storedContent.length > 0;
    return new McpSingleLine(
      `${theme.fg(summary.color, summary.text)}${hasDetails ? expansionHint(theme) : ""}`,
    );
  }
  const container = new Container();
  container.addChild(new Text(theme.fg(summary.color, summary.text), 0, 0));
  container.addChild(new Spacer(1));
  appendMcpResultDetails(container, result, details, theme, redact);
  return container;
}

function customMessageText(message: McpPresentationMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function promptIdentity(
  content: string,
): { readonly prompt: string; readonly server: string } | undefined {
  const prefix = "MCP Prompt ";
  if (!content.startsWith(prefix)) return undefined;
  const identity = content.slice(prefix.length);
  const separator = identity.indexOf("/");
  if (separator <= 0 || separator === identity.length - 1) return undefined;
  return { prompt: identity.slice(separator + 1), server: identity.slice(0, separator) };
}

function messageBox(options: MessageRenderOptions, theme: McpRenderTheme): Box {
  return new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
}

/** Render an existing Prompt custom message from its version-1 replay details or durable content. */
export function renderMcpPromptMessage(
  message: McpPresentationMessage,
  options: MessageRenderOptions,
  theme: McpRenderTheme,
  redact: McpPresentationRedactor = identityRedactor,
): Component {
  const box = messageBox(options, theme);
  const content = customMessageText(message);
  const replay = parseMcpPromptReplayMessages(message.details);
  const identity = promptIdentity(content);
  if (replay === undefined || identity === undefined) {
    box.addChild(new Text(boundedMcpText(content, redact), 0, 0));
    return box;
  }
  const roles = [...new Set(replay.map((entry) => entry.role))].join(", ");
  const heading = [
    theme.fg("accent", theme.bold("MCP Prompt")),
    `${boundedMcpMetadataText(identity.server, redact, 120, 256)} / ${boundedMcpMetadataText(identity.prompt, redact, 120, 256)}`,
    theme.fg("muted", pluralizedCount(replay.length, "message")),
    roles.length === 0 ? undefined : theme.fg("muted", roles),
  ]
    .filter((part): part is string => part !== undefined)
    .join("  ");
  box.addChild(new Text(heading, 0, 0));
  if (!options.expanded) return box;
  const expandedMessages: string[] = [];
  for (const entry of replay) {
    expandedMessages.push(entry.role === "user" ? "User" : "Assistant");
    for (const block of entry.content) {
      if (block.type === "text") {
        expandedMessages.push(block.text);
      } else {
        expandedMessages.push(
          `${entry.role === "user" ? "User" : "Assistant"} image: ${block.mimeType}`,
        );
      }
    }
  }
  box.addChild(new Spacer(1));
  box.addChild(new Text(boundedMcpText(expandedMessages.join("\n"), redact), 0, 0));
  return box;
}

function resourceUpdateIdentity(
  content: string,
): { readonly server: string; readonly uri: string } | undefined {
  const match =
    /^MCP Resource updated on (.*?): (.*?)\. Read it explicitly before using the new content\.$/u.exec(
      content,
    );
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { server: match[1], uri: match[2] };
}

/** Render a Resource Update Notice without reading the Resource or triggering a model turn. */
export function renderMcpResourceUpdateMessage(
  message: McpPresentationMessage,
  options: MessageRenderOptions,
  theme: McpRenderTheme,
  redact: McpPresentationRedactor = identityRedactor,
): Component {
  const box = messageBox(options, theme);
  const content = customMessageText(message);
  const identity = resourceUpdateIdentity(content);
  if (identity === undefined) {
    box.addChild(new Text(boundedMcpText(content, redact), 0, 0));
    return box;
  }
  box.addChild(
    new Text(
      [
        theme.fg("accent", theme.bold("MCP Resource Update")),
        boundedMcpMetadataText(identity.server, redact, 120, 256),
        theme.fg("muted", boundedMcpMetadataText(identity.uri, redact, 240, 512)),
      ].join("  "),
      0,
      0,
    ),
  );
  if (options.expanded) {
    box.addChild(new Spacer(1));
    box.addChild(
      new Text(
        theme.fg("muted", "The Resource remains unread until the agent explicitly reads it."),
        0,
        0,
      ),
    );
  }
  return box;
}
