import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { GITHUB } from "../src/github-host.js";
import type { HostEnvironment, ReadText } from "../src/issue-host.js";
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
  const configuredOf =
    (...hosts: string[]) =>
    async () =>
      new Map([[GITHUB, new Set(hosts)]]);
  const github = { kind: "found", adapter: GITHUB, host: "github.com" } as const;

  test("tells no remotes from remotes that name no hosted repository", async () => {
    const none = configuredOf();
    expect(await lookupIssueRepository("", none)).toEqual({ kind: "none" });
    expect(await lookupIssueRepository("remote.local.url /srv/git/widgets.git\n", none)).toEqual({
      kind: "unresolved",
    });
    expect(
      await lookupIssueRepository(
        "remote.origin.url https://gitlab.com/group/sub/widgets.git\nremote.mirror.url file:///srv/x\n",
        none,
      ),
    ).toEqual({ kind: "unresolved" });
    expect(
      await lookupIssueRepository("remote.origin.url git@github.com:acme/widgets.git\n", none),
    ).toEqual({ ...github, repository: { host: "github.com", owner: "acme", repo: "widgets" } });
  });

  test("a found repository carries the serving adapter and its canonical host", async () => {
    expect(
      await lookupIssueRepository(
        "remote.origin.url ssh://git@ssh.github.com:443/acme/widgets.git\n",
        configuredOf(),
      ),
    ).toEqual({
      ...github,
      repository: { host: "ssh.github.com", owner: "acme", repo: "widgets" },
    });
  });

  test("a remote on a configured host is found; on any other host it is unresolved", async () => {
    const remote = "remote.origin.url https://github.corp.example/acme/widgets.git\n";
    expect(await lookupIssueRepository(remote, configuredOf("github.corp.example"))).toEqual({
      kind: "found",
      adapter: GITHUB,
      host: "github.corp.example",
      repository: { host: "github.corp.example", owner: "acme", repo: "widgets" },
    });
    expect(await lookupIssueRepository(remote, configuredOf("other.example"))).toEqual({
      kind: "unresolved",
    });
  });

  test.each([
    ["an SSH host alias", "origin=git@github-work:acme/widgets.git"],
    ["Bitbucket", "origin=https://bitbucket.org/acme/widgets.git"],
  ])(
    "selection is unchanged: %s on the selected remote is unresolved, and no other remote is chosen",
    async (_name, selected) => {
      const [name, url] = selected.split("=");
      const lookup = await lookupIssueRepository(
        `remote.${name}.url ${url}\nremote.mirror.url https://github.com/acme/mirror.git\n`,
        configuredOf(),
      );
      expect(lookup).toEqual({ kind: "unresolved" });
    },
  );

  test("a gh-resolved remote on an unrecognised host is unresolved, though origin is built in", async () => {
    expect(
      await lookupIssueRepository(
        "remote.fork.url https://github.corp.example/acme/widgets.git\nremote.fork.gh-resolved base\nremote.origin.url https://github.com/me/widgets.git\n",
        configuredOf(),
      ),
    ).toEqual({ kind: "unresolved" });
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
  const environment: HostEnvironment = { env: {}, platform: "linux", homedir: "/home/me" };
  const unreadable: ReadText = async () => undefined;
  const hosts = { environment, readText: unreadable };
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
    expect(await resolveIssueRepository(gitRunner(), cwd, hosts)).toEqual({
      kind: "found",
      adapter: GITHUB,
      host: "github.com",
      repository: { host: "github.com", owner: "acme", repo: "widgets" },
    });
  });

  test("reads no configuration file when the remote's host is built in", async () => {
    const cwd = await repository(["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    const paths: string[] = [];
    const readText: ReadText = async (path) => {
      paths.push(path);
      return undefined;
    };
    await resolveIssueRepository(gitRunner(), cwd, { environment, readText });
    expect(paths).toEqual([]);
  });

  test("recognises a remote on a host in hosts.yml, re-reading the file on every resolution", async () => {
    const cwd = await repository([
      "remote",
      "add",
      "origin",
      "https://github.corp.example/acme/widgets.git",
    ]);
    let file: string | undefined;
    const paths: string[] = [];
    const readText: ReadText = async (path) => {
      paths.push(path);
      return file;
    };
    const resolve = () => resolveIssueRepository(gitRunner(), cwd, { environment, readText });
    expect(await resolve()).toEqual({ kind: "unresolved" });
    file = "github.corp.example:\n  user: me\n";
    expect(await resolve()).toMatchObject({
      kind: "found",
      host: "github.corp.example",
      repository: { host: "github.corp.example", owner: "acme", repo: "widgets" },
    });
    expect(paths).toEqual(["/home/me/.config/gh/hosts.yml", "/home/me/.config/gh/hosts.yml"]);
  });

  test("honours a real gh-resolved marker", async () => {
    const cwd = await repository(
      ["remote", "add", "origin", "git@github.com:me/widgets.git"],
      ["remote", "add", "upstream", "https://github.com/acme/widgets.git"],
      ["config", "remote.origin.gh-resolved", "base"],
    );
    expect(await resolveIssueRepository(gitRunner(), cwd, hosts)).toMatchObject({
      repository: { owner: "me" },
    });
  });

  test("has no repository outside Git, without remotes, or without git", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pi-issues-outside-"));
    directories.push(outside);
    expect(await resolveIssueRepository(gitRunner(), outside, hosts)).toEqual({ kind: "none" });
    expect(await resolveIssueRepository(gitRunner(), await repository(), hosts)).toEqual({
      kind: "none",
    });
    const missing: RunCommand = async () => {
      throw new Error("spawn git ENOENT");
    };
    expect(await resolveIssueRepository(missing, outside, hosts)).toEqual({ kind: "none" });
  });

  test.each([
    ["a nested GitLab group", "https://gitlab.com/group/sub/widgets.git"],
    ["a local path", "/srv/git/widgets.git"],
    ["a file URL", "file:///srv/git/widgets.git"],
  ])("a remote at %s leaves the Issue Repository unresolved, not absent", async (_name, url) => {
    const cwd = await repository(["remote", "add", "origin", url]);
    expect(await resolveIssueRepository(gitRunner(), cwd, hosts)).toEqual({ kind: "unresolved" });
  });

  test("asks git for exactly the remote URLs and gh markers, in the session directory", async () => {
    const calls: unknown[] = [];
    await resolveIssueRepository(
      async (command, args, options) => {
        calls.push([command, args, options?.cwd]);
        return { stdout: "", stderr: "", code: 1, killed: false };
      },
      "/work/project",
      hosts,
    );
    expect(calls).toEqual([
      ["git", ["config", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"], "/work/project"],
    ]);
  });
});
