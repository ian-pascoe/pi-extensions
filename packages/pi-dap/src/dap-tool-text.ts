import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { DebugProtocol } from "@vscode/debugprotocol";
import type { DapOperation } from "./dap-tool-contract.js";
import { workspaceRelativeDapPath } from "./dap-tool-rendering.js";
import type {
  DapDesiredBreakpointFile,
  DapSessionResult,
  DapVariableGroup,
} from "./dap-session.js";

/** Everything a text formatter may show: one operation's result plus how to present paths. */
interface DapTextContext {
  readonly operation: DapOperation;
  readonly result: DapSessionResult;
  /** Project directory that source paths are shown relative to. */
  readonly cwd: string;
  /** The call stopped waiting because it was cancelled, not because the Debuggee stopped. */
  readonly executionWaitCancelled: boolean;
}

type DapTextFormatter = (context: DapTextContext) => readonly string[];

/** Compact text a model reads for one operation: a few lines, never a raw JSON dump. */
interface DapToolTextInput {
  readonly operation: DapOperation;
  readonly result: DapSessionResult;
  readonly cwd: string;
  readonly executionWaitCancelled: boolean;
  /** Warnings lead so that truncating a long result can never drop them. */
  readonly warnings: readonly string[];
}

/**
 * Adapter-supplied strings stay on one line, so a value can neither add rows nor fake the
 * "Debuggee output" heading the Observer UI looks for. `structuredContent` keeps them verbatim.
 */
function oneLine(value: string): string {
  return value.replace(/\r\n|\r|\n/gu, "\\n");
}

function sourceLabel(source: DebugProtocol.Source | undefined, cwd: string): string | undefined {
  if (source?.path !== undefined) return workspaceRelativeDapPath(cwd, source.path);
  return source?.name;
}

/** `file:line:column` for a frame, or `line:column` when the adapter named no source. */
function frameLocation(frame: DebugProtocol.StackFrame, cwd: string): string {
  const position = `${frame.line}:${frame.column}`;
  const source = sourceLabel(frame.source, cwd);
  return oneLine(source === undefined ? position : `${source}:${position}`);
}

/** Operations that wait for the Debuggee, so a `running` result means the wait ended early. */
const EXECUTION_WAIT_OPERATIONS: readonly DapOperation[] = [
  "launch",
  "continue",
  "next",
  "step_in",
  "step_out",
];

function runningHeadline(state: string, { operation, executionWaitCancelled }: DapTextContext) {
  if (executionWaitCancelled) return `${state} (wait cancelled)`;
  return EXECUTION_WAIT_OPERATIONS.includes(operation) ? `${state} (wait timed out)` : state;
}

function stateHeadline(context: DapTextContext): string {
  const { result, cwd } = context;
  const { snapshot } = result;
  switch (snapshot.state) {
    case "idle":
      return "idle (no Debug Session)";
    case "launching":
    case "running":
      return runningHeadline(snapshot.state, context);
    case "stopped": {
      const frame = result.stop?.topFrame;
      const location =
        frame === undefined ? "" : ` at ${frameLocation(frame, cwd)} in ${oneLine(frame.name)}`;
      const thread = snapshot.threadId === undefined ? "" : ` · thread ${snapshot.threadId}`;
      return `stopped (${snapshot.stopReason})${location}${thread}`;
    }
    case "terminated": {
      const detail = [
        snapshot.exitCode === undefined ? undefined : `exit code ${snapshot.exitCode}`,
        snapshot.terminationReason === undefined ? undefined : oneLine(snapshot.terminationReason),
      ].filter((part) => part !== undefined);
      return detail.length === 0 ? "terminated" : `terminated (${detail.join("; ")})`;
    }
  }
}

/** The most undebugged child sessions shown in text; `structuredContent` lists them all. */
const MAX_REJECTED_CHILD_SESSION_LINES = 5;

