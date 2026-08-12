import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
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

async function runGit(args: string[], cwd: string) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trimEnd();
}

async function getFallbackBranch(cwd: string) {
  const branch = await runGit(["branch", "--show-current"], cwd);
  if (branch.length > 0) return branch;

  const head = await runGit(["rev-parse", "--short", "HEAD"], cwd);
  return head.length > 0 ? `detached@${head}` : "unknown";
}

function parseBranchHeader(line: string, fallback: string) {
  const branch = line.slice("# branch.head ".length).trim();
  if (branch === "(detached)") return fallback;
  return branch || fallback;
}

function parseAheadBehind(line: string) {
  const match = line.match(/# branch\.ab \+(\d+) -(\d+)/);
  return {
    ahead: match ? Number(match[1]) : 0,
    behind: match ? Number(match[2]) : 0,
  };
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
  const [fallbackBranch, statusOutput] = await Promise.all([
    getFallbackBranch(cwd),
    runGit(["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], cwd),
  ]);

  const status: GitStatus = {
    branch: fallbackBranch,
    ahead: 0,
    behind: 0,
    conflicted: 0,
    untracked: 0,
    modified: 0,
    clean: true,
  };

  for (const line of statusOutput.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      status.branch = parseBranchHeader(line, fallbackBranch);
      continue;
    }

    if (line.startsWith("# branch.ab ")) {
      Object.assign(status, parseAheadBehind(line));
      continue;
    }

    countStatusLine(status, line);
  }

  status.clean =
    status.ahead === 0 &&
    status.behind === 0 &&
    status.conflicted === 0 &&
    status.untracked === 0 &&
    status.modified === 0;

  return status;
}

function renderToken(ctx: ExtensionContext, color: ThemeColor, text: string) {
  return ctx.ui.theme.fg(color, text);
}

function renderCount(ctx: ExtensionContext, color: ThemeColor, icon: string, count: number) {
  if (count === 0) return undefined;
  return renderToken(ctx, color, `${icon}${count}`);
}

function renderGitStatus(ctx: ExtensionContext, status: GitStatus) {
  const tokens = [
    renderToken(ctx, "syntaxKeyword", ""),
    renderToken(ctx, "syntaxType", status.branch),
    renderCount(ctx, "error", "⇡", status.ahead),
    renderCount(ctx, "error", "⇣", status.behind),
    renderCount(ctx, "error", "", status.conflicted),
    renderCount(ctx, "mdLink", "?", status.untracked),
    renderCount(ctx, "warning", "", status.modified),
    status.clean ? renderToken(ctx, "success", "") : undefined,
  ].filter((token): token is string => Boolean(token));

  return `${tokens.join(renderToken(ctx, "dim", " "))}`;
}

async function updateWidget(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;

  try {
    await runGit(["rev-parse", "--is-inside-work-tree"], ctx.cwd);
    const status = await getGitStatus(ctx.cwd);
    ctx.ui.setWidget(WIDGET_ID, [renderGitStatus(ctx, status)]);
  } catch {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
}

export default function (pi: ExtensionAPI) {
  let interval: NodeJS.Timeout | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (interval) clearInterval(interval);

    await updateWidget(ctx);
    interval = setInterval(() => {
      void updateWidget(ctx);
    }, UPDATE_INTERVAL_MS);
  });

  pi.on("input", async (_event, ctx) => {
    await updateWidget(ctx);
    return { action: "continue" };
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    await updateWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
  });
}
