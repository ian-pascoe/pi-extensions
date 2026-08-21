import {
  getMarkdownTheme,
  highlightCode,
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
import { Type } from "typebox";
import { Value } from "typebox/value";
import { formatCodeModePresentationData } from "./codemode-presentation-output.js";
import { formatCodeModeDuration } from "./codemode-session-coordinator.js";
import {
  CodeModeCancelParametersSchema,
  CodeModeExecuteParametersSchema,
  CodeModeResultDetailsSchema,
  CodeModeResultParametersSchema,
  CodeModeSessionsParametersSchema,
  CodeModeSessionsResultSchema,
  createCodeModeToolDefinitions,
  type CodeModeCancelParameters,
  type CodeModeErrorCode,
  type CodeModeExecuteParameters,
  isCodeModeJsonObject,
  type CodeModeJsonValue,
  type CodeModePresentationSnapshot,
  type CodeModeResultDetails,
  type CodeModeResultParameters,
  type CodeModeSessionsParameters,
  type CodeModeSessionsResult,
  type CodeModeToolOperations,
} from "./codemode-tool-contract.js";

/** Names of the four CodeMode tools with semantic Transcript rendering. */
export type CodeModeRenderedToolName =
  | "codemode_execute"
  | "codemode_result"
  | "codemode_cancel"
  | "codemode_sessions";

/** Parsed arguments accepted by one of the four CodeMode Transcript renderers. */
export type CodeModeRenderedToolParameters =
  | CodeModeExecuteParameters
  | CodeModeResultParameters
  | CodeModeCancelParameters
  | CodeModeSessionsParameters;

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
const CODEMODE_COLLAPSED_SCRIPT_LINES = 8;
const CODEMODE_PRESENTATION_MAX_BYTES = 50 * 1024;
const CodeModeJsonStringSchema = Type.String();

function sanitizeCodeModeText(text: string): string {
  return (
    stripTerminalSequences(text)
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      // oxlint-disable-next-line eslint/no-control-regex -- SAFETY: Transcript text permits tabs/newlines but must remove every remaining C0/C1 terminal control.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
  );
}

function boundedCodeModePreview(text: string, width = 72): string {
  const singleLine = sanitizeCodeModeText(text).replace(/\s+/g, " ").trim();
  if (visibleWidth(singleLine) <= width) return singleLine;
  return `${sliceByColumn(singleLine, 0, width - 1, true).trimEnd()}…`;
}

function parseCodeModeRenderedToolParameters(
  toolName: CodeModeRenderedToolName,
  parameters: CodeModeJsonValue,
): CodeModeRenderedToolParameters | undefined {
  if (toolName === "codemode_execute") {
    return Value.Check(CodeModeExecuteParametersSchema, parameters) ? parameters : undefined;
  }
  if (toolName === "codemode_result") {
    return Value.Check(CodeModeResultParametersSchema, parameters) ? parameters : undefined;
  }
  if (toolName === "codemode_cancel") {
    return Value.Check(CodeModeCancelParametersSchema, parameters) ? parameters : undefined;
  }
  return Value.Check(CodeModeSessionsParametersSchema, parameters) ? parameters : undefined;
}

function shortCodeModeSessionId(sessionId: string): string {
  const safe = sanitizeCodeModeText(sessionId).replace(/\s+/g, "");
  return sliceByColumn(safe, 0, Math.min(8, visibleWidth(safe)), true);
}

/** Resolves one Session ID to the shortest unambiguous CodeMode Transcript label. */
export type CodeModeSessionPrefixFormatter = (sessionId: string) => string;

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
  if (details.result === "failed" && details.error.code === "eviction") {
    return "Session closed";
  }
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
  if (isCodeModeJsonObject(value)) {
    return `object · ${pluralizedCodeModeCount(Object.keys(value).length, "key")}`;
  }
  if (Value.Check(CodeModeJsonStringSchema, value)) {
    return boundedCodeModePreview(JSON.stringify(value), 48);
  }
  return JSON.stringify(value) ?? "";
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

function highlightedCodeModeSource(source: string): string {
  return highlightCode(source, "typescript")
    .map((line) => `  ${line}`)
    .join("\n");
}

function appendHighlightedCodeModeSource(container: Container, source: string): void {
  container.addChild(new Text(highlightedCodeModeSource(source), 0, 0));
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
  const status =
    details.result === "failed" && details.error.code === "eviction"
      ? { color: "warning" as const, label: "■ reclaimed" }
      : CODEMODE_STATUS_PRESENTATION[state];
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

/** Render one CodeMode tool call with a bounded collapsed preview or complete expanded source. */
export function renderCodeModeToolCall(
  toolName: CodeModeRenderedToolName,
  parameters: CodeModeJsonValue,
  theme: CodeModeRenderTheme,
  expanded: boolean,
  formatSessionPrefix: CodeModeSessionPrefixFormatter = shortCodeModeSessionId,
): Component {
  const operation =
    toolName === "codemode_execute"
      ? "Run Cell"
      : toolName === "codemode_result"
        ? "Poll"
        : toolName === "codemode_cancel"
          ? "Cancel"
          : "List Sessions";
  const parsedParameters = parseCodeModeRenderedToolParameters(toolName, parameters);
  const executeParameters =
    toolName === "codemode_execute" &&
    parsedParameters !== undefined &&
    "script" in parsedParameters
      ? parsedParameters
      : undefined;
  const sessionId =
    parsedParameters !== undefined && "sessionId" in parsedParameters
      ? parsedParameters.sessionId
      : undefined;
  const source =
    executeParameters === undefined ? undefined : sanitizeCodeModeText(executeParameters.script);
  const oneLineSource = source !== undefined && !source.includes("\n") ? source : undefined;
  const expansionHint = `${keyText("app.tools.expand")} to expand`;
  const container = new Container();
  container.addChild(
    new Text(
      [
        theme.fg("toolTitle", theme.bold("CodeMode")),
        theme.fg("accent", operation),
        theme.fg("muted", sessionId === undefined ? "new" : formatSessionPrefix(sessionId)),
        !expanded && oneLineSource !== undefined
          ? highlightCode(oneLineSource, "typescript")[0]
          : undefined,
        !expanded && oneLineSource !== undefined
          ? theme.fg("dim", `·  ${expansionHint}`)
          : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join("  "),
      0,
      0,
    ),
  );
  if (!expanded) {
    if (source === undefined || oneLineSource !== undefined) return container;
    const sourceLines = source.split("\n");
    const visibleSource = sourceLines.slice(0, CODEMODE_COLLAPSED_SCRIPT_LINES).join("\n");
    appendHighlightedCodeModeSource(container, visibleSource);
    const omittedLines = Math.max(0, sourceLines.length - CODEMODE_COLLAPSED_SCRIPT_LINES);
    const omitted =
      omittedLines === 0 ? "" : `… ${pluralizedCodeModeCount(omittedLines, "line")} omitted  ·  `;
    container.addChild(new Text(theme.fg("dim", `  ${omitted}${expansionHint}`), 0, 0));
    return container;
  }
  container.addChild(new Spacer(1));
  if (sessionId !== undefined) appendCodeModeField(container, theme, "Session", sessionId);
  if (executeParameters === undefined) return container;
  if (executeParameters.wait !== undefined)
    appendCodeModeField(container, theme, "Wait", String(executeParameters.wait));
  if (executeParameters.timeoutMs !== undefined)
    appendCodeModeField(container, theme, "Timeout", `${executeParameters.timeoutMs}ms`);
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", theme.bold("TypeScript")), 0, 0));
  appendHighlightedCodeModeSource(container, source ?? "");
  return container;
}

function renderCodeModeSessionsResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: CodeModeRenderTheme,
): Component {
  if (!Value.Check(CodeModeSessionsResultSchema, result.details)) {
    return renderCodeModeFallback(result, options, theme, false);
  }
  const sessions: CodeModeSessionsResult = result.details;
  const summary = `${theme.fg("success", "✓")} ${pluralizedCodeModeCount(sessions.sessions.length, "session")}`;
  if (!options.expanded) {
    const hint = options.isPartial ? "" : `  ·  ${keyText("app.tools.expand")} to expand`;
    return new Text(`${summary}${hint}`, 0, 0);
  }
  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  if (sessions.sessions.length === 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", "No live Sessions"), 0, 0));
    return container;
  }
  container.addChild(new Spacer(1));
  for (const session of sessions.sessions) {
    container.addChild(
      new Text(
        `${theme.fg(session.state === "running" ? "accent" : "muted", session.state)}  ${sanitizeCodeModeText(session.sessionId)}  ${pluralizedCodeModeCount(session.cellCount, "cell")}  ${session.lastActivityAtMs}`,
        0,
        0,
      ),
    );
  }
  return container;
}

/** Render one CodeMode result in collapsed, expanded, partial, or historical form. */
export function renderCodeModeToolResult(
  toolName: CodeModeRenderedToolName,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: CodeModeRenderTheme,
  isError: boolean,
  formatSessionPrefix: CodeModeSessionPrefixFormatter = shortCodeModeSessionId,
): Component {
  if (toolName === "codemode_sessions") {
    return renderCodeModeSessionsResult(result, options, theme);
  }
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

/** Create the four CodeMode tools with semantic call and result Transcript renderers. */
export function createRenderedCodeModeToolDefinitions(
  operations: CodeModeToolOperations,
  executeDescription?: string,
  formatSessionPrefix: CodeModeSessionPrefixFormatter = shortCodeModeSessionId,
): ReturnType<typeof createCodeModeToolDefinitions> {
  const [executeTool, resultTool, cancelTool, sessionsTool] = createCodeModeToolDefinitions(
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
          context.isError,
          formatSessionPrefix,
        ),
    },
    {
      ...sessionsTool,
      renderCall: (_args, theme, context) =>
        renderCodeModeToolCall(
          "codemode_sessions",
          {},
          theme,
          context.expanded,
          formatSessionPrefix,
        ),
      renderResult: (result, options, theme, context) =>
        renderCodeModeToolResult(
          "codemode_sessions",
          result,
          options,
          theme,
          context.isError,
          formatSessionPrefix,
        ),
    },
  ];
}
