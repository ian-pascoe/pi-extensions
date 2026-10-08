import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import {
  callDurationFooter,
  COLLAPSED_LINES,
  appendDurationFooter,
  previewBody,
  toolHeader,
  type DurationContext,
} from "@ian-pascoe/pi-utils/ui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { lspToolName, type LspOperationName } from "./lsp-tool-contract.js";
import { lspDisplayPath } from "./lsp-location-text.js";

/** Theme operations used by Pi LSP tool transcript rendering. */
export type LspRenderTheme = Pick<Theme, "bold" | "fg">;

/** What the call row reads from Pi's render context. */
export type LspCallRenderContext = DurationContext & { expanded: boolean; cwd: string };

/** What the result row reads from Pi's render context. */
export type LspResultRenderContext = DurationContext & { isError: boolean };

const LspRenderRecordSchema = Type.Record(Type.String(), Type.Unknown());
/** The call fields shown in a compact row; Pi renders raw arguments before validation. */
const LspCallTargetSchema = Type.Object({
  file_path: Type.Optional(Type.String()),
  line: Type.Optional(Type.Number()),
  character: Type.Optional(Type.Number()),
  preview_id: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
  new_name: Type.Optional(Type.String()),
});

/** Operations whose output is a list of locations, which Pi's grep previews 15 lines of. */
const LOCATION_LIST_OPERATIONS: ReadonlySet<LspOperationName> = new Set([
  "declaration",
  "goto_definition",
  "goto_type_definition",
  "goto_implementation",
  "find_references",
  "document_highlights",
  "document_symbols",
  "workspace_symbols",
]);

/** Title-case one operation name for tool labels. */
export function humanizeLspOperation(operation: LspOperationName): string {
  const words = operation.replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Raw call arguments are rendered before validation; only checked display fields are read.
function lspCallTarget(parameters: unknown, cwd: string): string | undefined {
  if (!Value.Check(LspCallTargetSchema, parameters)) return undefined;
  if (parameters.file_path !== undefined) {
    const filePath = lspDisplayPath(cwd, parameters.file_path);
    if (parameters.line !== undefined && parameters.character !== undefined) {
      return `${filePath}:${parameters.line}:${parameters.character}`;
    }
    return filePath;
  }
  return parameters.preview_id;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Raw call arguments are rendered before validation; only checked display fields are read.
function lspCallExtraArgs(parameters: unknown): string | undefined {
  if (!Value.Check(LspCallTargetSchema, parameters)) return undefined;
  return parameters.new_name ?? parameters.query;
}

function toolResultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- Historical output records expose only unknown fields, refined at each metric consumption point.
function renderRecord(value: unknown): Record<string, unknown> | undefined {
  return Value.Check(LspRenderRecordSchema, value) ? value : undefined;
}

/** Count the items of one server's normalized response for transcript metrics. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Result metrics inspect container shape without claiming to parse the protocol payload.
export function semanticLspValueCount(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.length;
  const record = renderRecord(value);
  if (record === undefined) return 1;
  // A server that publishes no workspace diagnostics answers with a message, not a result.
  if (record.status === "unsupported") return 0;
  if (Array.isArray(record.diagnostics)) return record.diagnostics.length;
  if (Array.isArray(record.items)) return record.items.length;
  if (Array.isArray(record.signatures)) return record.signatures.length;
  if (Array.isArray(record.diagnosticsByUri)) {
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Each diagnostics entry is checked as a `{ uri, value }` record or a historical tuple before its value is counted.
    return record.diagnosticsByUri.reduce((count: number, entry: unknown) => {
      if (Array.isArray(entry)) return count + semanticLspValueCount(entry[1]);
      const entryRecord = renderRecord(entry);
      if (entryRecord === undefined) return count;
      return count + semanticLspValueCount(entryRecord.value);
    }, 0);
  }
  return 1;
}

/**
 * Render one `lsp_<operation>` tool call in Pi's header shape: the tool name, the file position or
 * preview as the target, and a rename or search argument.
 *
 * Pi renders the call with the arguments the model sent, before validation, so the renderer reads
 * only the fields it displays and tolerates any combination the model may produce. While the call
 * runs, the row carries Pi's `Elapsed` footer because LSP tools send no partial results.
 */
export function renderLspToolCall(
  operation: LspOperationName,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Raw model arguments are displayed before validation.
  parameters: unknown,
  theme: LspRenderTheme,
  context: LspCallRenderContext,
): Component {
  const container = new Container();
  container.addChild(
    new Text(
      toolHeader(
        theme,
        lspToolName(operation),
        lspCallTarget(parameters, context.cwd),
        lspCallExtraArgs(parameters),
      ),
      0,
      0,
    ),
  );
  const record = renderRecord(parameters);
  if (context.expanded && record !== undefined) {
    const lines = Object.entries(record).map(([key, value]) =>
      theme.fg(
        "muted",
        `${key}: ${Value.Check(Type.String(), value) ? value : JSON.stringify(value)}`,
      ),
    );
    if (lines.length > 0) container.addChild(new Text(lines.join("\n"), 0, 0));
  }
  container.addChild(callDurationFooter(theme, context));
  return container;
}

/**
 * Render one `lsp_<operation>` result as a preview of its output with Pi's Expand Hint and
 * duration footer. Location lists keep grep's 15 lines; everything else keeps the 10-line
 * fallback. Failures show their text in the `error` role.
 */
export function renderLspToolResult(
  operation: LspOperationName,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: LspRenderTheme,
  context: LspResultRenderContext,
): Component {
  const container = new Container();
  const output = toolResultText(result).trim();
  if (output !== "") {
    const limit = LOCATION_LIST_OPERATIONS.has(operation)
      ? COLLAPSED_LINES.search
      : COLLAPSED_LINES.fallback;
    const body = previewBody(theme, output.split("\n"), {
      limit,
      expanded: options.expanded,
      color: context.isError ? "error" : "toolOutput",
    });
    container.addChild(new Spacer(1));
    container.addChild(new Text(body.join("\n"), 0, 0));
  }
  appendDurationFooter(container, theme, context, { isPartial: options.isPartial });
  return container;
}