/** One line per child session Pi DAP could not debug, so the model learns its breakpoints will not bind. */
function rejectedChildSessionLines({ result }: DapTextContext): readonly string[] {
  const rejected = result.rejectedChildSessions ?? [];
  const lines = rejected
    .slice(0, MAX_REJECTED_CHILD_SESSION_LINES)
    .map((child) => `Warning: ${oneLine(child.message)}`);
  if (rejected.length > MAX_REJECTED_CHILD_SESSION_LINES) {
    lines.push(
      `Warning: ${rejected.length - MAX_REJECTED_CHILD_SESSION_LINES} more child sessions not debugged`,
    );
  }
  if (rejected.length > 0) {
    lines.push("To debug that code, launch it directly as the program.");
  }
  return lines;
}

/** Lifecycle summary shared by every operation that reports where the Debug Session stands. */
const stateLines: DapTextFormatter = (context) => {
  const { stop } = context.result;
  const lines = [stateHeadline(context)];
  if (stop?.childSession !== undefined) lines.push(`child session: ${oneLine(stop.childSession)}`);
  if (stop?.description !== undefined) lines.push(`description: ${oneLine(stop.description)}`);
  if (stop?.hitBreakpointIds !== undefined && stop.hitBreakpointIds.length > 0) {
    lines.push(`hit breakpoint ids: ${stop.hitBreakpointIds.join(", ")}`);
  }
  lines.push(...rejectedChildSessionLines(context));
  return lines;
};

function desiredBreakpointLines(
  files: readonly DapDesiredBreakpointFile[],
  cwd: string,
): readonly string[] {
  const rows = files.flatMap((file) =>
    file.breakpoints.map((breakpoint) => {
      const condition = breakpoint.condition === undefined ? "" : ` if ${breakpoint.condition}`;
      return `  ${workspaceRelativeDapPath(cwd, file.filePath)}:${breakpoint.line}${condition}`;
    }),
  );
  return rows.length === 0 ? ["Desired Breakpoints: none"] : ["Desired Breakpoints:", ...rows];
}

const setBreakpointsLines: DapTextFormatter = ({ result, cwd }) => {
  const rows = result.breakpoints;
  const lines: string[] = [];
  if (rows === undefined) {
    lines.push("Saved; breakpoints apply to the next launch (no active Debug Session).");
  } else {
    const verified = rows.filter((breakpoint) => breakpoint.verified).length;
    lines.push(`Breakpoints: ${verified} of ${rows.length} verified`);
    for (const breakpoint of rows) {
      const id = breakpoint.id === undefined ? "" : ` (id ${breakpoint.id})`;
      const message = breakpoint.message === undefined ? "" : `: ${oneLine(breakpoint.message)}`;
      const status = breakpoint.verified ? "verified" : "not verified";
      lines.push(`  line ${breakpoint.line ?? "?"}${id} ${status}${message}`);
    }
  }
  return [...lines, ...desiredBreakpointLines(result.desiredBreakpoints, cwd)];
};

/**
 * Desired Breakpoints show in `dap_set_breakpoints` (which changes them), `dap_launch`, and
 * `dap_status`. An empty list adds no line to a state report.
 */
const stateWithDesiredBreakpointsLines: DapTextFormatter = (context) => [
  ...stateLines(context),
  ...(context.result.desiredBreakpoints.some((file) => file.breakpoints.length > 0)
    ? desiredBreakpointLines(context.result.desiredBreakpoints, context.cwd)
    : []),
];

const stackLines: DapTextFormatter = ({ result, cwd }) => {
  const frames = result.stackFrames ?? [];
  const total = result.totalFrames ?? frames.length;
  const count = total > frames.length ? `${frames.length} of ${total}` : `${frames.length}`;
  return [
    `Stack: ${count} frame${total === 1 ? "" : "s"}`,
    ...frames.map(
      (frame) => `  frame ${frame.id}: ${oneLine(frame.name)} at ${frameLocation(frame, cwd)}`,
    ),
  ];
};

