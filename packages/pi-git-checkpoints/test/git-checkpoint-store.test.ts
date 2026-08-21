import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
  cleanupGitCheckpointStores,
  initializeGitCheckpointStore,
  type GitCheckpointStore,
} from "../src/git-checkpoint-store.js";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
  const result = await execute("git", arguments_, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(): Promise<{ agentDirectory: string; repository: string }> {
  const repository = await temporaryDirectory("pi-git-checkpoints-repository-");
  const agentDirectory = await temporaryDirectory("pi-git-checkpoints-agent-");
  await git(repository, "init", "--quiet");
  await git(repository, "config", "user.email", "test@example.com");
  await git(repository, "config", "user.name", "Git Checkpoints Test");
  await writeFile(join(repository, "tracked.txt"), "one\n");
  await git(repository, "add", "tracked.txt");
  await git(repository, "commit", "--quiet", "-m", "initial");
  return { agentDirectory, repository };
}

async function initializeRepositoryStore(
  sessionId = "session-one",
): Promise<{ repository: string; store: GitCheckpointStore }> {
  const { agentDirectory, repository } = await createRepository();
  return {
    repository,
    store: await initializeGitCheckpointStore({
      agentDirectory,
      sessionId,
      startingDirectory: repository,
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Worktree Checkpoint capture", () => {
  test("captures stable repository and standalone trees without changing source Git metadata", async () => {
    const { agentDirectory, repository } = await createRepository();
    const indexPath = await git(repository, "rev-parse", "--git-path", "index");
    const absoluteIndexPath = resolve(repository, indexPath);
    const beforeIndex = await readFile(absoluteIndexPath);
    const beforeHead = await git(repository, "rev-parse", "HEAD");
    const beforeBranch = await git(repository, "branch", "--show-current");

    const repositoryStore = await initializeGitCheckpointStore({
      agentDirectory,
      sessionId: "repository-session",
      startingDirectory: repository,
    });
    const first = await repositoryStore.capture();
    const second = await repositoryStore.capture();

    expect(repositoryStore.mode).toBe("repository");
    expect(second.treeId).toBe(first.treeId);
    expect(first.sourceHead).toEqual({ commit: beforeHead, kind: "head" });
    expect(await readFile(absoluteIndexPath)).toEqual(beforeIndex);
    expect(await git(repository, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(await git(repository, "branch", "--show-current")).toBe(beforeBranch);

    const standalone = await temporaryDirectory("pi-git-checkpoints-standalone-");
    await writeFile(join(standalone, "plain.txt"), "plain\n");
    const standaloneStore = await initializeGitCheckpointStore({
      agentDirectory,
      sessionId: "standalone-session",
      startingDirectory: standalone,
    });
    const standaloneFirst = await standaloneStore.capture();
    const standaloneSecond = await standaloneStore.capture();

    expect(standaloneStore.mode).toBe("standalone");
    expect(standaloneSecond.treeId).toBe(standaloneFirst.treeId);
    expect(standaloneFirst.sourceHead).toEqual({ kind: "standalone" });
    await expect(lstat(join(standalone, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("captures eligible changes with exact modes and deterministic skipped paths", async () => {
    const { repository, store } = await initializeRepositoryStore();
    await writeFile(join(repository, ".gitignore"), "ignored.txt\n");
    await writeFile(join(repository, ".git", "info", "exclude"), "excluded.txt\n");
    await writeFile(join(repository, "ignored.txt"), "ignored\n");
    await writeFile(join(repository, "excluded.txt"), "excluded\n");
    await writeFile(join(repository, "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1, 1));
    await writeFile(join(repository, "binary.bin"), Buffer.from([0, 255, 1, 254]));
    await writeFile(join(repository, "-leading [*]: ü.txt"), "special\n");
    await writeFile(join(repository, "executable.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(repository, "executable.sh"), 0o755);
    await symlink("tracked.txt", join(repository, "linked.txt"));
    const nested = join(repository, "nested");
    await mkdir(nested);
    await git(nested, "init", "--quiet");
    await writeFile(join(nested, "nested.txt"), "nested\n");

    const before = await store.capture();
    expect(before.skippedPaths).toEqual(["excluded.txt", "ignored.txt", "large.bin", "nested"]);

    await writeFile(join(repository, "tracked.txt"), "two\n");
    await rm(join(repository, "binary.bin"));
    await writeFile(join(repository, "added.txt"), "added\n");
    const after = await store.capture();

    expect(await store.compareTrees(before.treeId, after.treeId)).toEqual([
      { path: "added.txt", status: "A" },
      { path: "binary.bin", status: "D" },
      { path: "tracked.txt", status: "M" },
    ]);
    expect(after.skippedPaths).toEqual(["excluded.txt", "ignored.txt", "large.bin", "nested"]);

    const modeTree = await git(
      store.storeDirectory,
      `--git-dir=${join(store.storeDirectory, "git")}`,
      "ls-tree",
      after.treeId,
      "executable.sh",
    );
    expect(modeTree.startsWith("100755 blob ")).toBe(true);
    expect(await readlink(join(repository, "linked.txt"))).toBe("tracked.txt");
  });
});

describe("selective Restore and one-level undo", () => {
  test("leaves paths untouched after they become ignored or nested repositories", async () => {
    const { repository, store } = await initializeRepositoryStore();
    await mkdir(join(repository, "nested"));
    await writeFile(join(repository, "nested", "inside.txt"), "checkpoint nested\n");
    await writeFile(join(repository, "ignored-later.txt"), "checkpoint ignored\n");
    const target = await store.capture();
    await git(join(repository, "nested"), "init", "--quiet");
    await writeFile(join(repository, ".gitignore"), "ignored-later.txt\n");
    await writeFile(join(repository, "nested", "inside.txt"), "live nested\n");
    await writeFile(join(repository, "ignored-later.txt"), "live ignored\n");
    const safety = await store.capture();

    expect(
      await store.restore({
        paths: ["nested/inside.txt", "ignored-later.txt"],
        safetyTreeId: safety.treeId,
        targetTreeId: target.treeId,
      }),
    ).toEqual({
      restoredPaths: [],
    });
    expect(await readFile(join(repository, "nested", "inside.txt"), "utf8")).toBe("live nested\n");
    expect(await readFile(join(repository, "ignored-later.txt"), "utf8")).toBe("live ignored\n");
  });

  test("refuses to replace a directory that may contain unrelated paths", async () => {
    const { repository, store } = await initializeRepositoryStore();
    await writeFile(join(repository, "blocked"), "checkpoint file\n");
    const target = await store.capture();
    await rm(join(repository, "blocked"));
    await mkdir(join(repository, "blocked"));
    await writeFile(join(repository, "blocked", "unrelated.txt"), "keep me\n");
    const safety = await store.capture();

    await expect(
      store.restore({
        paths: ["blocked"],
        safetyTreeId: safety.treeId,
        targetTreeId: target.treeId,
      }),
    ).rejects.toThrow("destination is a directory");
    expect(await readFile(join(repository, "blocked", "unrelated.txt"), "utf8")).toBe("keep me\n");
  });

  test("restores only approved paths and undo returns to the Safety Checkpoint", async () => {
    const { repository, store } = await initializeRepositoryStore();
    const target = await store.capture();
    await writeFile(join(repository, "tracked.txt"), "target changed\n");
    await writeFile(join(repository, "added.txt"), "target added\n");
    const changed = await store.capture();
    await writeFile(join(repository, "tracked.txt"), "live safety\n");
    await writeFile(join(repository, "added.txt"), "live added\n");
    await writeFile(join(repository, "unrelated.txt"), "keep me\n");
    const safety = await store.capture();

    const restored = await store.restore({
      paths: ["tracked.txt", "added.txt"],
      safetyTreeId: safety.treeId,
      targetTreeId: target.treeId,
    });

    expect(restored).toEqual({ restoredPaths: ["added.txt", "tracked.txt"] });
    expect(await readFile(join(repository, "tracked.txt"), "utf8")).toBe("one\n");
    await expect(lstat(join(repository, "added.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(repository, "unrelated.txt"), "utf8")).toBe("keep me\n");
    expect(await store.inspectUndo()).toMatchObject({ divergedPaths: [], kind: "ready" });

    expect(await store.undo({ allowDiverged: false })).toEqual({
      kind: "undone",
      restoredPaths: ["added.txt", "tracked.txt"],
    });
    expect(await readFile(join(repository, "tracked.txt"), "utf8")).toBe("live safety\n");
    expect(await readFile(join(repository, "added.txt"), "utf8")).toBe("live added\n");
    expect(await store.inspectUndo()).toEqual({ kind: "unavailable" });
    expect(changed.treeId).not.toBe(target.treeId);
  });

  test("reports divergent undo and rolls partial Restore writes back", async () => {
    let failTrackedWrite = false;
    const { agentDirectory, repository } = await createRepository();
    const store = await initializeGitCheckpointStore({
      agentDirectory,
      effects: {
        beforeWritePath(operation, checkpointPath) {
          if (operation === "restore" && checkpointPath === "tracked.txt" && failTrackedWrite) {
            throw new Error("injected tracked write failure");
          }
        },
      },
      sessionId: "rollback-session",
      startingDirectory: repository,
    });
    await writeFile(join(repository, "a.txt"), "target a\n");
    const target = await store.capture();
    await writeFile(join(repository, "a.txt"), "safety a\n");
    await writeFile(join(repository, "tracked.txt"), "safety tracked\n");
    const safety = await store.capture();
    failTrackedWrite = true;

    await expect(
      store.restore({
        paths: ["a.txt", "tracked.txt"],
        safetyTreeId: safety.treeId,
        targetTreeId: target.treeId,
      }),
    ).rejects.toMatchObject({ operation: "restore", unrecoveredPaths: [] });
    expect(await readFile(join(repository, "a.txt"), "utf8")).toBe("safety a\n");
    expect(await readFile(join(repository, "tracked.txt"), "utf8")).toBe("safety tracked\n");

    failTrackedWrite = false;
    await store.restore({
      paths: ["a.txt"],
      safetyTreeId: safety.treeId,
      targetTreeId: target.treeId,
    });
    await writeFile(join(repository, "a.txt"), "external\n");
    expect(await store.undo({ allowDiverged: false })).toEqual({
      kind: "diverged",
      paths: ["a.txt"],
    });
  });

  test("rolls an aborted partial Restore back without reusing the aborted signal", async () => {
    const controller = new AbortController();
    const { agentDirectory, repository } = await createRepository();
    const store = await initializeGitCheckpointStore({
      agentDirectory,
      effects: {
        beforeWritePath(operation, checkpointPath) {
          if (operation === "restore" && checkpointPath === "a.txt") controller.abort();
        },
      },
      sessionId: "abort-rollback-session",
      startingDirectory: repository,
    });
    await writeFile(join(repository, "a.txt"), "target a\n");
    await writeFile(join(repository, "b.txt"), "target b\n");
    const target = await store.capture();
    await writeFile(join(repository, "a.txt"), "safety a\n");
    await writeFile(join(repository, "b.txt"), "safety b\n");
    const safety = await store.capture();

    await expect(
      store.restore({
        paths: ["a.txt", "b.txt"],
        safetyTreeId: safety.treeId,
        signal: controller.signal,
        targetTreeId: target.treeId,
      }),
    ).rejects.toMatchObject({ operation: "restore", unrecoveredPaths: [] });
    expect(await readFile(join(repository, "a.txt"), "utf8")).toBe("safety a\n");
    expect(await readFile(join(repository, "b.txt"), "utf8")).toBe("safety b\n");
  });
});

describe("checkpoint scope and retention safety", () => {
  test("scopes captures to the starting directory and rejects a symlink-ancestor escape", async () => {
    const { agentDirectory, repository } = await createRepository();
    const scope = join(repository, "scope");
    const outside = await temporaryDirectory("pi-git-checkpoints-outside-");
    await mkdir(join(scope, "directory"), { recursive: true });
    await writeFile(join(scope, "directory", "inside.txt"), "target\n");
    await writeFile(join(repository, "outside-scope.txt"), "before\n");
    const store = await initializeGitCheckpointStore({
      agentDirectory,
      sessionId: "scoped-session",
      startingDirectory: scope,
    });
    const target = await store.capture();
    await writeFile(join(scope, "directory", "inside.txt"), "live\n");
    await writeFile(join(repository, "outside-scope.txt"), "after\n");
    const safety = await store.capture();
    await rm(join(scope, "directory"), { recursive: true });
    await symlink(outside, join(scope, "directory"));

    await expect(
      store.restore({
        paths: ["scope/directory/inside.txt"],
        safetyTreeId: safety.treeId,
        targetTreeId: target.treeId,
      }),
    ).rejects.toThrow("destination ancestor is a symlink");
    await expect(
      store.restore({
        paths: ["tracked.txt"],
        safetyTreeId: safety.treeId,
        targetTreeId: target.treeId,
      }),
    ).rejects.toThrow("outside the starting-directory scope");
    expect(await readFile(join(repository, "outside-scope.txt"), "utf8")).toBe("after\n");
    await expect(lstat(join(outside, "inside.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps successfully captured standalone paths after growth and expires only inactive stores", async () => {
    const standalone = await temporaryDirectory("pi-git-checkpoints-standalone-limit-");
    const agentDirectory = await temporaryDirectory("pi-git-checkpoints-agent-");
    await writeFile(join(standalone, ".gitignore"), "ignored.txt\n");
    await writeFile(join(standalone, "ignored.txt"), "ignored\n");
    await writeFile(join(standalone, "captured.bin"), "small\n");
    await writeFile(join(standalone, "skipped.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
    const store = await initializeGitCheckpointStore({
      agentDirectory,
      sessionId: "standalone-limit",
      startingDirectory: standalone,
    });
    const first = await store.capture();
    expect(first.skippedPaths).toEqual(["ignored.txt", "skipped.bin"]);
    await writeFile(join(standalone, "captured.bin"), Buffer.alloc(2 * 1024 * 1024 + 1, 2));
    const second = await store.capture();
    expect(second.skippedPaths).toEqual(["ignored.txt", "skipped.bin"]);
    expect(await store.compareTrees(first.treeId, second.treeId)).toEqual([
      { path: "captured.bin", status: "M" },
    ]);

    await store.shutdown();
    const old = new Date("2020-01-01T00:00:00.000Z");
    await utimes(join(store.storeDirectory, "activity"), old, old);
    expect(
      await cleanupGitCheckpointStores({
        agentDirectory,
        currentStoreDirectory: join(agentDirectory, "not-current"),
        now: new Date("2020-01-10T00:00:00.000Z"),
        retentionDays: 7,
      }),
    ).toEqual([]);
    await expect(lstat(store.storeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(standalone, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
