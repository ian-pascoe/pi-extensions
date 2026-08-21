import { isAbsolute, relative } from "node:path";
import {
  keyText,
  type AgentToolResult,
  type Theme,
  type ThemeColor,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { LSPAny } from "vscode-languageserver-protocol";
import {
  LspToolResultDetailsSchema,
  type LspToolParameters,
  type LspToolResultDetails,
  type ServerOperationOutcome,
} from "./lsp-tool-contract.js";
import { pluralizedCount } from "./lsp-post-edit-diagnostics-rendering.js";

/** Theme operations used by Pi LSP tool transcript rendering. */
export type LspRenderTheme = Pick<Theme, "bold" | "fg">;

const LspRenderRecordSchema = Type.Record(Type.String(), Type.Any());

function humanizeLspOperation(operation: LspToolParameters["operation"]): string {
  const words = operation.replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function workspaceRelativeLspPath(cwd: string, filePath: string): string {
  const normalizedPath = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  if (!isAbsolute(normalizedPath)) return normalizedPath;
  const relativePath = relative(cwd, normalizedPath);
  return relativePath !== "" && !relativePath.startsWith("..") ? relativePath : normalizedPath;
}

function lspCallTarget(parameters: LspToolParameters, cwd: string): string | undefined {
  if ("file_path" in parameters) {
    const filePath = workspaceRelativeLspPath(cwd, parameters.file_path);
    if ("line" in parameters && "character" in parameters) {
      return `${filePath}:${parameters.line}:${parameters.character}`;
    }
    return filePath;
  }
  if (parameters.operation === "apply") return parameters.preview_id;
  return undefined;
}

function expansionHint(theme: LspRenderTheme): string {
  return `${theme.fg("dim", `  ·  ${keyText("app.tools.expand")}`)}${theme.fg("muted", " to expand")}`;
}

function toolResultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
}

function fileCountLabel(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}

function parsedLspOutput(output: string): LSPAny {
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

function renderRecord(value: LSPAny): Record<string, LSPAny> | undefined {
  return Value.Check(LspRenderRecordSchema, value) ? value : undefined;
}

function semanticLspValueCount(value: LSPAny): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.length;
  const record = renderRecord(value);
  if (record === undefined) return 1;
  if (Array.isArray(record.diagnostics)) return record.diagnostics.length;
  if (Array.isArray(record.items)) return record.items.length;
  if (Array.isArray(record.diagnosticsByUri)) {
    return record.diagnosticsByUri.reduce((count: number, entry: LSPAny) => {
      if (!Array.isArray(entry)) return count;
      return count + semanticLspValueCount(entry[1]);
    }, 0);
  }
  return 1;
}

function semanticLspOperationNoun(operation: LspToolParameters["operation"]): string {
  switch (operation) {
    case "status":
      return "server";
    case "diagnostics":
    case "workspace_diagnostics":
      return "diagnostic";
    case "completion":
      return "completion";
    case "declaration":
    case "goto_definition":
    case "goto_type_definition":
    case "goto_implementation":
      return "location";
    case "find_references":
      return "reference";
    case "document_symbols":
    case "workspace_symbols":
      return "symbol";
    case "document_links":
      return "link";
    case "code_actions":
      return "action";
    default:
      return "result";
  }
}

function semanticLspOperationMetric(
  operation: LspToolParameters["operation"],
  output: string,
): string | undefined {
  const parsed = parsedLspOutput(output);
  const record = renderRecord(parsed);
  let count: number | undefined;
  if (operation === "status" && Array.isArray(record?.servers)) {
    count = record.servers.length;
  } else if (operation === "code_actions" && Array.isArray(parsed)) {
    count = parsed.length;
  } else if (Array.isArray(record?.results)) {
    count = record.results.reduce((total: number, result: LSPAny) => {
      const resultRecord = renderRecord(result);
      return total + semanticLspValueCount(resultRecord?.value);
    }, 0);
  }
  if (count === undefined) return undefined;
  const noun = semanticLspOperationNoun(operation);
  return pluralizedCount(count, noun);
}

function outcomeColor(outcome: ServerOperationOutcome["outcome"]): ThemeColor {
  switch (outcome) {
    case "success":
      return "success";
    case "timeout":
    case "unavailable":
    case "unsupported":
      return "warning";
    case "error":
      return "error";
  }
}

function renderOperationSummary(
  details: Extract<LspToolResultDetails, { kind: "operation" }>,
  theme: LspRenderTheme,
  output: string,
): string {
  const failures = details.server_outcomes.filter(({ outcome }) => outcome !== "success");
  const metric = semanticLspOperationMetric(details.operation, output);
  if (failures.length === 0) {
    const servers = details.server_outcomes.map(({ server_id }) => server_id).join(", ");
    return [
      theme.fg("success", "Completed"),
      metric === undefined ? undefined : theme.fg("toolOutput", metric),
      servers && theme.fg("muted", servers),
    ]
      .filter(Boolean)
      .join(theme.fg("dim", "  ·  "));
  }
  const succeeded = details.server_outcomes.length - failures.length;
  const summary = succeeded === 0 ? "Failed" : "Completed with issues";
  return [
    theme.fg(succeeded === 0 ? "error" : "warning", summary),
    metric === undefined ? undefined : theme.fg("toolOutput", metric),
    theme.fg("warning", pluralizedCount(failures.length, "server issue")),
  ]
    .filter(Boolean)
    .join(theme.fg("dim", "  ·  "));
}

function renderCollapsedLspResult(
  details: LspToolResultDetails,
  theme: LspRenderTheme,
  output: string,
): string {
  switch (details.kind) {
    case "operation":
      return renderOperationSummary(details, theme, output);
    case "workspace_edit_preview":
      return `${theme.fg("accent", "Preview ready")}${theme.fg("dim", `  ·  ${fileCountLabel(details.mutation_manifest.length)}`)}`;
    case "workspace_edit_apply": {
      const label = details.state === "applied" ? "Applied" : "Partial failure";
      const color = details.state === "applied" ? "success" : "error";
      return `${theme.fg(color, label)}${theme.fg("dim", `  ·  ${fileCountLabel(details.changed_paths.length)}`)}`;
    }
  }
}

function appendExpandedOperationDetails(
  container: Container,
  details: Extract<LspToolResultDetails, { kind: "operation" }>,
  theme: LspRenderTheme,
): void {
  container.addChild(new Text(theme.fg("muted", theme.bold("Server outcomes")), 0, 0));
  for (const outcome of details.server_outcomes) {
    const message = outcome.message === undefined ? "" : theme.fg("muted", ` — ${outcome.message}`);
    container.addChild(
      new Text(
        `${theme.fg(outcomeColor(outcome.outcome), outcome.outcome)}  ${outcome.server_id}${message}`,
        0,
        0,
      ),
    );
  }
  if (details.spill_path !== undefined) {
    container.addChild(
      new Text(`${theme.fg("muted", "Result Spill:")} ${details.spill_path}`, 0, 0),
    );
  }
}

function appendExpandedMutationDetails(
  container: Container,
  details: Exclude<LspToolResultDetails, { kind: "operation" }>,
  theme: LspRenderTheme,
): void {
  if (details.kind === "workspace_edit_preview") {
    container.addChild(new Text(details.summary, 0, 0));
  }
  container.addChild(new Text(`${theme.fg("muted", "Preview:")} ${details.preview_id}`, 0, 0));
  const paths =
    details.kind === "workspace_edit_preview"
      ? details.mutation_manifest.flatMap((entry) =>
          entry.operation === "rename" ? [entry.path, entry.destination_path] : [entry.path],
        )
      : details.changed_paths;
  for (const path of paths) container.addChild(new Text(theme.fg("muted", path), 0, 0));
}

/** Render one Pi LSP tool call using Pi's supplied theme and native expansion state. */
export function renderLspToolCall(
  parameters: LspToolParameters,
  theme: LspRenderTheme,
  expanded: boolean,
  cwd: string,
): Component {
  const container = new Container();
  const target = lspCallTarget(parameters, cwd);
  container.addChild(
    new Text(
      [
        theme.fg("toolTitle", theme.bold("LSP")),
        theme.fg("accent", humanizeLspOperation(parameters.operation)),
        target === undefined ? undefined : theme.fg("muted", target),
      ]
        .filter((part) => part !== undefined)
        .join("  "),
      0,
      0,
    ),
  );
  if (expanded) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", JSON.stringify(parameters, undefined, 2)), 0, 0));
  }
  return container;
}

