import type { DebugProtocol } from "@vscode/debugprotocol";
import type { DapOperation } from "./dap-tool-contract.js";
import { workspaceRelativeDapPath } from "./dap-tool-rendering.js";
import type { DapDesiredBreakpointFile, DapSessionResult } from "./dap-session.js";

/** Everything a text formatter may show: one operation's result plus how to present paths. */
interface DapTextContext {
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

function sourceLabel(source: DebugProtocol.Source | undefined, cwd: string): string | undefined {
  if (source?.path !== undefined) return workspaceRelativeDapPath(cwd, source.path);
  return source?.name;
}

/** `file:line:column` for a frame, or `line:column` when the adapter named no source. */
function frameLocation(frame: DebugProtocol.StackFrame, cwd: string): string {
  const position = `${frame.line}:${frame.column}`;
  const source = sourceLabel(frame.source, cwd);
  return source === undefined ? position : `${source}:${position}`;
}

function stateHeadline({ result, cwd, executionWaitCancelled }: DapTextContext): string {
  const { snapshot } = result;
  switch (snapshot.state) {
    case "idle":
      return "idle (no Debug Session)";
    case "launching":
    case "running":
      return executionWaitCancelled ? `${snapshot.state} (wait cancelled)` : snapshot.state;
    case "stopped": {
      const frame = result.stop?.topFrame;
      const location =
        frame === undefined ? "" : ` at ${frameLocation(frame, cwd)} in ${frame.name}`;
      const thread = snapshot.threadId === undefined ? "" : ` · thread ${snapshot.threadId}`;
      return `stopped (${snapshot.stopReason})${location}${thread}`;
    }
    case "terminated": {
      const detail = [
        snapshot.exitCode === undefined ? undefined : `exit code ${snapshot.exitCode}`,
        snapshot.terminationReason,
      ].filter((part) => part !== undefined);
      return detail.length === 0 ? "terminated" : `terminated (${detail.join("; ")})`;
    }
  }
}

/** Lifecycle summary shared by every operation that reports where the Debug Session stands. */
const stateLines: DapTextFormatter = (context) => {
  const { stop } = context.result;
  const lines = [stateHeadline(context)];
  if (stop?.description !== undefined) lines.push(`reason: ${stop.description}`);
  if (stop?.hitBreakpointIds !== undefined && stop.hitBreakpointIds.length > 0) {
    lines.push(`hit breakpoint ids: ${stop.hitBreakpointIds.join(", ")}`);
  }
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

/** The only operation that shows Desired Breakpoints: it is the only one that changes them. */
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
      const message = breakpoint.message === undefined ? "" : `: ${breakpoint.message}`;
      const status = breakpoint.verified ? "verified" : "not verified";
      lines.push(`  line ${breakpoint.line ?? "?"}${id} ${status}${message}`);
    }
  }
  return [...lines, ...desiredBreakpointLines(result.desiredBreakpoints, cwd)];
};

const stackLines: DapTextFormatter = ({ result, cwd }) => {
  const frames = result.stackFrames ?? [];
  const total = result.totalFrames ?? frames.length;
  const count = total > frames.length ? `${frames.length} of ${total}` : `${frames.length}`;
  return [
    `Stack: ${count} frame${total === 1 ? "" : "s"}`,
    ...frames.map((frame) => `  frame ${frame.id}: ${frame.name} at ${frameLocation(frame, cwd)}`),
  ];
};

function variableLine(variable: DebugProtocol.Variable, indent: string): string {
  const type = variable.type === undefined ? "" : `: ${variable.type}`;
  const children =
    variable.variablesReference > 0 ? ` [variables_reference ${variable.variablesReference}]` : "";
  return `${indent}${variable.name}${type} = ${variable.value}${children}`;
}

const variablesLines: DapTextFormatter = ({ result }) => {
  if (result.variableGroups !== undefined) {
    return result.variableGroups.flatMap(({ scope, variables }) => [
      `Scope ${scope.name} [variables_reference ${scope.variablesReference}]${scope.expensive ? " (expensive)" : ""}: ${variables.length} variable${variables.length === 1 ? "" : "s"}`,
      ...variables.map((variable) => variableLine(variable, "  ")),
    ]);
  }
  const variables = result.variables ?? [];
  return [
    `Variables: ${variables.length}`,
    ...variables.map((variable) => variableLine(variable, "  ")),
  ];
};

const evaluateLines: DapTextFormatter = ({ result }) => {
  const evaluation = result.evaluation;
  if (evaluation === undefined) return [];
  const type = evaluation.type === undefined ? "" : ` (${evaluation.type})`;
  const children =
    evaluation.variablesReference > 0
      ? ` [variables_reference ${evaluation.variablesReference}]`
      : "";
  return [`${evaluation.result}${type}${children}`];
};

const DAP_TEXT_FORMATTERS = {
  launch: stateLines,
  set_breakpoints: setBreakpointsLines,
  continue: stateLines,
  next: stateLines,
  step_in: stateLines,
  step_out: stateLines,
  pause: stateLines,
  stack: stackLines,
  variables: variablesLines,
  evaluate: evaluateLines,
  status: stateLines,
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
    ...DAP_TEXT_FORMATTERS[operation]({ result, cwd, executionWaitCancelled }),
  ];
  const summary = lines.join("\n");
  if (result.output.length === 0) return summary;
  const discardNotice =
    result.discardedOutputBytes === 0
      ? ""
      : ` (${result.discardedOutputBytes} older bytes discarded)`;
  return `${summary}\n\nDebuggee output${discardNotice}:\n${result.output}`;
}
