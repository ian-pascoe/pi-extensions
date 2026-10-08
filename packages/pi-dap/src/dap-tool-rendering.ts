import { isAbsolute, relative } from "node:path";
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
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
import {
  callDurationFooter,
  COLLAPSED_LINES,
  appendDurationFooter,
  previewBody,
  toolHeader,
  type DurationContext,
} from "@ian-pascoe/pi-utils/ui";
import { Value } from "typebox/value";
import {
  DapToolProgressDetailsSchema,
  type DapOperation,
  type DapToolCallArguments,
  type DapToolRenderDetails,
} from "./dap-tool-contract.js";

/** Theme operations used by Pi DAP transcript rendering. */
export type DapRenderTheme = Pick<Theme, "bold" | "fg">;

/** What the call row reads from Pi's render context. */
export type DapCallRenderContext = DurationContext & { expanded: boolean; cwd: string };

/** What the result row reads from Pi's render context. */
export type DapResultRenderContext = DurationContext & { isError: boolean };

/** Most breakpoints listed in an expanded call row. */
const EXPANDED_BREAKPOINT_LIMIT = 20;

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
  return `${sliceByColumn(singleLine, 0, width - 3, true).trimEnd()}...`;
}

function pluralizedCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The accent target and muted arguments that follow the tool name in a call header. */
interface DapCallHeaderParts {
  target: string | undefined;
  args: string | undefined;
}

function dapCallHeaderParts(parameters: DapToolCallArguments, cwd: string): DapCallHeaderParts {
  const parts: DapCallHeaderParts = { target: undefined, args: undefined };
  switch (parameters.operation) {
    case "launch":
      if (parameters.program !== undefined) {
        parts.target = workspaceRelativeDapPath(cwd, parameters.program);
      }
      parts.args = parameters.profile;
      break;
    case "set_breakpoints":
      if (parameters.file_path !== undefined) {
        parts.target = workspaceRelativeDapPath(cwd, parameters.file_path);
      }
      if (parameters.breakpoints !== undefined) {
        parts.args = pluralizedCount(parameters.breakpoints.length, "breakpoint");
      }
      break;
    case "stack":
      if (parameters.thread_id !== undefined) parts.args = `thread #${parameters.thread_id}`;
      break;
    case "variables":
      if (parameters.frame_id !== undefined) parts.target = `frame #${parameters.frame_id}`;
      else if (parameters.variables_reference !== undefined) {
        parts.target = `reference #${parameters.variables_reference}`;
      }
      break;
    case "evaluate":
      if (parameters.expression !== undefined) {
        parts.target = boundedDapPreview(parameters.expression, 72);
      }
      break;
    default:
      break;
  }
  return parts;
}

/** The supplied arguments of one call as `key: value` rows, mirroring Pi's generic header. */
function dapCallArgumentRows(parameters: DapToolCallArguments, cwd: string): string[] {
  const rows: string[] = [];
  const add = (key: string, value: string | number | undefined) => {
    if (value !== undefined) rows.push(`${key}: ${value}`);
  };
  add("profile", parameters.profile);
  add(
    "program",
    parameters.program === undefined
      ? undefined
      : workspaceRelativeDapPath(cwd, parameters.program),
  );
  add(
    "args",
    parameters.args === undefined
      ? undefined
      : parameters.args.map((argument) => boundedDapPreview(argument)).join(" ") || "(none)",
  );
  add(
    "cwd",
    parameters.cwd === undefined ? undefined : workspaceRelativeDapPath(cwd, parameters.cwd),
  );
  add(
    "file_path",
    parameters.file_path === undefined
      ? undefined
      : workspaceRelativeDapPath(cwd, parameters.file_path),
  );
  if (parameters.breakpoints !== undefined) {
    const shown = parameters.breakpoints
      .slice(0, EXPANDED_BREAKPOINT_LIMIT)
      .map(
        ({ line, condition }) =>
          `${line}${condition === undefined ? "" : ` if ${boundedDapPreview(condition)}`}`,
      );
    const omitted = parameters.breakpoints.length - shown.length;
    add(
      "breakpoints",
      `${shown.join(", ") || "(none)"}${omitted > 0 ? ` (+${omitted} more)` : ""}`,
    );
  }
  add("thread_id", parameters.thread_id);
  add("start", parameters.start);
  add("count", parameters.count);
  add("frame_id", parameters.frame_id);
  add("variables_reference", parameters.variables_reference);
  add(
    "expression",
    parameters.expression === undefined ? undefined : boundedDapPreview(parameters.expression),
  );
  return rows;
}

/**
 * Render one `dap_<operation>` call in Pi's header shape with only the arguments supplied so far.
 * While the call runs, the row carries Pi's `Elapsed` footer until a result row takes over.
 */
export function renderDapToolCall(
  parameters: DapToolCallArguments,
  theme: DapRenderTheme,
  context: DapCallRenderContext,
): Component {
  const container = new Container();
  const { target, args } = dapCallHeaderParts(parameters, context.cwd);
  container.addChild(
    new Text(toolHeader(theme, `dap_${parameters.operation}`, target, args), 0, 0),
  );
  if (context.expanded) {
    const rows = dapCallArgumentRows(parameters, context.cwd);
    if (rows.length > 0) {
      container.addChild(new Text(rows.map((row) => theme.fg("muted", row)).join("\n"), 0, 0));
    }
  }
  container.addChild(callDurationFooter(theme, context));
  return container;
}

function toolResultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
}

function previewLimit(operation: DapOperation): number {
  return operation === "stack" || operation === "variables"
    ? COLLAPSED_LINES.list
    : COLLAPSED_LINES.fallback;
}

/**
 * Render one DAP result as a sanitized preview of its text with Pi's Expand Hint and duration
 * footer. Stack Frames and variables keep `ls`'s 20 lines; everything else keeps the 10-line
 * fallback. A running execution wait sends only progress details, so it shows the footer alone.
 */
export function renderDapToolResult(
  operation: DapOperation,
  result: AgentToolResult<DapToolRenderDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: DapRenderTheme,
  context: DapResultRenderContext,
): Component {
  const container = new Container();
  const isProgress = options.isPartial && Value.Check(DapToolProgressDetailsSchema, result.details);
  const output = isProgress ? "" : sanitizeDapObserverText(toolResultText(result)).trim();
  if (output !== "") {
    const body = previewBody(theme, output.split("\n"), {
      limit: previewLimit(operation),
      expanded: options.expanded,
      color: context.isError ? "error" : "toolOutput",
    });
    container.addChild(new Spacer(1));
    container.addChild(new Text(body.join("\n"), 0, 0));
  }
  appendDurationFooter(container, theme, context, { isPartial: options.isPartial });
  return container;
}
