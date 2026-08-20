import { isAbsolute, relative } from "node:path";
import {
  keyText,
  type AgentToolResult,
  type Theme,
  type ThemeColor,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  sliceByColumn,
  Spacer,
  stripTerminalSequences,
  Text,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import {
  DapToolProgressDetailsSchema,
  DapToolResultDetailsSchema,
  type DapPresentationDetails,
  type DapToolParameters,
  type DapToolProgressDetails,
  type DapToolRenderDetails,
  type DapToolResultDetails,
} from "./dap-tool-contract.js";

/** Theme operations used by Pi DAP transcript rendering. */
export type DapRenderTheme = Pick<Theme, "bold" | "fg">;

interface DapResultSummary {
  readonly color: ThemeColor;
  readonly text: string;
}

function humanizeDapOperation(operation: DapToolParameters["operation"]): string {
  const labels = {
    launch: "Launch",
    set_breakpoints: "Set breakpoints",
    continue: "Continue",
    next: "Step over",
    step_in: "Step in",
    step_out: "Step out",
    pause: "Pause",
    stack: "Stack",
    variables: "Variables",
    evaluate: "Evaluate",
    status: "Status",
    stop: "Stop",
  } as const;
  return labels[operation];
}

function progressingDapOperation(operation: DapToolParameters["operation"]): string {
  switch (operation) {
    case "launch":
      return "Launching";
    case "continue":
      return "Continuing";
    case "next":
      return "Stepping over";
    case "step_in":
      return "Stepping in";
    case "step_out":
      return "Stepping out";
    default:
      return humanizeDapOperation(operation);
  }
}

/** Render an absolute workspace path as relative while retaining paths outside the workspace. */
export function workspaceRelativeDapPath(cwd: string, filePath: string): string {
  if (!isAbsolute(filePath)) return filePath;
  const relativePath = relative(cwd, filePath);
  return relativePath !== "" && !relativePath.startsWith("..") ? relativePath : filePath;
}

/** Remove terminal sequences and unsafe controls from one human-visible Observer UI string. */
export function sanitizeDapObserverText(text: string): string {
  const normalized = stripTerminalSequences(text).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  let safe = "";
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    if (
      character === "\n" ||
      character === "\t" ||
      code >= 0xa0 ||
      (code >= 0x20 && code <= 0x7e)
    ) {
      safe += character;
    }
  }
  return safe;
}

function boundedDapPreview(text: string, width = 160): string {
  const singleLine = sanitizeDapObserverText(text).replace(/\s+/g, " ").trim();
  if (visibleWidth(singleLine) <= width) return singleLine;
  return `${sliceByColumn(singleLine, 0, width - 1, true).trimEnd()}…`;
}

function dapCallTarget(parameters: DapToolParameters, cwd: string): string | undefined {
  switch (parameters.operation) {
    case "launch":
      return [
        parameters.profile,
        parameters.program === undefined
          ? undefined
          : workspaceRelativeDapPath(cwd, parameters.program),
      ]
        .filter((value): value is string => value !== undefined)
        .join(" · ");
    case "set_breakpoints":
      return `${workspaceRelativeDapPath(cwd, parameters.file_path)} · ${parameters.breakpoints.length}`;
    case "stack":
      return parameters.thread_id === undefined ? undefined : `thread #${parameters.thread_id}`;
    case "variables":
      return "frame_id" in parameters
        ? `frame #${parameters.frame_id}`
        : `reference #${parameters.variables_reference}`;
    case "evaluate":
      return boundedDapPreview(parameters.expression, 72);
    default:
      return undefined;
  }
}

function appendField(
  container: Container,
  theme: DapRenderTheme,
  label: string,
  value: string | number,
): void {
  container.addChild(new Text(`${theme.fg("muted", `${label}:`)} ${String(value)}`, 0, 0));
}

