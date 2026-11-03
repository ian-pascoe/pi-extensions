import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { configuredFor } from "./configured-hosts.js";
import { GITHUB, parseOwnerRepo } from "../src/github-host.js";
import { GITLAB } from "../src/gitlab-host.js";
import type { HostEnvironment, ReadText } from "../src/issue-host.js";
import {
  lookupIssueRepository,
  parseRemoteUrl,
  resolveIssueRepository,
  selectIssueRepository,
  type RunCommand,
} from "../src/issue-repository.js";

describe("parseRemoteUrl", () => {
  test.each([
    ["https://github.com/acme/widgets.git", "github.com", "acme/widgets"],
    ["https://github.com/acme/widgets", "github.com", "acme/widgets"],
    ["https://github.com/acme/widgets/", "github.com", "acme/widgets"],
    ["https://user:token@GitHub.com/acme/widgets.git", "github.com", "acme/widgets"],
    ["http://github.com/acme/widgets.git", "github.com", "acme/widgets"],
    ["git@github.com:acme/widgets.git", "github.com", "acme/widgets"],
    ["github.com:acme/widgets", "github.com", "acme/widgets"],
    ["ssh://git@github.com/acme/widgets.git", "github.com", "acme/widgets"],
    ["ssh://git@ssh.github.com:443/acme/widgets.git", "ssh.github.com", "acme/widgets"],
    ["git@octo.ghe.com:acme/widgets.git", "octo.ghe.com", "acme/widgets"],
    ["git@gh-work:acme/widgets.git", "gh-work", "acme/widgets"],
    ["https://github.com/acme/my.repo_name-2.git", "github.com", "acme/my.repo_name-2"],
    ["git@gitlab.com:group/sub/project.git", "gitlab.com", "group/sub/project"],
    ["https://gitlab.com/group/sub/project", "gitlab.com", "group/sub/project"],
    ["ssh://git@gitlab.example:2222/group/project.git/", "gitlab.example", "group/project"],
    ["https://github.com/acme/widgets/extra", "github.com", "acme/widgets/extra"],
  ])("%s", (url, host, path) => {
    expect(parseRemoteUrl(url)).toEqual({ host, path });
  });

  test.each([
    "",
    "/srv/git/widgets.git",
    "../widgets",
    "file:///srv/git/widgets.git",
    "https://github.com/",
    "https://github.com/.git",
    "https://github.com:8443",
    "https://bad_host.example/acme/widgets.git",
  ])("names no location in %j", (url) => {
    expect(parseRemoteUrl(url)).toBeUndefined();
  });
});

describe("parseOwnerRepo", () => {
  test("accepts exactly owner/repo", () => {
    expect(parseOwnerRepo("acme/my.repo_1")).toEqual({
      owner: "acme",
      repo: "my.repo_1",
    });
    for (const text of ["acme", "a/b/c", "-a/b", "a--b/c", "a/..", "a/.", "a/", "/a", "a/b c"]) {
      expect(parseOwnerRepo(text)).toBeUndefined();
    }
  });
});

