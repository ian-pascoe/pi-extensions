import type {
  InputEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ThemeColor,
  ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  registerGitStatusWidget,
  type GitStatusWidgetContext,
  type GitStatusWidgetLifecycleHost,
} from "../src/git-status-widget-lifecycle.js";

class RecordingGitStatusWidgetLifecycleHost implements GitStatusWidgetLifecycleHost {
  sessionStart: Parameters<GitStatusWidgetLifecycleHost["onSessionStart"]>[0] | undefined;
  input: Parameters<GitStatusWidgetLifecycleHost["onInput"]>[0] | undefined;
  toolExecutionEnd: Parameters<GitStatusWidgetLifecycleHost["onToolExecutionEnd"]>[0] | undefined;
  sessionShutdown: Parameters<GitStatusWidgetLifecycleHost["onSessionShutdown"]>[0] | undefined;

  onSessionStart(handler: Parameters<GitStatusWidgetLifecycleHost["onSessionStart"]>[0]) {
    this.sessionStart = handler;
  }
  onInput(handler: Parameters<GitStatusWidgetLifecycleHost["onInput"]>[0]) {
    this.input = handler;
  }
  onToolExecutionEnd(handler: Parameters<GitStatusWidgetLifecycleHost["onToolExecutionEnd"]>[0]) {
    this.toolExecutionEnd = handler;
  }
  onSessionShutdown(handler: Parameters<GitStatusWidgetLifecycleHost["onSessionShutdown"]>[0]) {
    this.sessionShutdown = handler;
  }
}

class RecordingWidgetContext implements GitStatusWidgetContext {
  readonly widgetUpdates: (string[] | undefined)[] = [];
  constructor(
    readonly cwd: string,
    readonly hasUI = true,
  ) {}
  render(_color: ThemeColor, text: string) {
    return text;
  }
  setWidget(id: string, lines: string[] | undefined) {
    if (id !== "git-status-widget") throw new Error(`Unexpected widget: ${id}`);
    this.widgetUpdates.push(lines);
  }
  latestWidgetText() {
    const latestLines = this.widgetUpdates.at(-1);
    if (!latestLines) throw new Error("Expected Git Status Widget output");
    return latestLines[0] ?? "";
  }
}

type FakeGitConfiguration = {
  mode?: string;
  status?: string;
};

const temporaryDirectories: string[] = [];
const originalEnvironment = {
  PATH: process.env.PATH,
  GIT_WIDGET_MODE: process.env.GIT_WIDGET_MODE,
  GIT_WIDGET_STATUS: process.env.GIT_WIDGET_STATUS,
};

function requireHandler<T>(handler: T | undefined): T {
  if (handler === undefined)
    throw new Error("Expected registered Git Status Widget lifecycle handler");
  return handler;
}

async function createTemporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFakeGitDirectory() {
  const directory = await createTemporaryDirectory("pi-git-status-widget-bin-");
  const fakeGit = join(directory, "git");
  await writeFile(
    fakeGit,
    [
      "#!/bin/sh",
      'if [ "$1" = "status" ]; then',
      '  [ "$GIT_WIDGET_MODE" = "fail" ] && exit 1',
      "  printf '%s\\n' \"$GIT_WIDGET_STATUS\"",
      "else",
      "  exit 1",
      "fi",
      "",
    ].join("\n"),
  );
  await chmod(fakeGit, 0o755);
  return directory;
}

function configureFakeGit(fakeBin: string, values: FakeGitConfiguration) {
  process.env.PATH = `${fakeBin}:${originalEnvironment.PATH ?? ""}`;
  process.env.GIT_WIDGET_MODE = values.mode ?? "";
  process.env.GIT_WIDGET_STATUS = values.status ?? "# branch.head main";
}

