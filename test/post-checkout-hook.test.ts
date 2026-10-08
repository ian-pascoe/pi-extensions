/**
 * Post-checkout hook test: the reference-repo sync runs only on branch checkouts.
 *
 * Git passes three arguments to `post-checkout`: previous HEAD, new HEAD, and a flag. The flag is
 * `1` for branch checkouts (including `git worktree add`) and `0` for file checkouts such as
 * `git checkout -- <file>`. The hook must sync only on `1`, so routine scratch reverts stay quiet.
 *
 * The test runs real `git` commands in a temporary repository. Its `scripts/sync-reference-repos.sh`
 * is a stub that appends to a log, and the repository's `.husky/post-checkout` is copied from this
 * checkout. The copied hook runs through `sh -e`, the same way Husky's shim runs it.
 */
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const realHook = fileURLToPath(new URL("../.husky/post-checkout", import.meta.url));
const SYNC_LOG = "sync.log";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function syncCount(dir: string): Promise<number> {
  try {
    return (await readFile(join(dir, SYNC_LOG), "utf8")).split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

describe("post-checkout hook", () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "post-checkout-hook-"));
    repo = join(root, "repo");
    await mkdir(join(repo, ".husky"), { recursive: true });
    await mkdir(join(repo, "scripts"), { recursive: true });
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });

    git(root, "init", "-q", repo);
    await copyFile(realHook, join(repo, ".husky", "post-checkout"));
    const stub = join(repo, "scripts", "sync-reference-repos.sh");
    await writeFile(stub, `#!/bin/sh\necho synced >> ${SYNC_LOG}\n`);
    await chmod(stub, 0o755);
    await writeFile(join(repo, "README.md"), "# readme\n");

    // Git runs .git/hooks/post-checkout directly, so this wrapper mirrors Husky's shim.
    const hook = join(repo, ".git", "hooks", "post-checkout");
    await writeFile(hook, '#!/bin/sh\nsh -e .husky/post-checkout "$@"\n');
    await chmod(hook, 0o755);

    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "branch", "other");
    // Ignore the sync log so it never shows up as a change to the working tree.
    await writeFile(join(repo, ".git", "info", "exclude"), `${SYNC_LOG}\n`, { flag: "a" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not sync on a file checkout (git checkout -- <file>)", async () => {
    await writeFile(join(repo, "README.md"), "scratch edit\n");

    git(repo, "checkout", "--", "README.md");

    expect(await readFile(join(repo, "README.md"), "utf8")).toBe("# readme\n");
    expect(await syncCount(repo)).toBe(0);
  });

  it("syncs on a branch checkout (git checkout <branch>)", async () => {
    git(repo, "checkout", "-q", "other");

    expect(await syncCount(repo)).toBe(1);
  });

  it("syncs in a new linked worktree (git worktree add)", async () => {
    const worktree = join(root, "wt");

    git(repo, "worktree", "add", "-q", worktree, "other");

    expect(await syncCount(worktree)).toBe(1);
  });
});
