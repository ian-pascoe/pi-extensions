import { describe, expect, test } from "vitest";
import { GITHUB } from "../src/github-host.js";
import type { HostEnvironment, ReadText } from "../src/issue-host.js";
import type { RunCommand } from "../src/issue-repository.js";

const repository = { host: "github.com", owner: "acme", repo: "widgets" };
const signal = new AbortController().signal;
const reply =
  (stdout: string, code = 0, stderr = "", killed = false): RunCommand =>
  async () => ({ stdout, stderr, code, killed, truncated: false });

describe("GitHub issue URLs", () => {
  test("always use the /issues/ path, which GitHub redirects to /pull/ for pull requests", () => {
    expect(GITHUB.issueUrl({ host: "github.com", owner: "acme", repo: "widgets" }, 12, "#")).toBe(
      "https://github.com/acme/widgets/issues/12",
    );
    expect(GITHUB.issueUrl({ host: "octo.ghe.com", owner: "me", repo: "core" }, "7", "#")).toBe(
      "https://octo.ghe.com/me/core/issues/7",
    );
  });
});

describe("GitHub adapter", () => {
  test("uses # alone and declares the GitHub CLI", () => {
    expect(GITHUB.sigils).toEqual(["#"]);
    expect(GITHUB.cli).toEqual({ name: "GitHub CLI", command: "gh" });
  });

  test("a repository path is exactly owner/repo", () => {
    expect(GITHUB.parseRepository("acme/my.repo_1")).toEqual({
      owner: "acme",
      repo: "my.repo_1",
    });
    for (const path of [
      "",
      "acme",
      "acme/widgets/extra",
      "group/sub/widgets",
      "-acme/widgets",
      "acme--x/widgets",
      "acme/..",
      "acme/wid gets",
    ]) {
      expect(GITHUB.parseRepository(path)).toBeUndefined();
    }
  });

  test("its qualifier is owner/repo", () => {
    const qualifier = new RegExp(`^${GITHUB.qualifier}$`);
    expect(qualifier.test("a-b/c.d_e")).toBe(true);
    for (const text of ["acme", "x/y/z", "-a/b", "a--b/c", "a/"]) {
      expect(qualifier.test(text)).toBe(false);
    }
  });
});