/** Render one Pi LSP tool result as a compact summary with exact output on expansion. */
export function renderLspToolResult(
  result: AgentToolResult<LspToolResultDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: LspRenderTheme,
  isError: boolean,
): Component {
  const output = toolResultText(result);
  if (options.isPartial) return new Text(theme.fg("accent", "Running…"), 0, 0);
  if (isError || !Value.Check(LspToolResultDetailsSchema, result.details)) {
    const visibleOutput = options.expanded
      ? output
      : (output.split("\n").find(Boolean) ?? "LSP failed");
    const hint = !options.expanded && output.includes("\n") ? expansionHint(theme) : "";
    return new Text(theme.fg(isError ? "error" : "toolOutput", `${visibleOutput}${hint}`), 0, 0);
  }

  if (!options.expanded) {
    return new Text(
      `${renderCollapsedLspResult(result.details, theme, output)}${expansionHint(theme)}`,
      0,
      0,
    );
  }

  const container = new Container();
  container.addChild(new Text(renderCollapsedLspResult(result.details, theme, output), 0, 0));
  container.addChild(new Spacer(1));
  if (result.details.kind === "operation") {
    appendExpandedOperationDetails(container, result.details, theme);
  } else {
    appendExpandedMutationDetails(container, result.details, theme);
  }
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", theme.bold("Output")), 0, 0));
  container.addChild(new Text(theme.fg("toolOutput", output || "(no output)"), 0, 0));
  return container;
}