function appendExpandedCall(
  container: Container,
  parameters: DapToolParameters,
  theme: DapRenderTheme,
  cwd: string,
): void {
  switch (parameters.operation) {
    case "launch":
      if (parameters.profile !== undefined)
        appendField(container, theme, "Profile", parameters.profile);
      if (parameters.program !== undefined)
        appendField(container, theme, "Program", workspaceRelativeDapPath(cwd, parameters.program));
      if (parameters.args !== undefined)
        appendField(
          container,
          theme,
          "Arguments",
          parameters.args.map((argument) => boundedDapPreview(argument)).join(" · ") || "(none)",
        );
      if (parameters.cwd !== undefined)
        appendField(
          container,
          theme,
          "Working directory",
          workspaceRelativeDapPath(cwd, parameters.cwd),
        );
      return;
    case "set_breakpoints":
      appendField(container, theme, "File", workspaceRelativeDapPath(cwd, parameters.file_path));
      appendField(container, theme, "Breakpoints", parameters.breakpoints.length);
      for (const breakpoint of parameters.breakpoints.slice(0, 20)) {
        container.addChild(
          new Text(
            `  ${breakpoint.line}${breakpoint.condition === undefined ? "" : `  ${boundedDapPreview(breakpoint.condition)}`}`,
            0,
            0,
          ),
        );
      }
      if (parameters.breakpoints.length > 20)
        appendField(container, theme, "Omitted", parameters.breakpoints.length - 20);
      return;
    case "stack":
      if (parameters.thread_id !== undefined)
        appendField(container, theme, "Thread", `#${parameters.thread_id}`);
      if (parameters.start !== undefined) appendField(container, theme, "Start", parameters.start);
      if (parameters.count !== undefined) appendField(container, theme, "Count", parameters.count);
      return;
    case "variables":
      appendField(
        container,
        theme,
        "Source",
        "frame_id" in parameters
          ? `frame #${parameters.frame_id}`
          : `reference #${parameters.variables_reference}`,
      );
      if (parameters.start !== undefined) appendField(container, theme, "Start", parameters.start);
      if (parameters.count !== undefined) appendField(container, theme, "Count", parameters.count);
      return;
    case "evaluate":
      appendField(container, theme, "Expression", boundedDapPreview(parameters.expression));
      if (parameters.frame_id !== undefined)
        appendField(container, theme, "Frame", `#${parameters.frame_id}`);
      return;
    default:
      return;
  }
}

/** Render one DAP call with only the arguments explicitly supplied to the tool. */
export function renderDapToolCall(
  parameters: DapToolParameters,
  theme: DapRenderTheme,
  expanded: boolean,
  cwd: string,
): Component {
  const container = new Container();
  const target = dapCallTarget(parameters, cwd);
  container.addChild(
    new Text(
      [
        theme.fg("toolTitle", theme.bold("DAP")),
        theme.fg("accent", humanizeDapOperation(parameters.operation)),
        target ? theme.fg("muted", target) : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join("  "),
      0,
      0,
    ),
  );
  if (expanded) {
    container.addChild(new Spacer(1));
    appendExpandedCall(container, parameters, theme, cwd);
  }
  return container;
}

function toolResultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
}

function pluralizedCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function stateSummary(details: DapToolResultDetails): DapResultSummary {
  switch (details.state) {
    case "launching":
    case "running":
      return { color: "accent", text: `▶ ${details.state}` };
    case "stopped":
      return {
        color: "accent",
        text: `● stopped${details.stop_reason === undefined ? "" : ` · ${details.stop_reason}`}`,
      };
    case "terminated":
      return {
        color: "success",
        text: `■ terminated${details.exit_code === undefined ? "" : ` · exit ${details.exit_code}`}`,
      };
    case "idle":
      return { color: "success", text: "✓ idle" };
  }
}

