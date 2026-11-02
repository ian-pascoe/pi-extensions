import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
  lookupIssueRepository,
  parseOwnerRepo,
  parseRemoteUrl,
  resolveIssueRepository,
  selectIssueRepository,
  type RunCommand,
} from "../src/issue-repository.js";

describe("parseRemoteUrl", () => {
  test.each([
    ["https://github.com/acme/widgets.git", "github.com", "acme", "widgets"],
    ["https://github.com/acme/widgets", "github.com", "acme", "widgets"],
    ["https://github.com/acme/widgets/", "github.com", "acme", "widgets"],
    ["https://user:token@GitHub.com/acme/widgets.git", "github.com", "acme", "widgets"],
    ["http://github.com/acme/widgets.git", "github.com", "acme", "widgets"],
    ["git@github.com:acme/widgets.git", "github.com", "acme", "widgets"],
    ["github.com:acme/widgets", "github.com", "acme", "widgets"],
    ["ssh://git@github.com/acme/widgets.git", "github.com", "acme", "widgets"],
    ["ssh://git@ssh.github.com:443/acme/widgets.git", "ssh.github.com", "acme", "widgets"],
    ["git@octo.ghe.com:acme/widgets.git", "octo.ghe.com", "acme", "widgets"],
    ["git@gh-work:acme/widgets.git", "gh-work", "acme", "widgets"],
    ["https://github.com/acme/my.repo_name-2.git", "github.com", "acme", "my.repo_name-2"],
  ])("%s", (url, host, owner, repo) => {
    expect(parseRemoteUrl(url)).toEqual({ host, owner, repo });
  });

  test.each([
    "",
    "/srv/git/widgets.git",
    "../widgets",
    "file:///srv/git/widgets.git",
    "https://github.com/acme",
    "https://github.com/acme/widgets/extra",
    "https://gitlab.com/group/sub/widgets.git",
    "https://github.com/-acme/widgets",
    "https://github.com/acme--x/widgets",
    "https://github.com/acme/..",
    "https://github.com/acme/wid gets",
    "C:\\repos\\widgets",
  ])("rejects %j", (url) => {
    expect(parseRemoteUrl(url)).toBeUndefined();
  });
});

describe("selectIssueRepository", () => {
  const config = (...lines: string[]): string => `${lines.join("\n")}\n`;

  test("has no repository without remotes", () => {
    expect(selectIssueRepository("")).toBeUndefined();
    expect(selectIssueRepository(config("remote.local.url /srv/git/widgets.git"))).toBeUndefined();
  });

  test("prefers upstream, then github, then origin", () => {
    const lines = [
      "remote.fork.url git@github.com:me/widgets.git",
      "remote.origin.url git@github.com:me/origin.git",
      "remote.github.url git@github.com:me/github.git",
      "remote.upstream.url git@github.com:acme/widgets.git",
    ];
    expect(selectIssueRepository(config(...lines))?.repo).toBe("widgets");
    expect(selectIssueRepository(config(...lines.slice(0, 3)))?.repo).toBe("github");
    expect(selectIssueRepository(config(...lines.slice(0, 2)))?.repo).toBe("origin");
    expect(selectIssueRepository(config(...lines.slice(0, 1)))?.repo).toBe("widgets");
    expect(selectIssueRepository(config(lines[3] ?? ""))).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "widgets",
    });
  });

  test("falls back to the first remote whose URL parses", () => {
    expect(
      selectIssueRepository(
        config(
          "remote.local.url /srv/git/widgets.git",
          "remote.mirror.url https://github.com/acme/mirror.git",
          "remote.other.url https://github.com/acme/other.git",
        ),
      ),
    ).toEqual({ host: "github.com", owner: "acme", repo: "mirror" });
  });

  test("skips a preferred remote whose URL does not parse", () => {
    expect(
      selectIssueRepository(
        config(
          "remote.upstream.url /srv/git/widgets.git",
          "remote.origin.url https://github.com/acme/widgets.git",
        ),
      )?.repo,
    ).toBe("widgets");
  });

  test("uses the remote gh resolved, over every name", () => {
    expect(
      selectIssueRepository(
        config(
          "remote.upstream.url git@github.com:acme/widgets.git",
          "remote.origin.url git@github.com:me/widgets.git",
          "remote.origin.gh-resolved base",
        ),
      ),
    ).toEqual({ host: "github.com", owner: "me", repo: "widgets" });
  });

  test("a gh-resolved owner/repo names the repository on that remote's host", () => {
    expect(
      selectIssueRepository(
        config(
          "remote.origin.url git@octo.ghe.com:me/widgets.git",
          "remote.origin.gh-resolved acme/core",
        ),
      ),
    ).toEqual({ host: "octo.ghe.com", owner: "acme", repo: "core" });
  });

  test("handles remote names with dots and several URLs", () => {
    expect(
      selectIssueRepository(
        config(
          "remote.team.fork.url https://github.com/acme/first.git",
          "remote.team.fork.url https://github.com/acme/second.git",
        ),
      )?.repo,
    ).toBe("first");
  });

  test("ignores a gh-resolved marker on a remote without a usable URL", () => {
    expect(
      selectIssueRepository(
        config(
          "remote.local.url /srv/git/widgets.git",
          "remote.local.gh-resolved base",
          "remote.origin.url git@github.com:acme/widgets.git",
        ),
      )?.repo,
    ).toBe("widgets");
  });
});

