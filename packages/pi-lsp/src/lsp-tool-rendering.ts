import {
  keyText,
  type AgentToolResult,
  type Theme,
  type ThemeColor,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import {
  LspToolResultDetailsSchema,
  type LspToolParameters,
  type LspToolResultDetails,
  type ServerOperationOutcome,
} from "./lsp-tool-contract.js";

/** Theme operations used by Pi LSP tool transcript rendering. */
export type LspRenderTheme = Pick<Theme, "bold" | "fg">;

function humanizeLspOperation(operation: LspToolParameters["operation"]): string {
  const words = operation.replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function lspCallTarget(parameters: LspToolParameters): string | undefined {
  if ("file_path" in parameters) {
    if ("line" in parameters && "character" in parameters) {
      return `${parameters.file_path}:${parameters.line}:${parameters.character}`;
    }
    return parameters.file_path;
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
): string {
  const failures = details.server_outcomes.filter(({ outcome }) => outcome !== "success");
  if (failures.length === 0) {
    const servers = details.server_outcomes.map(({ server_id }) => server_id).join(", ");
    return [theme.fg("success", "Completed"), servers && theme.fg("muted", servers)]
      .filter(Boolean)
      .join(theme.fg("dim", "  ·  "));
  }
  const succeeded = details.server_outcomes.length - failures.length;
  const summary = succeeded === 0 ? "Failed" : "Completed with issues";
  return `${theme.fg(succeeded === 0 ? "error" : "warning", summary)}${theme.fg("dim", `  ·  ${failures.length} server issue${failures.length === 1 ? "" : "s"}`)}`;
}

function renderCollapsedLspResult(details: LspToolResultDetails, theme: LspRenderTheme): string {
  switch (details.kind) {
    case "operation":
      return renderOperationSummary(details, theme);
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
): Component {
  const container = new Container();
  const target = lspCallTarget(parameters);
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
      `${renderCollapsedLspResult(result.details, theme)}${expansionHint(theme)}`,
      0,
      0,
    );
  }

  const container = new Container();
  container.addChild(new Text(renderCollapsedLspResult(result.details, theme), 0, 0));
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