function collapsedSummary(details: DapToolResultDetails, cwd: string): DapResultSummary {
  const presentation = details.presentation;
  if (presentation?.kind === "execution_wait") {
    return {
      color: "warning",
      text: `! ${presentation.operation.replaceAll("_", " ")} wait cancelled · Debug Session still ${details.state}`,
    };
  }
  if (presentation?.kind === "breakpoints") {
    const verified = presentation.rows.filter((row) => row.verified).length;
    const unverified = presentation.rows.length - verified;
    return unverified === 0
      ? { color: "success", text: `✓ ${pluralizedCount(verified, "breakpoint")} verified` }
      : { color: "warning", text: `! ${verified} verified · ${unverified} unverified` };
  }
  if (presentation?.kind === "stack_frames") {
    const first = presentation.rows[0];
    const source = first?.source_path ?? first?.source_name;
    const location =
      source === undefined || first === undefined
        ? undefined
        : `${workspaceRelativeDapPath(cwd, source)}:${first.line}`;
    return {
      color: "toolOutput",
      text: `${pluralizedCount(presentation.total_count, "stack frame")}${location === undefined ? "" : ` · ${location}`}`,
    };
  }
  if (presentation?.kind === "variables") {
    const visible = presentation.rows.filter((row) => row.kind === "variable").length;
    return {
      color: "toolOutput",
      text: pluralizedCount(visible + presentation.omitted_count, "variable"),
    };
  }
  if (presentation?.kind === "evaluation") {
    return {
      color: "toolOutput",
      text: `result = ${boundedDapPreview(presentation.value, 80)}${presentation.type === undefined ? "" : ` · ${presentation.type}`}`,
    };
  }
  return stateSummary(details);
}

function appendHeading(container: Container, theme: DapRenderTheme, label: string): void {
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", theme.bold(label)), 0, 0));
}

function rowLocation(
  row: { readonly line?: number; readonly source_name?: string; readonly source_path?: string },
  cwd: string,
): string {
  const source = row.source_path ?? row.source_name;
  const path = source === undefined ? "(unknown source)" : workspaceRelativeDapPath(cwd, source);
  return row.line === undefined ? path : `${path}:${row.line}`;
}

function appendPresentation(
  container: Container,
  presentation: DapPresentationDetails,
  theme: DapRenderTheme,
  cwd: string,
): void {
  switch (presentation.kind) {
    case "breakpoints":
      appendHeading(container, theme, "Breakpoints");
      for (const row of presentation.rows.slice(0, 20)) {
        const symbol = row.verified ? theme.fg("success", "✓") : theme.fg("warning", "!");
        const id = row.id === undefined ? "" : theme.fg("dim", ` #${row.id}`);
        const message =
          row.message === undefined
            ? ""
            : theme.fg("warning", ` — ${sanitizeDapObserverText(row.message)}`);
        container.addChild(new Text(`${symbol} ${rowLocation(row, cwd)}${id}${message}`, 0, 0));
      }
      break;
    case "stack_frames":
      appendHeading(container, theme, "Stack Frames");
      for (const row of presentation.rows.slice(0, 20)) {
        container.addChild(
          new Text(
            `${theme.fg("dim", `#${row.id}`)} ${sanitizeDapObserverText(row.name)}  ${rowLocation(row, cwd)}:${row.column}`,
            0,
            0,
          ),
        );
      }
      break;
    case "variables":
      appendHeading(container, theme, "Variables");
      for (const row of presentation.rows.slice(0, 20)) {
        if (row.kind === "group") {
          container.addChild(
            new Text(
              `${theme.bold(sanitizeDapObserverText(row.name))}  ${theme.fg("dim", `#${row.variables_reference}`)}`,
              0,
              0,
            ),
          );
        } else {
          const type = row.type === undefined ? "" : ` · ${sanitizeDapObserverText(row.type)}`;
          const reference =
            row.variables_reference === 0 ? "" : theme.fg("dim", `  #${row.variables_reference}`);
          container.addChild(
            new Text(
              `${sanitizeDapObserverText(row.name)} = ${sanitizeDapObserverText(row.value)}${type}${reference}`,
              0,
              0,
            ),
          );
        }
      }
      break;
    case "evaluation":
      appendHeading(container, theme, "Evaluation");
      appendField(container, theme, "Value", sanitizeDapObserverText(presentation.value));
      if (presentation.type !== undefined)
        appendField(container, theme, "Type", sanitizeDapObserverText(presentation.type));
      appendField(container, theme, "Variables reference", `#${presentation.variables_reference}`);
      return;
    case "execution_wait":
      return;
  }
  if (presentation.omitted_count > 0) {
    container.addChild(
      new Text(theme.fg("muted", `${presentation.omitted_count} more rows omitted`), 0, 0),
    );
  }
}