describe("lookupIssueRepository", () => {
  test("tells no remotes from remotes that name no hosted repository", () => {
    expect(lookupIssueRepository("")).toEqual({ kind: "none" });
    expect(lookupIssueRepository("remote.local.url /srv/git/widgets.git\n")).toEqual({
      kind: "unresolved",
    });
    expect(
      lookupIssueRepository(
        "remote.origin.url https://gitlab.com/group/sub/widgets.git\nremote.mirror.url file:///srv/x\n",
      ),
    ).toEqual({ kind: "unresolved" });
    expect(lookupIssueRepository("remote.origin.url git@github.com:acme/widgets.git\n")).toEqual({
      kind: "found",
      repository: { host: "github.com", owner: "acme", repo: "widgets" },
    });
  });
});

describe("parseOwnerRepo", () => {
  test("accepts exactly owner/repo", () => {
    expect(parseOwnerRepo("acme/my.repo_1")).toEqual({ owner: "acme", repo: "my.repo_1" });
    for (const text of ["acme", "a/b/c", "-a/b", "a--b/c", "a/..", "a/.", "a/", "/a", "a/b c"]) {
      expect(parseOwnerRepo(text)).toBeUndefined();
    }
  });
});

describe("resolveIssueRepository", () => {
  const directories: string[] = [];
  const run = promisify(execFile);
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  // The real `git config --get-regexp`, so the parser meets git's actual output format.
  const gitRunner = (): RunCommand => async (command, args, options) => {
    const result = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8" });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.status ?? 1,
      killed: false,
    };
  };

  async function repository(...git: string[][]): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "pi-issues-repository-"));
    directories.push(directory);
    await run("git", ["init", "-q"], { cwd: directory });
    for (const args of git) await run("git", args, { cwd: directory });
    return directory;
  }

  test("reads the remotes of a real repository", async () => {
    const cwd = await repository(
      ["remote", "add", "origin", "git@github.com:me/widgets.git"],
      ["remote", "add", "upstream", "https://github.com/acme/widgets.git"],
    );
    expect(await resolveIssueRepository(gitRunner(), cwd)).toEqual({
      kind: "found",
      repository: { host: "github.com", owner: "acme", repo: "widgets" },
    });
  });

  test("honours a real gh-resolved marker", async () => {
    const cwd = await repository(
      ["remote", "add", "origin", "git@github.com:me/widgets.git"],
      ["remote", "add", "upstream", "https://github.com/acme/widgets.git"],
      ["config", "remote.origin.gh-resolved", "base"],
    );
    expect(await resolveIssueRepository(gitRunner(), cwd)).toMatchObject({
      repository: { owner: "me" },
    });
  });

  test("has no repository outside Git, without remotes, or without git", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pi-issues-outside-"));
    directories.push(outside);
    expect(await resolveIssueRepository(gitRunner(), outside)).toEqual({ kind: "none" });
    expect(await resolveIssueRepository(gitRunner(), await repository())).toEqual({ kind: "none" });
    const missing: RunCommand = async () => {
      throw new Error("spawn git ENOENT");
    };
    expect(await resolveIssueRepository(missing, outside)).toEqual({ kind: "none" });
  });

  test.each([
    ["a nested GitLab group", "https://gitlab.com/group/sub/widgets.git"],
    ["a local path", "/srv/git/widgets.git"],
    ["a file URL", "file:///srv/git/widgets.git"],
  ])("a remote at %s leaves the Issue Repository unresolved, not absent", async (_name, url) => {
    const cwd = await repository(["remote", "add", "origin", url]);
    expect(await resolveIssueRepository(gitRunner(), cwd)).toEqual({ kind: "unresolved" });
  });

  test("asks git for exactly the remote URLs and gh markers, in the session directory", async () => {
    const calls: unknown[] = [];
    await resolveIssueRepository(async (command, args, options) => {
      calls.push([command, args, options?.cwd]);
      return { stdout: "", stderr: "", code: 1, killed: false };
    }, "/work/project");
    expect(calls).toEqual([
      ["git", ["config", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"], "/work/project"],
    ]);
  });
});