function variableLine(variable: DebugProtocol.Variable, indent: string): string {
  const type = variable.type === undefined ? "" : `: ${oneLine(variable.type)}`;
  const children =
    variable.variablesReference > 0 ? ` [variables_reference ${variable.variablesReference}]` : "";
  return `${indent}${oneLine(variable.name)}${type} = ${oneLine(variable.value)}${children}`;
}

function scopeLines({ scope, variables }: DapVariableGroup): readonly string[] {
  const header = `Scope ${oneLine(scope.name)} [variables_reference ${scope.variablesReference}]`;
  if (variables === undefined) {
    return [`${header} (expensive, not expanded; pass its variables_reference to expand)`];
  }
  const count = `${variables.length} variable${variables.length === 1 ? "" : "s"}`;
  return [`${header}: ${count}`, ...variables.map((variable) => variableLine(variable, "  "))];
}

const variablesLines: DapTextFormatter = ({ result }) => {
  if (result.variableGroups !== undefined) return result.variableGroups.flatMap(scopeLines);
  const variables = result.variables ?? [];
  return [
    `Variables: ${variables.length}`,
    ...variables.map((variable) => variableLine(variable, "  ")),
  ];
};

const evaluateLines: DapTextFormatter = ({ result }) => {
  const evaluation = result.evaluation;
  if (evaluation === undefined) return [];
  const type = evaluation.type === undefined ? "" : ` (${oneLine(evaluation.type)})`;
  const children =
    evaluation.variablesReference > 0
      ? ` [variables_reference ${evaluation.variablesReference}]`
      : "";
  return [`${oneLine(evaluation.result)}${type}${children}`];
};

const DAP_TEXT_FORMATTERS = {
  launch: stateWithDesiredBreakpointsLines,
  set_breakpoints: setBreakpointsLines,
  continue: stateLines,
  next: stateLines,
  step_in: stateLines,
  step_out: stateLines,
  pause: stateLines,
  stack: stackLines,
  variables: variablesLines,
  evaluate: evaluateLines,
  status: stateWithDesiredBreakpointsLines,
  stop: stateLines,
} satisfies Record<DapOperation, DapTextFormatter>;

/**
 * Model-visible text of one successful operation: warnings, a compact operation summary, then any
 * drained Debuggee output under its own heading. The full data stays in `structuredContent`.
 */
export function formatDapToolText(input: DapToolTextInput): string {
  const { operation, result, cwd, executionWaitCancelled, warnings } = input;
  const lines = [
    ...warnings.map((warning) => `Warning: ${warning}`),
    ...DAP_TEXT_FORMATTERS[operation]({ operation, result, cwd, executionWaitCancelled }),
  ];
  const summary = lines.join("\n");
  if (result.output.length === 0) return summary;
  const discardNotice =
    result.discardedOutputBytes === 0
      ? ""
      : ` (${result.discardedOutputBytes} older bytes discarded)`;
  return `${summary}\n\nDebuggee output${discardNotice}:\n${result.output}`;
}

/** Model-visible part of a result: whole lines within Pi's limits, never empty for non-empty text. */
export interface DapVisibleText {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Cut `text` at line boundaries to Pi's 2,000-line/50-KB limit. Pi's `truncateHead` returns nothing
 * when the first line alone is over the byte limit; then that line is cut mid-line instead, so the
 * reader still sees the start of the result.
 */
export function visibleDapText(text: string): DapVisibleText {
  const head = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!head.truncated) return { text, truncated: false };
  if (head.content.length > 0) return { text: head.content, truncated: true };
  const firstLine = text.split("\n", 1)[0] ?? "";
  const bytes = Buffer.from(firstLine, "utf8").subarray(0, DEFAULT_MAX_BYTES);
  // A cut inside a multi-byte character decodes to a trailing U+FFFD; drop it.
  return { text: bytes.toString("utf8").replace(/\uFFFD$/u, ""), truncated: true };
}
