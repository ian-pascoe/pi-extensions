import {
  getMarkdownTheme,
  keyText,
  truncateHead,
  type AgentToolResult,
  type Theme,
  type ThemeColor,
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
import { Value } from "typebox/value";
import { formatCodeModePresentationData } from "./codemode-presentation-output.js";
import {
  CodeModeCancelParametersSchema,
  CodeModeExecuteParametersSchema,
  CodeModeResultDetailsSchema,
  CodeModeResultParametersSchema,
  createCodeModeToolDefinitions,
  type CodeModeCancelParameters,
  type CodeModeErrorCode,
  type CodeModeExecuteParameters,
  type CodeModeJsonValue,
  type CodeModePresentationSnapshot,
  type CodeModeResultDetails,
  type CodeModeResultParameters,
  type CodeModeToolOperations,
} from "./codemode-tool-contract.js";

/** Names of the three CodeMode tools with semantic Transcript rendering. */
export type CodeModeRenderedToolName = "codemode_execute" | "codemode_result" | "codemode_cancel";

/** Parsed arguments accepted by one of the three CodeMode Transcript renderers. */
export type CodeModeRenderedToolParameters =
  | CodeModeExecuteParameters
  | CodeModeResultParameters
  | CodeModeCancelParameters;

/** Theme operations used by CodeMode Transcript renderers. */
export type CodeModeRenderTheme = Pick<Theme, "bold" | "fg">;

type CodeModeCellState = CodeModePresentationSnapshot["cell_state"];
type CodeModeStatusPresentation = {
  readonly color: ThemeColor;
  readonly label: string;
};

const CODEMODE_STATUS_PRESENTATION = {
  running: { color: "accent", label: "◉ running" },
  completed: { color: "success", label: "✓ completed" },
  failed: { color: "error", label: "× failed" },
  cancelled: { color: "warning", label: "■ cancelled" },
  timed_out: { color: "error", label: "! timed out" },
} satisfies Record<CodeModeCellState, CodeModeStatusPresentation>;
const CODEMODE_SCRIPT_MAX_LINES = 200;
const CODEMODE_PRESENTATION_MAX_BYTES = 50 * 1024;

function sanitizeCodeModeText(text: string): string {
  return (
    stripTerminalSequences(text)
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      // oxlint-disable-next-line eslint/no-control-regex -- Transcript text permits tabs/newlines but must remove every remaining C0/C1 terminal control.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
  );
}

function boundedCodeModePreview(text: string, width = 72): string {
  const singleLine = sanitizeCodeModeText(text).replace(/\s+/g, " ").trim();
  if (visibleWidth(singleLine) <= width) return singleLine;
  return `${sliceByColumn(singleLine, 0, width - 1, true).trimEnd()}…`;
}

function firstMeaningfulScriptLine(script: string): string | undefined {
  const line = sanitizeCodeModeText(script)
    .split("\n")
    .map((candidate) => candidate.trim())
    .find(Boolean);
  return line === undefined ? undefined : boundedCodeModePreview(line);
}

function parseCodeModeRenderedToolParameters(
  toolName: CodeModeRenderedToolName,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This function owns schema parsing for historical tool-call arguments.
  parameters: unknown,
): CodeModeRenderedToolParameters | undefined {
  if (toolName === "codemode_execute") {
    return Value.Check(CodeModeExecuteParametersSchema, parameters) ? parameters : undefined;
  }
  if (toolName === "codemode_result") {
    return Value.Check(CodeModeResultParametersSchema, parameters) ? parameters : undefined;
  }
  return Value.Check(CodeModeCancelParametersSchema, parameters) ? parameters : undefined;
}

function shortCodeModeSessionId(sessionId: string): string {
  const safe = sanitizeCodeModeText(sessionId).replace(/\s+/g, "");
  return sliceByColumn(safe, 0, Math.min(8, visibleWidth(safe)), true);
}

/** Resolves one Session ID to the shortest unambiguous CodeMode Transcript label. */
export type CodeModeSessionPrefixFormatter = (sessionId: string) => string;

function formatCodeModeDuration(elapsedMs: number): string {
  if (elapsedMs < 1_000) return `${elapsedMs}ms`;
  if (elapsedMs < 60_000) return `${(elapsedMs / 1_000).toFixed(1)}s`;
  const seconds = Math.floor(elapsedMs / 1_000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function pluralizedCodeModeCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function codeModeCellState(
  toolName: CodeModeRenderedToolName,
  details: CodeModeResultDetails,
): CodeModeCellState {
  if (details.presentation !== undefined) return details.presentation.cell_state;
  if (toolName === "codemode_cancel" && details.result === "success") return "cancelled";
  if (details.result === "pending") return "running";
  if (details.result === "success") return "completed";
  if (details.error.code === "timeout") return "timed_out";
  if (details.error.code === "cancellation") return "cancelled";
  return "failed";
}

function codeModeSessionLifecycle(
  toolName: CodeModeRenderedToolName,
  details: CodeModeResultDetails,
): "Session reusable" | "Session closed" | "No reusable Session" {
  if (details.presentation !== undefined) {
    return details.presentation.session_state === "live" ? "Session reusable" : "Session closed";
  }
  if (toolName === "codemode_cancel") return "Session closed";
  if (
    details.result === "failed" &&
    (details.error.code === "capacity" || details.error.code === "unknown")
  ) {
    return "No reusable Session";
  }
  if (
    details.result !== "failed" ||
    details.error.code === "script" ||
    details.error.code === "serialization" ||
    details.error.code === "busy"
  ) {
    return "Session reusable";
  }
  return "Session closed";
}

function codeModeValueSummary(value: CodeModeJsonValue | undefined): string {
  if (value === undefined) return "(no data)";
  if (value === null) return "null";
  if (Array.isArray(value)) return `array · ${pluralizedCodeModeCount(value.length, "item")}`;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The parsed recursive JSON union is discriminated into its object value arm for presentation.
  if (typeof value === "object") {
    return `object · ${pluralizedCodeModeCount(Object.keys(value).length, "key")}`;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The parsed recursive JSON union is discriminated into its string value arm for presentation.
  if (typeof value === "string") return boundedCodeModePreview(JSON.stringify(value), 48);
  return String(value);
}

function appendCodeModeField(
  container: Container,
  theme: CodeModeRenderTheme,
  label: string,
  value: string | number,
): void {
  container.addChild(
    new Text(`${theme.fg("muted", `${label}:`)} ${sanitizeCodeModeText(String(value))}`, 0, 0),
  );
}

function appendCodeModeBlock(container: Container, language: "ts" | "json", content: string): void {
  const longestFence = Math.max(2, ...[...content.matchAll(/`+/g)].map(([fence]) => fence.length));
  const fence = "`".repeat(longestFence + 1);
  container.addChild(
    new Markdown(`${fence}${language}\n${content}\n${fence}`, 0, 0, getMarkdownTheme()),
  );
}

function boundedCodeModeText(text: string, maxLines: number): string {
  const safe = sanitizeCodeModeText(text);
  const truncated = truncateHead(safe, {
    maxBytes: CODEMODE_PRESENTATION_MAX_BYTES,
    maxLines,
  });
  if (!truncated.truncated) return safe;
  const omittedLines = Math.max(0, truncated.totalLines - truncated.outputLines);
  const notice = `… ${pluralizedCodeModeCount(omittedLines, "line")} omitted`;
  return truncated.content.length === 0 ? notice : `${truncated.content}\n${notice}`;
}

function renderCodeModeFallback(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: CodeModeRenderTheme,
  isError: boolean,
): Component {
  const output = sanitizeCodeModeText(
    result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(""),
  );
  const firstLine = output.split("\n").find(Boolean) ?? "CodeMode failed";
  const visible = options.expanded
    ? boundedCodeModeText(output, 2_000)
    : boundedCodeModePreview(firstLine, 160);
  const hint =
    !options.expanded && (output.includes("\n") || visible !== firstLine)
      ? `  ·  ${keyText("app.tools.expand")} to expand`
      : "";
  return new Text(theme.fg(isError ? "error" : "toolOutput", `${visible}${hint}`), 0, 0);
}

function renderCodeModeSummary(
  details: CodeModeResultDetails,
  toolName: CodeModeRenderedToolName,
  theme: CodeModeRenderTheme,
  formatSessionPrefix: CodeModeSessionPrefixFormatter,
): string {
  const presentation = details.presentation;
  const state = codeModeCellState(toolName, details);
  const status = CODEMODE_STATUS_PRESENTATION[state];
  const activeToolNames = presentation?.active_tool_names.slice(0, 3) ?? [];
  const omittedActiveToolCount = Math.max(
    0,
    (presentation?.active_tool_count ?? 0) - activeToolNames.length,
  );
  const parts = [
    theme.fg(status.color, status.label),
    theme.fg("muted", formatSessionPrefix(details.sessionId)),
    presentation?.cell_ordinal === undefined
      ? undefined
      : theme.fg("muted", `Cell ${presentation.cell_ordinal}`),
    state === "running" && presentation !== undefined && presentation.active_tool_names.length > 0
      ? theme.fg(
          "muted",
          `${activeToolNames.map((name) => sanitizeCodeModeText(name)).join(", ")}${omittedActiveToolCount > 0 ? ` +${omittedActiveToolCount}` : ""}`,
        )
      : undefined,
    details.result === "success"
      ? theme.fg("toolOutput", codeModeValueSummary(details.data))
      : undefined,
    details.result === "failed" ? theme.fg("muted", details.error.code) : undefined,
    details.result === "failed" ? boundedCodeModePreview(details.error.message, 64) : undefined,
    state !== "running" && presentation !== undefined && presentation.nested_tool_count > 0
      ? theme.fg("muted", pluralizedCodeModeCount(presentation.nested_tool_count, "tool"))
      : undefined,
    presentation === undefined
      ? undefined
      : theme.fg("muted", formatCodeModeDuration(presentation.elapsed_ms)),
  ].filter((part): part is string => part !== undefined);
  return parts.join("  ");
}

/** Render one CodeMode tool call as a semantic operation with bounded source detail. */
export function renderCodeModeToolCall(
  toolName: CodeModeRenderedToolName,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Historical tool arguments are parsed against the selected public schema immediately below.
  parameters: unknown,
  theme: CodeModeRenderTheme,
  expanded: boolean,
  formatSessionPrefix: CodeModeSessionPrefixFormatter = shortCodeModeSessionId,
): Component {
  const operation =
    toolName === "codemode_execute"
      ? "Run Cell"
      : toolName === "codemode_result"
        ? "Poll"
        : "Cancel";
  const parsedParameters = parseCodeModeRenderedToolParameters(toolName, parameters);
  const executeParameters =
    toolName === "codemode_execute" &&
    parsedParameters !== undefined &&
    "script" in parsedParameters
      ? parsedParameters
      : undefined;
  const sessionId = parsedParameters?.sessionId;
  const preview =
    executeParameters === undefined
      ? undefined
      : firstMeaningfulScriptLine(executeParameters.script);
  const container = new Container();
  container.addChild(
    new Text(
      [
        theme.fg("toolTitle", theme.bold("CodeMode")),
        theme.fg("accent", operation),
        theme.fg("muted", sessionId === undefined ? "new" : formatSessionPrefix(sessionId)),
        preview === undefined ? undefined : theme.fg("dim", preview),
      ]
        .filter((part): part is string => part !== undefined)
        .join("  "),
      0,
      0,
    ),
  );
  if (!expanded) return container;
  container.addChild(new Spacer(1));
  if (sessionId !== undefined) appendCodeModeField(container, theme, "Session", sessionId);
  if (executeParameters === undefined) return container;
  if (executeParameters.wait !== undefined)
    appendCodeModeField(container, theme, "Wait", String(executeParameters.wait));
  if (executeParameters.timeoutMs !== undefined)
    appendCodeModeField(container, theme, "Timeout", `${executeParameters.timeoutMs}ms`);
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", theme.bold("TypeScript")), 0, 0));
  const script = boundedCodeModeText(executeParameters.script, CODEMODE_SCRIPT_MAX_LINES);
  appendCodeModeBlock(container, "ts", script);
  return container;
}

/** Render one CodeMode result in collapsed, expanded, partial, or historical form. */
export function renderCodeModeToolResult(
  toolName: CodeModeRenderedToolName,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: CodeModeRenderTheme,
  parameters: CodeModeRenderedToolParameters,
  isError: boolean,
  formatSessionPrefix: CodeModeSessionPrefixFormatter = shortCodeModeSessionId,
): Component {
  if (!Value.Check(CodeModeResultDetailsSchema, result.details)) {
    return renderCodeModeFallback(result, options, theme, isError);
  }
  const details = result.details;
  const summary = renderCodeModeSummary(details, toolName, theme, formatSessionPrefix);
  if (!options.expanded) {
    const hint = options.isPartial ? "" : `  ·  ${keyText("app.tools.expand")} to expand`;
    return new Text(`${summary}${hint}`, 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  container.addChild(new Spacer(1));
  appendCodeModeField(container, theme, "Session", details.sessionId);
  if (details.presentation?.cell_ordinal !== undefined) {
    appendCodeModeField(container, theme, "Cell", details.presentation.cell_ordinal);
  }
  appendCodeModeField(container, theme, "Lifecycle", codeModeSessionLifecycle(toolName, details));

  const presentation = details.presentation;
  if (presentation !== undefined && presentation.nested_tools.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", theme.bold("Tool activity")), 0, 0));
    for (const nested of presentation.nested_tools.slice(0, 20)) {
      const successful = nested.outcome === "success";
      const symbol = successful ? "✓" : nested.outcome === "cancelled" ? "■" : "×";
      const color: ThemeColor = successful
        ? "success"
        : nested.outcome === "cancelled"
          ? "warning"
          : "error";
      container.addChild(
        new Text(
          `${theme.fg(color, symbol)} ${sanitizeCodeModeText(nested.name)}  ${theme.fg("muted", formatCodeModeDuration(nested.elapsed_ms))}`,
          0,
          0,
        ),
      );
    }
    const omittedNestedToolCount =
      presentation.omitted_nested_tool_count + Math.max(0, presentation.nested_tools.length - 20);
    if (omittedNestedToolCount > 0) {
      container.addChild(
        new Text(
          theme.fg("dim", `… ${pluralizedCodeModeCount(omittedNestedToolCount, "tool")} omitted`),
          0,
          0,
        ),
      );
    }
  }

  if (details.result === "success") {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", theme.bold("Result")), 0, 0));
    if (details.data === undefined)
      container.addChild(new Text(theme.fg("dim", "(no data)"), 0, 0));
    else {
      const json = boundedCodeModeText(formatCodeModePresentationData(details.data), 2_000);
      appendCodeModeBlock(container, "json", json);
    }
  } else if (details.result === "failed") {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", theme.bold("Error")), 0, 0));
    appendCodeModeField(container, theme, "Code", details.error.code satisfies CodeModeErrorCode);
    container.addChild(
      new Text(theme.fg("error", boundedCodeModeText(details.error.message, 2_000)), 0, 0),
    );
  }
  if (presentation?.spill_path !== undefined) {
    appendCodeModeField(container, theme, "Result Spill", presentation.spill_path);
  }
  return container;
}

/** Create the three CodeMode tools with semantic call and result Transcript renderers. */
export function createRenderedCodeModeToolDefinitions(
  operations: CodeModeToolOperations,
  executeDescription?: string,
  formatSessionPrefix: CodeModeSessionPrefixFormatter = shortCodeModeSessionId,
): ReturnType<typeof createCodeModeToolDefinitions> {
  const [executeTool, resultTool, cancelTool] = createCodeModeToolDefinitions(
    operations,
    executeDescription,
  );
  return [
    {
      ...executeTool,
      renderCall: (args, theme, context) =>
        renderCodeModeToolCall(
          "codemode_execute",
          args,
          theme,
          context.expanded,
          formatSessionPrefix,
        ),
      renderResult: (result, options, theme, context) =>
        renderCodeModeToolResult(
          "codemode_execute",
          result,
          options,
          theme,
          context.args,
          context.isError,
          formatSessionPrefix,
        ),
    },
    {
      ...resultTool,
      renderCall: (args, theme, context) =>
        renderCodeModeToolCall(
          "codemode_result",
          args,
          theme,
          context.expanded,
          formatSessionPrefix,
        ),
      renderResult: (result, options, theme, context) =>
        renderCodeModeToolResult(
          "codemode_result",
          result,
          options,
          theme,
          context.args,
          context.isError,
          formatSessionPrefix,
        ),
    },
    {
      ...cancelTool,
      renderCall: (args, theme, context) =>
        renderCodeModeToolCall(
          "codemode_cancel",
          args,
          theme,
          context.expanded,
          formatSessionPrefix,
        ),
      renderResult: (result, options, theme, context) =>
        renderCodeModeToolResult(
          "codemode_cancel",
          result,
          options,
          theme,
          context.args,
          context.isError,
          formatSessionPrefix,
        ),
    },
  ];
}
