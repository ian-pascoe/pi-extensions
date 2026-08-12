import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

type ExtensionHandler = (event: unknown, context: unknown) => Promise<unknown>;

const temporaryDirectories: string[] = [];
const originalEnvironment = {
  PATH: process.env.PATH,
  GIT_WIDGET_BRANCH: process.env.GIT_WIDGET_BRANCH,
  GIT_WIDGET_HEAD: process.env.GIT_WIDGET_HEAD,
  GIT_WIDGET_MODE: process.env.GIT_WIDGET_MODE,
  GIT_WIDGET_STATUS: process.env.GIT_WIDGET_STATUS,
};

function createRecordingPi() {
  const handlers = new Map<string, ExtensionHandler>();
  return {
    handlers,
    pi: {
      on(event: string, handler: ExtensionHandler) {
        handlers.set(event, handler);
      },
    },
  };
}

function createWidgetContext(cwd: string, hasUI = true) {
  const setWidget = vi.fn();
  return {
    context: {
      cwd,
      hasUI,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setWidget,
      },
    },
    setWidget,
  };
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
      'if [ "$1" = "rev-parse" ] && [ "$2" = "--is-inside-work-tree" ]; then',
      '  [ "$GIT_WIDGET_MODE" = "fail" ] && exit 1',
      "  echo true",
      'elif [ "$1" = "branch" ]; then',
      "  printf '%s\\n' \"$GIT_WIDGET_BRANCH\"",
      'elif [ "$1" = "rev-parse" ]; then',
      "  printf '%s\\n' \"$GIT_WIDGET_HEAD\"",
      'elif [ "$1" = "status" ]; then',
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

function configureFakeGit(fakeBin: string, values: Record<string, string>) {
  process.env.PATH = `${fakeBin}:${originalEnvironment.PATH ?? ""}`;
  process.env.GIT_WIDGET_MODE = values.mode ?? "";
  process.env.GIT_WIDGET_BRANCH = values.branch ?? "main";
  process.env.GIT_WIDGET_HEAD = values.head ?? "abc1234";
  process.env.GIT_WIDGET_STATUS = values.status ?? "# branch.head main";
}