describe("GitHub recent issues", () => {
  test("asks gh for one page of the repository's latest items, on its host", async () => {
    const calls: unknown[] = [];
    await GITHUB.listRecent(
      { host: "octo.ghe.com", owner: "me", repo: "core" },
      "#",
      async (command, args, options) => {
        calls.push([command, args, options?.signal === signal, options?.timeout !== undefined]);
        return { stdout: "[]", stderr: "", code: 0, killed: false, truncated: false };
      },
      signal,
    );
    expect(calls).toEqual([
      [
        "gh",
        [
          "api",
          "--hostname",
          "octo.ghe.com",
          "repos/me/core/issues?state=all&sort=updated&per_page=100",
        ],
        true,
        true,
      ],
    ]);
  });

  test("tells issues from pull requests and reads each state", async () => {
    const items = [
      { number: 5, title: "Open issue", state: "open" },
      { number: 4, title: "Closed issue", state: "closed" },
      {
        number: 3,
        title: "Open PR",
        state: "open",
        pull_request: { merged_at: null },
      },
      {
        number: 2,
        title: "Draft PR",
        state: "open",
        draft: true,
        pull_request: {},
      },
      {
        number: 1,
        title: "Merged PR",
        state: "closed",
        pull_request: { merged_at: "2026-01-01T00:00:00Z" },
      },
      {
        number: 0,
        title: "Closed PR",
        state: "closed",
        pull_request: { merged_at: null },
      },
    ];
    expect(await GITHUB.listRecent(repository, "#", reply(JSON.stringify(items)), signal)).toEqual({
      ok: true,
      issues: [
        { number: 5, title: "Open issue", kind: "issue", state: "open" },
        { number: 4, title: "Closed issue", kind: "issue", state: "closed" },
        { number: 3, title: "Open PR", kind: "pull request", state: "open" },
        { number: 2, title: "Draft PR", kind: "pull request", state: "draft" },
        {
          number: 1,
          title: "Merged PR",
          kind: "pull request",
          state: "merged",
        },
        {
          number: 0,
          title: "Closed PR",
          kind: "pull request",
          state: "closed",
        },
      ],
    });
  });

  test("skips malformed items", async () => {
    const stdout = JSON.stringify([
      null,
      "x",
      { number: "7", title: "text number", state: "open" },
      { number: 7, title: 8, state: "open" },
      { number: 7, title: "no state" },
      { number: 7, title: "odd state", state: "locked" },
      { number: 8, title: "kept", state: "open" },
    ]);
    expect(await GITHUB.listRecent(repository, "#", reply(stdout), signal)).toEqual({
      ok: true,
      issues: [{ number: 8, title: "kept", kind: "issue", state: "open" }],
    });
  });

  test.each([
    ["exit code 4 (authentication needed)", reply("", 4, "gh: To get started, run: gh auth login")],
    ["an auth hint on another exit code", reply("", 1, "Try authenticating with: gh auth login")],
    ["a missing gh, which prints nothing", reply("", 1, "")],
    ["a host gh is not signed in to", reply("", 1, "gh auth login --hostname octo.ghe.com")],
  ])("asks for the GitHub CLI after %s", async (_name, run) => {
    expect(await GITHUB.listRecent(repository, "#", run, signal)).toEqual({
      ok: false,
      reason: "needs-cli",
    });
  });

  test.each([
    ["a missing repository", reply("", 1, "gh: Not Found (HTTP 404)")],
    ["a rate limit", reply("", 1, "gh: API rate limit exceeded (HTTP 403)")],
    ["a network error", reply("", 1, "error connecting to api.github.com")],
    ["a killed process", reply("", 1, "", true)],
    ["invalid JSON", reply("not json")],
    ["a JSON object", reply('{"message":"x"}')],
    [
      "a command that throws",
      async () => {
        throw new Error("aborted");
      },
    ],
  ])("fails quietly after %s", async (_name, run) => {
    expect(await GITHUB.listRecent(repository, "#", run, signal)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("GitHub configured hosts", () => {
  const environment = (
    env: Record<string, string | undefined>,
    platform = "darwin",
  ): HostEnvironment => ({
    env,
    platform,
    homedir: platform === "win32" ? "C:\\Users\\me" : "/home/me",
  });
  const reads = (files: Record<string, string>) => {
    const paths: string[] = [];
    return {
      paths,
      readText: (async (path) => {
        paths.push(path);
        return files[path];
      }) satisfies ReadText,
    };
  };
  const hostsOf = async (
    env: Record<string, string | undefined>,
    files: Record<string, string> = {},
    platform = "darwin",
  ): Promise<string[]> =>
    [
      ...(
        await GITHUB.configuredHosts({
          environment: environment(env, platform),
          readText: reads(files).readText,
        })
      ).keys(),
    ].sort();

  test.each([
    [
      "GH_CONFIG_DIR wins over everything",
      { GH_CONFIG_DIR: "/cfg", XDG_CONFIG_HOME: "/xdg", APPDATA: "C:\\App" },
      "linux",
      "/cfg/hosts.yml",
    ],
    [
      "XDG_CONFIG_HOME/gh next",
      { XDG_CONFIG_HOME: "/xdg", APPDATA: "C:\\App" },
      "linux",
      "/xdg/gh/hosts.yml",
    ],
    [
      "APPDATA/GitHub CLI on Windows",
      { APPDATA: "C:\\App" },
      "win32",
      "C:\\App\\GitHub CLI\\hosts.yml",
    ],
    [
      "XDG_CONFIG_HOME beats APPDATA on Windows",
      { XDG_CONFIG_HOME: "D:\\xdg", APPDATA: "C:\\App" },
      "win32",
      "D:\\xdg\\gh\\hosts.yml",
    ],
    ["GH_CONFIG_DIR on Windows", { GH_CONFIG_DIR: "D:\\gh" }, "win32", "D:\\gh\\hosts.yml"],
    [
      "APPDATA is ignored off Windows",
      { APPDATA: "/app" },
      "darwin",
      "/home/me/.config/gh/hosts.yml",
    ],
    ["the home fallback", {}, "linux", "/home/me/.config/gh/hosts.yml"],
    ["the home fallback on macOS", {}, "darwin", "/home/me/.config/gh/hosts.yml"],
    ["the home fallback on Windows", {}, "win32", "C:\\Users\\me\\.config\\gh\\hosts.yml"],
    [
      "empty values count as unset",
      { GH_CONFIG_DIR: "", XDG_CONFIG_HOME: "", APPDATA: "" },
      "win32",
      "C:\\Users\\me\\.config\\gh\\hosts.yml",
    ],
    [
      "undefined values count as unset",
      { GH_CONFIG_DIR: undefined, XDG_CONFIG_HOME: "/xdg" },
      "linux",
      "/xdg/gh/hosts.yml",
    ],
  ])("reads %s", async (_name, env, platform, expected) => {
    const { readText, paths } = reads({});
    await GITHUB.configuredHosts({
      environment: environment(env, platform),
      readText,
    });
    expect(paths).toEqual([expected]);
  });

  test("lists the top-level keys of hosts.yml, lower-cased", async () => {
    const file = "/home/me/.config/gh/hosts.yml";
    expect(
      await hostsOf(
        {},
        {
          [file]:
            "github.com:\n  user: me\nGitHub.Corp.Example:\n  user: me\n  git_protocol: ssh\n",
        },
      ),
    ).toEqual(["github.com", "github.corp.example"]);
  });

  test("recognises a keyring-style hosts.yml, which holds no token", async () => {
    const file = "/home/me/.config/gh/hosts.yml";
    const keyring = [
      "github.corp.example:",
      "    git_protocol: https",
      "    users:",
      "        me:",
      "    user: me",
      "",
    ].join("\n");
    expect(await hostsOf({}, { [file]: keyring })).toEqual(["github.corp.example"]);
  });

  test("never reads values: a nested key is not a host", async () => {
    const file = "/home/me/.config/gh/hosts.yml";
    expect(
      await hostsOf({}, { [file]: "github.corp.example:\n  users:\n    other.example:\n" }),
    ).toEqual(["github.corp.example"]);
  });

  test("a missing, empty, malformed, or non-mapping file yields no hosts, without throwing", async () => {
    const file = "/home/me/.config/gh/hosts.yml";
    expect(await hostsOf({})).toEqual([]);
    for (const text of [
      "",
      "# only a comment\n",
      "a: [unclosed\n  b: : :\n",
      "- a\n- b\n",
      "just text",
    ]) {
      expect(await hostsOf({}, { [file]: text })).toEqual([]);
    }
    const failing: ReadText = async () => {
      throw new Error("EACCES");
    };
    expect(
      await GITHUB.configuredHosts({
        environment: environment({}),
        readText: failing,
      }),
    ).toEqual(new Map());
  });

  test("a non-empty GH_HOST adds its host, with or without hosts.yml", async () => {
    expect(await hostsOf({ GH_HOST: "GitHub.Corp.Example" })).toEqual(["github.corp.example"]);
    const file = "/home/me/.config/gh/hosts.yml";
    expect(await hostsOf({ GH_HOST: "b.example" }, { [file]: "a.example:\n  user: me\n" })).toEqual(
      ["a.example", "b.example"],
    );
    expect(await hostsOf({ GH_HOST: "" })).toEqual([]);
  });

  test("tokens add nothing beyond the built-in github.com", async () => {
    expect(
      await hostsOf({
        GH_TOKEN: "x",
        GITHUB_TOKEN: "x",
        GH_ENTERPRISE_TOKEN: "x",
        GITHUB_ENTERPRISE_TOKEN: "x",
      }),
    ).toEqual([]);
  });
});