function restoreEnvironment() {
  const environmentEntries = Object.entries(originalEnvironment);
  for (const [name, value] of environmentEntries) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

const sessionStartEvent = { type: "session_start", reason: "startup" } satisfies SessionStartEvent;
const inputEvent = { type: "input", text: "refresh", source: "interactive" } satisfies InputEvent;
const toolExecutionEndEvent = {
  type: "tool_execution_end",
  toolCallId: "tool-1",
  toolName: "read",
  result: {},
  isError: false,
} satisfies ToolExecutionEndEvent;
const sessionShutdownEvent = {
  type: "session_shutdown",
  reason: "quit",
} satisfies SessionShutdownEvent;

afterEach(async () => {
  vi.useRealTimers();
  restoreEnvironment();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Git Status Widget extension", () => {
  test("renders porcelain-v2 counts and refreshes after input and tools", async () => {
    const fakeBin = await createFakeGitDirectory();
    configureFakeGit(fakeBin, {
      status: [
        "# branch.oid abc1234",
        "# branch.head main",
        "# branch.ab +2 -3",
        "u UU N... 100644 100644 100644 100000 deadbeef deadbeef conflict.ts",
        "? untracked.ts",
        "1 .M N... 100644 100644 100644 deadbeef deadbeef worktree-modified.ts",
        "1 D. N... 100644 100644 100644 deadbeef deadbeef index-deleted.ts",
      ].join("\n"),
    });
    const host = new RecordingGitStatusWidgetLifecycleHost();
    const context = new RecordingWidgetContext(
      await createTemporaryDirectory("pi-git-status-widget-cwd-"),
    );
    registerGitStatusWidget(host);

    await requireHandler(host.sessionStart)(sessionStartEvent, context);
    expect(context.latestWidgetText()).toContain("main");
    expect(context.latestWidgetText()).toContain("⇡2");
    expect(context.latestWidgetText()).toContain("⇣3");
    expect(context.latestWidgetText()).toContain("1");
    expect(context.latestWidgetText()).toContain("?1");
    expect(context.latestWidgetText()).toContain("2");
    expect(await requireHandler(host.input)(inputEvent, context)).toEqual({ action: "continue" });
    await requireHandler(host.toolExecutionEnd)(toolExecutionEndEvent, context);
    expect(context.widgetUpdates).toHaveLength(3);
    await requireHandler(host.sessionShutdown)(sessionShutdownEvent, context);
    expect(context.widgetUpdates.at(-1)).toBeUndefined();
  });

  test("renders detached clean worktrees and hides failures", async () => {
    const fakeBin = await createFakeGitDirectory();
    configureFakeGit(fakeBin, {
      status: ["# branch.oid deadbeefcafebabe", "# branch.head (detached)"].join("\n"),
    });
    const host = new RecordingGitStatusWidgetLifecycleHost();
    const context = new RecordingWidgetContext(
      await createTemporaryDirectory("pi-git-status-widget-cwd-"),
    );
    registerGitStatusWidget(host);
    await requireHandler(host.sessionStart)(sessionStartEvent, context);
    expect(context.latestWidgetText()).toContain("detached@deadbee");
    expect(context.latestWidgetText()).toContain("");
    process.env.GIT_WIDGET_MODE = "fail";
    await requireHandler(host.input)(inputEvent, context);
    expect(context.widgetUpdates.at(-1)).toBeUndefined();
  });

  test("does not write widgets without a TUI while preserving input control flow", async () => {
    const fakeBin = await createFakeGitDirectory();
    configureFakeGit(fakeBin, {});
    const host = new RecordingGitStatusWidgetLifecycleHost();
    const context = new RecordingWidgetContext(
      await createTemporaryDirectory("pi-git-status-widget-cwd-"),
      false,
    );
    registerGitStatusWidget(host);
    await requireHandler(host.sessionStart)(sessionStartEvent, context);
    expect(await requireHandler(host.input)(inputEvent, context)).toEqual({ action: "continue" });
    await requireHandler(host.toolExecutionEnd)(toolExecutionEndEvent, context);
    await requireHandler(host.sessionShutdown)(sessionShutdownEvent, context);
    expect(context.widgetUpdates).toHaveLength(0);
  });

  test("refreshes every two seconds, replaces the interval, and clears it during shutdown", async () => {
    vi.useFakeTimers();
    const fakeBin = await createFakeGitDirectory();
    configureFakeGit(fakeBin, {});
    const host = new RecordingGitStatusWidgetLifecycleHost();
    const context = new RecordingWidgetContext(
      await createTemporaryDirectory("pi-git-status-widget-cwd-"),
    );
    registerGitStatusWidget(host);

    await requireHandler(host.sessionStart)(sessionStartEvent, context);
    expect(vi.getTimerCount()).toBe(1);
    await requireHandler(host.sessionStart)(sessionStartEvent, context);
    expect(vi.getTimerCount()).toBe(1);

    const updatesBeforeInterval = context.widgetUpdates.length;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => {
      expect(context.widgetUpdates.length).toBe(updatesBeforeInterval + 1);
    });

    await requireHandler(host.sessionShutdown)(sessionShutdownEvent, context);
    expect(vi.getTimerCount()).toBe(0);
    expect(context.widgetUpdates.at(-1)).toBeUndefined();
  });

  test("reads Worktree Snapshot state from a temporary real Git repository", async () => {
    const repository = await createTemporaryDirectory("pi-git-status-widget-repository-");
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repository });
    await writeFile(join(repository, "tracked.txt"), "before\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repository });
    await writeFile(join(repository, "tracked.txt"), "after\n");
    await writeFile(join(repository, "untracked.txt"), "untracked\n");
    const host = new RecordingGitStatusWidgetLifecycleHost();
    const context = new RecordingWidgetContext(repository);
    registerGitStatusWidget(host);
    await requireHandler(host.sessionStart)(sessionStartEvent, context);
    expect(context.latestWidgetText()).toContain("main");
    expect(context.latestWidgetText()).toContain("?1");
    expect(context.latestWidgetText()).toContain("1");
  });
});