describe("selectIssueRepository", () => {
  const config = (...lines: string[]): string => `${lines.join("\n")}\n`;
  const pathOf = (...lines: string[]): string | undefined =>
    selectIssueRepository(config(...lines))?.path;

  test("has no location without remotes", () => {
    expect(selectIssueRepository("")).toBeUndefined();
    expect(selectIssueRepository(config("remote.local.url /srv/git/widgets.git"))).toBeUndefined();
  });

  test("prefers upstream, then github, then origin, then gitlab", () => {
    const lines = [
      "remote.fork.url git@github.com:me/fork.git",
      "remote.gitlab.url git@gitlab.com:me/gitlab.git",
      "remote.origin.url git@github.com:me/origin.git",
      "remote.github.url git@github.com:me/github.git",
      "remote.upstream.url git@github.com:acme/widgets.git",
    ];
    expect(pathOf(...lines)).toBe("acme/widgets");
    expect(pathOf(...lines.slice(0, 4))).toBe("me/github");
    expect(pathOf(...lines.slice(0, 3))).toBe("me/origin");
    expect(pathOf(...lines.slice(0, 2))).toBe("me/gitlab");
    expect(pathOf(...lines.slice(0, 1))).toBe("me/fork");
    expect(selectIssueRepository(config(lines[4] ?? ""))).toEqual({
      host: "github.com",
      path: "acme/widgets",
    });
  });

  test("a gitlab remote comes after origin, unlike glab, which ranks gitlab first", () => {
    expect(
      pathOf(
        "remote.gitlab.url git@gitlab.com:group/gitlab.git",
        "remote.origin.url git@gitlab.com:group/origin.git",
      ),
    ).toBe("group/origin");
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
    ).toEqual({ host: "github.com", path: "acme/mirror" });
  });

  test("skips a preferred remote whose URL does not parse", () => {
    expect(
      pathOf(
        "remote.upstream.url /srv/git/widgets.git",
        "remote.origin.url https://github.com/acme/widgets.git",
      ),
    ).toBe("acme/widgets");
  });

  test.each([
    "https://github.com/acme/widgets/extra",
    "https://github.com/-acme/widgets",
    "https://github.com/acme--x/widgets",
    "https://github.com/acme/..",
    "https://github.com/acme/wid gets",
    "https://github.com/acme",
    "C:\\repos\\widgets",
  ])("a remote at %j does not count, so the next one is chosen, as before", (url) => {
    const mirror = "remote.mirror.url https://github.com/acme/mirror.git";
    expect(selectIssueRepository(config(`remote.upstream.url ${url}`))).toBeUndefined();
    expect(
      pathOf(`remote.upstream.url ${url}`, "remote.origin.url git@github.com:me/origin.git"),
    ).toBe("me/origin");
    expect(pathOf(`remote.origin.url ${url}`, mirror)).toBe("acme/mirror");
    expect(pathOf(`remote.origin.url ${url}`, `remote.origin.gh-resolved base`, mirror)).toBe(
      "acme/mirror",
    );
  });

  test("a non-built-in host counts when some Issue Host's path grammar accepts the path", () => {
    expect(pathOf("remote.origin.url https://git.example/a/b/c.git")).toBe("a/b/c");
    expect(pathOf("remote.origin.url https://git.example/a.git")).toBeUndefined();
    // GitLab's grammar accepts `a/b/c`, so the remote counts, and the lookup leaves it unresolved
    // when the host turns out to be a GitHub Enterprise Server one.
    expect(
      pathOf(
        "remote.upstream.url https://github.corp.example/a/b/c.git",
        "remote.origin.url https://github.com/me/origin.git",
      ),
    ).toBe("a/b/c");
  });

  test("a gh-resolved value no Issue Host accepts means the remote itself", () => {
    const remote = "remote.origin.url git@github.com:me/widgets.git";
    expect(pathOf(remote, "remote.origin.gh-resolved base")).toBe("me/widgets");
    expect(pathOf(remote, "remote.origin.gh-resolved a/b/c")).toBe("me/widgets");
    expect(pathOf(remote, "remote.origin.gh-resolved -x/y")).toBe("me/widgets");
    expect(pathOf(remote, "remote.origin.gh-resolved acme/core.git")).toBe("acme/core");
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
    ).toEqual({ host: "github.com", path: "me/widgets" });
  });

  test("a gh-resolved owner/repo names the repository on that remote's host", () => {
    expect(
      selectIssueRepository(
        config(
          "remote.origin.url git@octo.ghe.com:me/widgets.git",
          "remote.origin.gh-resolved acme/core",
        ),
      ),
    ).toEqual({ host: "octo.ghe.com", path: "acme/core" });
  });

  test("handles remote names with dots and several URLs", () => {
    expect(
      pathOf(
        "remote.team.fork.url https://github.com/acme/first.git",
        "remote.team.fork.url https://github.com/acme/second.git",
      ),
    ).toBe("acme/first");
  });

  test("ignores a gh-resolved marker on a remote without a usable URL", () => {
    expect(
      pathOf(
        "remote.local.url /srv/git/widgets.git",
        "remote.local.gh-resolved base",
        "remote.origin.url git@github.com:acme/widgets.git",
      ),
    ).toBe("acme/widgets");
  });

  describe("glab's marker", () => {
    const lines = [
      "remote.upstream.url git@gitlab.com:group/upstream.git",
      "remote.origin.url git@gitlab.com:me/fork.git",
    ];

    test("glab-resolved-base = base picks that remote, over every name", () => {
      expect(pathOf(...lines, "remote.origin.glab-resolved-base base")).toBe("me/fork");
    });

    test("glab-resolved-base = base:<path> names that path on the remote's host", () => {
      expect(
        selectIssueRepository(
          config(
            "remote.origin.url git@gitlab.example:me/fork.git",
            "remote.origin.glab-resolved-base base:group/sub/project",
          ),
        ),
      ).toEqual({ host: "gitlab.example", path: "group/sub/project" });
    });

    test("a base: with no path means the remote itself", () => {
      expect(pathOf(...lines, "remote.origin.glab-resolved-base base:")).toBe("me/fork");
    });

    test("reads the legacy glab-resolved only when the remote lacks glab-resolved-base", () => {
      expect(pathOf(...lines, "remote.origin.glab-resolved base")).toBe("me/fork");
      expect(pathOf(...lines, "remote.origin.glab-resolved base:legacy/path")).toBe("legacy/path");
      expect(
        pathOf(
          ...lines,
          "remote.origin.glab-resolved base:legacy/path",
          "remote.origin.glab-resolved-base base:current/path",
        ),
      ).toBe("current/path");
      // A head-only base marker still counts as having the new key, so the legacy value is unread.
      expect(
        pathOf(
          ...lines,
          "remote.origin.glab-resolved base",
          "remote.origin.glab-resolved-base head",
        ),
      ).toBe("group/upstream");
    });

    test.each(["head", "head:other/path", "", "nonsense"])("ignores the value %j", (value) => {
      expect(pathOf(...lines, `remote.origin.glab-resolved-base ${value}`.trimEnd())).toBe(
        "group/upstream",
      );
    });

    test("a gh-resolved remote wins over a glab-marked one", () => {
      expect(
        pathOf(
          "remote.origin.url git@gitlab.com:me/glab.git",
          "remote.origin.glab-resolved-base base",
          "remote.mirror.url git@github.com:me/gh.git",
          "remote.mirror.gh-resolved base",
        ),
      ).toBe("me/gh");
    });

    test("ignores a marker on a remote without a usable URL", () => {
      expect(
        pathOf(
          "remote.local.url /srv/git/widgets.git",
          "remote.local.glab-resolved-base base",
          "remote.origin.url git@gitlab.com:group/project.git",
        ),
      ).toBe("group/project");
    });
  });
});