function visibleDebuggeeOutput(output: string): string | undefined {
  const heading = output.indexOf("\n\nDebuggee output");
  if (heading < 0) return undefined;
  const content = output.indexOf(":\n", heading);
  return content < 0 ? undefined : sanitizeDapObserverText(output.slice(content + 2));
}

function appendExpandedResult(
  container: Container,
  details: DapToolResultDetails,
  theme: DapRenderTheme,
  output: string,
  cwd: string,
): void {
  appendField(container, theme, "State", details.state);
  if (details.adapter_id !== undefined)
    appendField(container, theme, "Adapter", details.adapter_id);
  if (details.profile_id !== undefined)
    appendField(container, theme, "Profile", details.profile_id);
  if (details.stop_reason !== undefined)
    appendField(container, theme, "Stop reason", sanitizeDapObserverText(details.stop_reason));
  if (details.thread_id !== undefined)
    appendField(container, theme, "Thread", `#${details.thread_id}`);
  if (details.exit_code !== undefined)
    appendField(container, theme, "Exit code", details.exit_code);
  if (details.termination_reason !== undefined)
    appendField(
      container,
      theme,
      "Termination",
      sanitizeDapObserverText(details.termination_reason),
    );
  if (details.presentation !== undefined)
    appendPresentation(container, details.presentation, theme, cwd);
  if (
    details.output_discarded_bytes > 0 ||
    details.output_truncated ||
    details.spill_path !== undefined
  ) {
    appendHeading(container, theme, "Output");
    if (details.output_discarded_bytes > 0)
      container.addChild(
        new Text(
          theme.fg(
            "warning",
            `${details.output_discarded_bytes} older Debuggee output bytes discarded`,
          ),
          0,
          0,
        ),
      );
    if (details.output_truncated)
      container.addChild(new Text(theme.fg("warning", "Visible output truncated"), 0, 0));
    if (details.spill_path !== undefined)
      appendField(container, theme, "Result Spill", details.spill_path);
  }
  const debuggeeOutput = visibleDebuggeeOutput(output);
  if (debuggeeOutput !== undefined) {
    appendHeading(container, theme, "Debuggee output");
    container.addChild(new Text(theme.fg("toolOutput", debuggeeOutput || "(no output)"), 0, 0));
  }
}

function expansionHint(theme: DapRenderTheme): string {
  return `${theme.fg("dim", `  ·  ${keyText("app.tools.expand")}`)}${theme.fg("muted", " to expand")}`;
}

function renderProgress(details: DapToolProgressDetails, theme: DapRenderTheme): Component {
  return new Text(
    theme.fg(
      "accent",
      `${progressingDapOperation(details.operation)}… ${Math.floor(details.elapsed_ms / 1_000)}s`,
    ),
    0,
    0,
  );
}

/** Render a semantic DAP result while preserving raw agent-facing content outside the Observer UI. */
export function renderDapToolResult(
  result: AgentToolResult<DapToolRenderDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: DapRenderTheme,
  isError: boolean,
  cwd: string,
): Component {
  const output = toolResultText(result);
  if (options.isPartial && Value.Check(DapToolProgressDetailsSchema, result.details)) {
    return renderProgress(result.details, theme);
  }
  if (isError || !Value.Check(DapToolResultDetailsSchema, result.details)) {
    const safeOutput = sanitizeDapObserverText(output);
    const visibleOutput = options.expanded
      ? safeOutput
      : (safeOutput.split("\n").find((line) => line.trim().length > 0) ?? "DAP failed");
    const failurePrefix = isError ? "× " : "";
    return new Text(
      theme.fg(
        isError ? "error" : "toolOutput",
        `${failurePrefix}${visibleOutput}${!options.expanded && safeOutput.includes("\n") ? expansionHint(theme) : ""}`,
      ),
      0,
      0,
    );
  }
  const summary = collapsedSummary(result.details, cwd);
  if (!options.expanded) {
    return new Text(`${theme.fg(summary.color, summary.text)}${expansionHint(theme)}`, 0, 0);
  }
  const container = new Container();
  container.addChild(new Text(theme.fg(summary.color, summary.text), 0, 0));
  container.addChild(new Spacer(1));
  appendExpandedResult(container, result.details, theme, output, cwd);
  return container;
}