function restoreEnvironment() {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function latestWidgetText(setWidget: ReturnType<typeof vi.fn>) {
  const latestCall = setWidget.mock.lastCall;
  expect(latestCall?.[0]).toBe("git-status-widget");
  expect(latestCall?.[1]).toHaveLength(1);
  return latestCall?.[1]?.[0] as string;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  restoreEnvironment();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Git Status Widget extension", () => {
  test("registers its lifecycle, renders porcelain-v2 counts, and refreshes after input and tools", async () => {
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
    vi.resetModules();
    const extension = (await import("../src/index.js")).default;
    const recording = createRecordingPi();
    const { context, setWidget } = createWidgetContext(
      await createTemporaryDirectory("pi-git-status-widget-cwd-"),
    );
    extension(recording.pi as never);

    expect([...recording.handlers.keys()]).toEqual([
      "session_start",
      "input",
      "tool_execution_end",
      "session_shutdown",
    ]);

    await recording.handlers.get("session_start")!({}, context);
    expect(latestWidgetText(setWidget)).toContain("main");
    expect(latestWidgetText(setWidget)).toContain("⇡2");
    expect(latestWidgetText(setWidget)).toContain("⇣3");
    expect(latestWidgetText(setWidget)).toContain("1");
    expect(latestWidgetText(setWidget)).toContain("?1");
    expect(latestWidgetText(setWidget)).toContain("2");

    const inputResult = await recording.handlers.get("input")!({}, context);
    expect(inputResult).toEqual({ action: "continue" });
    await recording.handlers.get("tool_execution_end")!({}, context);
    expect(setWidget).toHaveBeenCalledTimes(3);
    await recording.handlers.get("session_shutdown")!({}, context);
    expect(setWidget).toHaveBeenLastCalledWith("git-status-widget", undefined);
  });

  test("renders detached and clean worktrees, and hides failures or non-worktrees", async () => {
    const fakeBin = await createFakeGitDirectory();
    configureFakeGit(fakeBin, {
      branch: "",
      head: "deadbee",
      status: "# branch.head (detached)",
    });
    vi.resetModules();
    const extension = (await import("../src/index.js")).default;
    const recording = createRecordingPi();
    const { context, setWidget } = createWidgetContext(
      await createTemporaryDirectory("pi-git-status-widget-cwd-"),
    );
    extension(recording.pi as never);

    await recording.handlers.get("session_start")!({}, context);
    expect(latestWidgetText(setWidget)).toContain("detached@deadbee");
    expect(latestWidgetText(setWidget)).toContain("");

    process.env.GIT_WIDGET_MODE = "fail";
    await recording.handlers.get("input")!({}, context);
    expect(setWidget).toHaveBeenLastCalledWith("git-status-widget", undefined);
    await recording.handlers.get("session_shutdown")!({}, context);
  });

  test("does not write widgets without a TUI while still preserving input control flow", async () => {
    const fakeBin = await createFakeGitDirectory();
    configureFakeGit(fakeBin, {});
    vi.resetModules();
    const extension = (await import("../src/index.js")).default;
    const recording = createRecordingPi();
    const { context, setWidget } = createWidgetContext(
      await createTemporaryDirectory("pi-git-status-widget-cwd-"),
      false,
    );
    extension(recording.pi as never);

    await recording.handlers.get("session_start")!({}, context);
    expect(await recording.handlers.get("input")!({}, context)).toEqual({ action: "continue" });
    await recording.handlers.get("tool_execution_end")!({}, context);
    await recording.handlers.get("session_shutdown")!({}, context);

    expect(setWidget).not.toHaveBeenCalled();
  });

  test("maintains one two-second poller across repeated starts and clears it on shutdown", async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const fakeBin = await createFakeGitDirectory();
    configureFakeGit(fakeBin, {});
    vi.resetModules();
    const extension = (await import("../src/index.js")).default;
    const recording = createRecordingPi();
    const { context, setWidget } = createWidgetContext(
      await createTemporaryDirectory("pi-git-status-widget-cwd-"),
    );
    extension(recording.pi as never);

    await recording.handlers.get("session_start")!({}, context);
    await recording.handlers.get("session_start")!({}, context);

    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(setIntervalSpy.mock.calls.map(([, milliseconds]) => milliseconds)).toEqual([
      2_000, 2_000,
    ]);
    const firstInterval = setIntervalSpy.mock.results[0]?.value;
    expect(clearIntervalSpy).toHaveBeenCalledWith(firstInterval);

    await recording.handlers.get("session_shutdown")!({}, context);
    const secondInterval = setIntervalSpy.mock.results[1]?.value;
    expect(clearIntervalSpy).toHaveBeenLastCalledWith(secondInterval);
    expect(setWidget).toHaveBeenLastCalledWith("git-status-widget", undefined);
  });

  test("reads branch, modified, and untracked state from a temporary real Git repository", async () => {
    const repository = await createTemporaryDirectory("pi-git-status-widget-repository-");
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repository });
    await writeFile(join(repository, "tracked.txt"), "before\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repository });
    await writeFile(join(repository, "tracked.txt"), "after\n");
    await writeFile(join(repository, "untracked.txt"), "untracked\n");

    vi.resetModules();
    const extension = (await import("../src/index.js")).default;
    const recording = createRecordingPi();
    const { context, setWidget } = createWidgetContext(repository);
    extension(recording.pi as never);

    await recording.handlers.get("session_start")!({}, context);
    expect(latestWidgetText(setWidget)).toContain("main");
    expect(latestWidgetText(setWidget)).toContain("?1");
    expect(latestWidgetText(setWidget)).toContain("1");
    await recording.handlers.get("session_shutdown")!({}, context);
  });
});