describe("lookupIssueRepository", () => {
  const configuredOf =
    (...hosts: string[]) =>
    async () =>
      configuredFor(GITHUB, ...hosts);
  const github = {
    kind: "found",
    adapter: GITHUB,
    host: "github.com",
  } as const;

  test("tells no remotes from remotes that name no hosted repository", async () => {
    const none = configuredOf();
    expect(await lookupIssueRepository("", none)).toEqual({ kind: "none" });
    expect(await lookupIssueRepository("remote.local.url /srv/git/widgets.git\n", none)).toEqual({
      kind: "unresolved",
    });
    expect(
      await lookupIssueRepository(
        "remote.origin.url https://bitbucket.org/group/sub/widgets.git\nremote.mirror.url file:///srv/x\n",
        none,
      ),
    ).toEqual({ kind: "unresolved" });
    expect(
      await lookupIssueRepository("remote.origin.url git@github.com:acme/widgets.git\n", none),
    ).toEqual({
      ...github,
      repository: { host: "github.com", owner: "acme", repo: "widgets" },
    });
  });

  test("a GitLab remote is found with its namespace path as the owner", async () => {
    expect(
      await lookupIssueRepository(
        "remote.origin.url https://gitlab.com/group/sub/widgets.git\n",
        configuredOf(),
      ),
    ).toEqual({
      kind: "found",
      adapter: GITLAB,
      host: "gitlab.com",
      repository: { host: "gitlab.com", owner: "group/sub", repo: "widgets" },
    });
  });

  test("a remote path its Issue Host does not accept is skipped, as before; with none left it is unresolved", async () => {
    const mirror = "remote.mirror.url https://github.com/acme/mirror.git\n";
    for (const url of [
      "https://gitlab.com/widgets.git",
      "https://github.com/group/sub/widgets.git",
    ]) {
      expect(await lookupIssueRepository(`remote.origin.url ${url}\n`, configuredOf())).toEqual({
        kind: "unresolved",
      });
      expect(
        await lookupIssueRepository(`remote.origin.url ${url}\n${mirror}`, configuredOf()),
      ).toEqual({
        ...github,
        repository: { host: "github.com", owner: "acme", repo: "mirror" },
      });
    }
  });

  test("a non-built-in host whose path only GitLab's grammar accepts is selected, then unresolved", async () => {
    const remotes =
      "remote.upstream.url https://github.corp.example/a/b/c.git\nremote.origin.url https://github.com/me/origin.git\n";
    expect(await lookupIssueRepository(remotes, configuredOf("github.corp.example"))).toEqual({
      kind: "unresolved",
    });
  });

  test("a gh-resolved value only GitLab's grammar accepts, on a non-built-in host, is used, then unresolved", async () => {
    const remotes =
      "remote.origin.url https://github.corp.example/me/widgets.git\nremote.origin.gh-resolved a/b/c\n";
    expect(await lookupIssueRepository(remotes, configuredOf("github.corp.example"))).toEqual({
      kind: "unresolved",
    });
  });

  test("an ssh_host remote is found on the web host that glab maps it to", async () => {
    const configured = async () =>
      new Map([
        [
          GITLAB,
          new Map([
            ["gitlab.corp.example", "gitlab.corp.example"],
            ["ssh.corp.example", "gitlab.corp.example"],
          ]),
        ],
      ]);
    expect(
      await lookupIssueRepository(
        "remote.origin.url git@ssh.corp.example:group/project.git\n",
        configured,
      ),
    ).toEqual({
      kind: "found",
      adapter: GITLAB,
      host: "gitlab.corp.example",
      repository: { host: "ssh.corp.example", owner: "group", repo: "project" },
    });
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
      repository: {
        host: "github.corp.example",
        owner: "acme",
        repo: "widgets",
      },
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

describe("resolveIssueRepository", () => {
  const environment: HostEnvironment = {
    env: {},
    platform: "linux",
    homedir: "/home/me",
  };
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
    const result = spawnSync(command, args, {
      cwd: options?.cwd,
      encoding: "utf8",
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.status ?? 1,
      killed: false,
      truncated: false,
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
      repository: {
        host: "github.corp.example",
        owner: "acme",
        repo: "widgets",
      },
    });
    // Each resolution reads gh's file and glab's.
    expect(paths).toEqual([
      "/home/me/.config/gh/hosts.yml",
      "/home/me/.config/glab-cli/config.yml",
      "/home/me/.config/gh/hosts.yml",
      "/home/me/.config/glab-cli/config.yml",
    ]);
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

  test("honours real glab markers, the legacy one only without the newer one", async () => {
    const remotes = [
      ["remote", "add", "upstream", "https://gitlab.com/group/upstream.git"],
      ["remote", "add", "origin", "git@gitlab.com:me/fork.git"],
    ];
    const base = await repository(...remotes, [
      "config",
      "remote.origin.glab-resolved-base",
      "base",
    ]);
    expect(await resolveIssueRepository(gitRunner(), base, hosts)).toMatchObject({
      repository: { host: "gitlab.com", owner: "me", repo: "fork" },
    });
    const legacy = await repository(...remotes, [
      "config",
      "remote.origin.glab-resolved",
      "base:group/sub/project",
    ]);
    expect(await resolveIssueRepository(gitRunner(), legacy, hosts)).toMatchObject({
      repository: { host: "gitlab.com", owner: "group/sub", repo: "project" },
    });
    const head = await repository(...remotes, [
      "config",
      "remote.origin.glab-resolved-base",
      "head",
    ]);
    expect(await resolveIssueRepository(gitRunner(), head, hosts)).toMatchObject({
      repository: { owner: "group", repo: "upstream" },
    });
  });

  test("has no repository outside Git, without remotes, or without git", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pi-issues-outside-"));
    directories.push(outside);
    expect(await resolveIssueRepository(gitRunner(), outside, hosts)).toEqual({
      kind: "none",
    });
    expect(await resolveIssueRepository(gitRunner(), await repository(), hosts)).toEqual({
      kind: "none",
    });
    const missing: RunCommand = async () => {
      throw new Error("spawn git ENOENT");
    };
    expect(await resolveIssueRepository(missing, outside, hosts)).toEqual({
      kind: "none",
    });
  });

  test.each([
    ["a nested Bitbucket path", "https://bitbucket.org/group/sub/widgets.git"],
    ["a GitLab path with one segment", "https://gitlab.com/widgets.git"],
    ["a local path", "/srv/git/widgets.git"],
    ["a file URL", "file:///srv/git/widgets.git"],
  ])("a remote at %s leaves the Issue Repository unresolved, not absent", async (_name, url) => {
    const cwd = await repository(["remote", "add", "origin", url]);
    expect(await resolveIssueRepository(gitRunner(), cwd, hosts)).toEqual({
      kind: "unresolved",
    });
  });

  test("asks git for exactly the remote URLs and gh markers, in the session directory", async () => {
    const calls: unknown[] = [];
    await resolveIssueRepository(
      async (command, args, options) => {
        calls.push([command, args, options?.cwd]);
        return { stdout: "", stderr: "", code: 1, killed: false, truncated: false };
      },
      "/work/project",
      hosts,
    );
    expect(calls).toEqual([
      [
        "git",
        [
          "config",
          "--get-regexp",
          "^remote\\..*\\.(url|gh-resolved|glab-resolved-base|glab-resolved)$",
        ],
        "/work/project",
      ],
    ]);
  });
});
