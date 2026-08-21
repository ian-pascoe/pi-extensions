import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionShutdownEvent,
  SessionStartEvent,
  ThemeColor,
  ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WIDGET_ID = "git-status-widget";
const UPDATE_INTERVAL_MS = 2_000;

type GitStatus = {
  branch: string;
  ahead: number;
  behind: number;
  conflicted: number;
  untracked: number;
  modified: number;
  clean: boolean;
};

/** The narrow widget UI contract used by a Git Status Widget refresh. */
export interface GitStatusWidgetContext {
  cwd: string;
  hasUI: boolean;
  render(color: ThemeColor, text: string): string;
  setWidget(id: string, lines: string[] | undefined): void;
}

/** Registers the exact Pi lifecycle events needed by the Git Status Widget. */
export interface GitStatusWidgetLifecycleHost {
  onSessionStart(
    handler: (event: SessionStartEvent, context: GitStatusWidgetContext) => Promise<void>,
  ): void;
  onInput(
    handler: (event: InputEvent, context: GitStatusWidgetContext) => Promise<InputEventResult>,
  ): void;
  onToolExecutionEnd(
    handler: (event: ToolExecutionEndEvent, context: GitStatusWidgetContext) => Promise<void>,
  ): void;
  onSessionShutdown(
    handler: (event: SessionShutdownEvent, context: GitStatusWidgetContext) => Promise<void>,
  ): void;
}

async function runGit(args: string[], cwd: string) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trimEnd();
}

function parseAheadBehind(line: string) {
  const match = line.match(/# branch\.ab \+(\d+) -(\d+)/);
  return { ahead: match ? Number(match[1]) : 0, behind: match ? Number(match[2]) : 0 };
}

function countStatusLine(status: GitStatus, line: string) {
  if (line.startsWith("u ")) {
    status.conflicted += 1;
    return;
  }
  if (line.startsWith("? ")) {
    status.untracked += 1;
    return;
  }
  if (!line.startsWith("1 ") && !line.startsWith("2 ")) return;
  const indexStatus = line[2];
  const worktreeStatus = line[3];
  if (indexStatus === "U" || worktreeStatus === "U") {
    status.conflicted += 1;
    return;
  }
  if (worktreeStatus !== "." || indexStatus === "D") status.modified += 1;
}

async function getGitStatus(cwd: string): Promise<GitStatus> {
  const statusOutput = await runGit(
    ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
    cwd,
  );
  const status: GitStatus = {
    branch: "unknown",
    ahead: 0,
    behind: 0,
    conflicted: 0,
    untracked: 0,
    modified: 0,
    clean: true,
  };
  let branchHead: string | undefined;
  let branchOid: string | undefined;
  for (const line of statusOutput.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      branchHead = line.slice("# branch.head ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.oid ")) {
      branchOid = line.slice("# branch.oid ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      Object.assign(status, parseAheadBehind(line));
      continue;
    }
    countStatusLine(status, line);
  }
  status.branch =
    branchHead === "(detached)"
      ? branchOid && branchOid !== "(initial)"
        ? `detached@${branchOid.slice(0, 7)}`
        : "unknown"
      : branchHead || "unknown";
  status.clean =
    status.ahead === 0 &&
    status.behind === 0 &&
    status.conflicted === 0 &&
    status.untracked === 0 &&
    status.modified === 0;
  return status;
}

function renderCount(
  context: GitStatusWidgetContext,
  color: ThemeColor,
  icon: string,
  count: number,
) {
  return count === 0 ? undefined : context.render(color, `${icon}${count}`);
}

function renderGitStatus(context: GitStatusWidgetContext, status: GitStatus) {
  const tokens = [
    context.render("syntaxKeyword", ""),
    context.render("syntaxType", status.branch),
    renderCount(context, "error", "⇡", status.ahead),
    renderCount(context, "error", "⇣", status.behind),
    renderCount(context, "error", "", status.conflicted),
    renderCount(context, "mdLink", "?", status.untracked),
    renderCount(context, "warning", "", status.modified),
    status.clean ? context.render("success", "") : undefined,
  ].filter((token): token is string => Boolean(token));
  return tokens.join(context.render("dim", " "));
}

async function updateGitStatusWidget(context: GitStatusWidgetContext) {
  if (!context.hasUI) return;
  try {
    context.setWidget(WIDGET_ID, [renderGitStatus(context, await getGitStatus(context.cwd))]);
  } catch {
    context.setWidget(WIDGET_ID, undefined);
  }
}

/** Installs Worktree Snapshot refresh behavior through a narrow lifecycle host. */
export function registerGitStatusWidget(host: GitStatusWidgetLifecycleHost) {
  let refreshInterval: ReturnType<typeof setInterval> | undefined;
  host.onSessionStart(async (_event, context) => {
    if (refreshInterval) clearInterval(refreshInterval);
    await updateGitStatusWidget(context);
    refreshInterval = setInterval(() => {
      void updateGitStatusWidget(context);
    }, UPDATE_INTERVAL_MS);
  });
  host.onInput(async (_event, context) => {
    await updateGitStatusWidget(context);
    return { action: "continue" };
  });
  host.onToolExecutionEnd(async (_event, context) => {
    await updateGitStatusWidget(context);
  });
  host.onSessionShutdown(async (_event, context) => {
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = undefined;
    if (context.hasUI) context.setWidget(WIDGET_ID, undefined);
  });
}

function gitStatusWidgetContext(context: ExtensionContext): GitStatusWidgetContext {
  return {
    cwd: context.cwd,
    hasUI: context.hasUI,
    render: (color, text) => context.ui.theme.fg(color, text),
    setWidget: (id, lines) => context.ui.setWidget(id, lines),
  };
}

/** Installs Git Status Widget behavior into Pi's extension lifecycle. */
export default function gitStatusWidgetExtension(pi: ExtensionAPI) {
  registerGitStatusWidget({
    onSessionStart: (handler) =>
      pi.on("session_start", (event, context) => handler(event, gitStatusWidgetContext(context))),
    onInput: (handler) =>
      pi.on("input", (event, context) => handler(event, gitStatusWidgetContext(context))),
    onToolExecutionEnd: (handler) =>
      pi.on("tool_execution_end", (event, context) =>
        handler(event, gitStatusWidgetContext(context)),
      ),
    onSessionShutdown: (handler) =>
      pi.on("session_shutdown", (event, context) =>
        handler(event, gitStatusWidgetContext(context)),
      ),
  });
}
