import { describe, expect, test } from "vite-plus/test";
import { GITLAB } from "../src/gitlab-host.js";
import type { HostEnvironment, ReadText } from "../src/issue-host.js";
import type { RunCommand } from "../src/issue-repository.js";

const repository = { host: "gitlab.com", owner: "group/sub", repo: "project" };
const signal = new AbortController().signal;
const reply =
  (stdout: string, code = 0, stderr = "", killed = false): RunCommand =>
  async () => ({ stdout, stderr, code, killed, truncated: false });

describe("GitLab repository paths", () => {
  test.each([
    ["group/sub/project", "group/sub", "project"],
    ["Group_1/.dot/_under-score.x", "Group_1/.dot", "_under-score.x"],
    [
      Array.from({ length: 21 }, (_, index) => `g${index}`).join("/"),
      Array.from({ length: 20 }, (_, index) => `g${index}`).join("/"),
      "g20",
    ],
  ])("accepts %s", (path, owner, repo) => {
    expect(GITLAB.parseRepository(path)).toEqual({ owner, repo });
  });

  test.each([
    ["a single segment", "project"],
    ["22 segments", Array.from({ length: 22 }, (_, index) => `g${index}`).join("/")],
    ["an empty segment", "group//project"],
    ["a dot-dot segment", "group/../project"],
    ["a segment ending in .git", "group/project.git"],
    ["a segment ending in .atom", "group/sub.atom/project"],
    ["a percent escape", "group/pro%20ject"],
  ])("rejects %s", (_name, path) => {
    expect(GITLAB.parseRepository(path)).toBeUndefined();
  });
});

describe("GitLab recent issues and merge requests", () => {
  test("reads iid, title, and state of issues", async () => {
    const items = [
      { id: 900, iid: 5, title: "Open issue", state: "opened" },
      { id: 901, iid: 4, title: "Closed issue", state: "closed" },
    ];
    expect(await GITLAB.listRecent(repository, "#", reply(JSON.stringify(items)), signal)).toEqual({
      ok: true,
      issues: [
        { number: 5, title: "Open issue", kind: "issue", state: "open" },
        { number: 4, title: "Closed issue", kind: "issue", state: "closed" },
      ],
    });
  });

  test("reads each state of merge requests, a draft being open", async () => {
    const items = [
      { id: 1, iid: 6, title: "Open", state: "opened", draft: false },
      { id: 2, iid: 5, title: "Draft", state: "opened", draft: true },
      { id: 3, iid: 4, title: "Merged", state: "merged", draft: false },
      { id: 4, iid: 3, title: "Closed", state: "closed" },
      { id: 5, iid: 2, title: "Locked", state: "locked", draft: null },
      { id: 6, iid: 1, title: "Merged draft", state: "merged", draft: true },
    ];
    expect(await GITLAB.listRecent(repository, "!", reply(JSON.stringify(items)), signal)).toEqual({
      ok: true,
      issues: [
        { number: 6, title: "Open", kind: "merge request", state: "open" },
        { number: 5, title: "Draft", kind: "merge request", state: "draft" },
        { number: 4, title: "Merged", kind: "merge request", state: "merged" },
        { number: 3, title: "Closed", kind: "merge request", state: "closed" },
        { number: 2, title: "Locked", kind: "merge request", state: "open" },
        {
          number: 1,
          title: "Merged draft",
          kind: "merge request",
          state: "merged",
        },
      ],
    });
  });

  test("skips malformed items and states the listing does not have", async () => {
    const stdout = JSON.stringify([
      null,
      "x",
      { iid: "7", title: "text number", state: "opened" },
      { id: 7, title: "no iid", state: "opened" },
      { iid: 7, title: 8, state: "opened" },
      { iid: 7, title: "no state" },
      { iid: 7, title: "a merged issue", state: "merged" },
      { iid: 7, title: "an unknown state", state: "weird" },
      { iid: 8, title: "kept", state: "opened" },
    ]);
    expect(await GITLAB.listRecent(repository, "#", reply(stdout), signal)).toEqual({
      ok: true,
      issues: [{ number: 8, title: "kept", kind: "issue", state: "open" }],
    });
  });

  test.each([
    ["a missing glab, which prints nothing", reply("", 1, "")],
    ["a host glab is not signed in to", reply("", 1, "glab: run glab auth login --hostname x")],
    ["a 401", reply("", 1, "glab: 401 Unauthorized")],
    ["a bare unauthorized", reply("", 1, "error: Unauthorized request")],
    ["a private project, which answers 404", reply("", 1, "glab: 404 Project Not Found")],
  ])("asks for the GitLab CLI after %s", async (_name, run) => {
    expect(await GITLAB.listRecent(repository, "#", run, signal)).toEqual({
      ok: false,
      reason: "needs-cli",
    });
  });

  test.each([
    ["a rate limit", reply("", 1, "glab: 429 Too Many Requests")],
    ["output on stdout alone", reply("some output", 1, "")],
    ["a 404 that is not at the start of a line", reply("", 1, "request: glab: 404 later")],
  ])("fails quietly after %s", async (_name, run) => {
    expect(await GITLAB.listRecent(repository, "#", run, signal)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("GitLab configured hosts", () => {
  const environment = (
    env: Record<string, string | undefined>,
    platform: string,
  ): HostEnvironment => ({
    env,
    platform,
    homedir: platform === "win32" ? "C:\\Users\\me" : "/home/me",
  });
  /** The paths read, in order, until one of `files` answers. */
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
    platform = "linux",
  ): Promise<Array<[string, string]>> =>
    [
      ...(await GITLAB.configuredHosts({
        environment: environment(env, platform),
        readText: reads(files).readText,
      })),
    ].sort(([a], [b]) => a.localeCompare(b));

  describe("config directory", () => {
    test.each([
      [
        "GLAB_CONFIG_DIR alone, though a legacy file exists",
        { GLAB_CONFIG_DIR: "/cfg", XDG_CONFIG_HOME: "/xdg" },
        "linux",
        { "/home/me/.config/glab-cli/config.yml": "gitlab.legacy:\n" },
        ["/cfg/config.yml"],
      ],
      [
        "the legacy directory first",
        { XDG_CONFIG_HOME: "/xdg" },
        "linux",
        { "/home/me/.config/glab-cli/config.yml": "hosts: {}\n" },
        ["/home/me/.config/glab-cli/config.yml"],
      ],
      [
        "XDG_CONFIG_HOME/glab-cli when no legacy file exists",
        { XDG_CONFIG_HOME: "/xdg" },
        "linux",
        {},
        ["/home/me/.config/glab-cli/config.yml", "/xdg/glab-cli/config.yml"],
      ],
      [
        "~/Library/Application Support on macOS",
        {},
        "darwin",
        {},
        [
          "/home/me/.config/glab-cli/config.yml",
          "/home/me/Library/Application Support/glab-cli/config.yml",
        ],
      ],
      [
        "LOCALAPPDATA on Windows",
        { LOCALAPPDATA: "C:\\Local" },
        "win32",
        {},
        ["C:\\Users\\me\\.config\\glab-cli\\config.yml", "C:\\Local\\glab-cli\\config.yml"],
      ],
      [
        "the same legacy path once on other systems",
        {},
        "linux",
        {},
        ["/home/me/.config/glab-cli/config.yml"],
      ],
    ])("reads %s", async (_name, env, platform, files, expected) => {
      const { readText, paths } = reads(files);
      await GITLAB.configuredHosts({
        environment: environment(env, platform),
        readText,
      });
      expect(paths).toEqual(expected);
    });
  });

  describe("hosts", () => {
    const file = "/home/me/.config/glab-cli/config.yml";

    test("lists the keys under hosts, lower-cased", async () => {
      expect(
        await hostsOf(
          {},
          {
            [file]: "hosts:\n  GitLab.Example:\n    token: secret\n  other.example:\n    a: b\n",
          },
        ),
      ).toEqual([
        ["gitlab.example", "gitlab.example"],
        ["other.example", "other.example"],
      ]);
    });

    test("maps an ssh_host to its web host", async () => {
      expect(
        await hostsOf(
          {},
          {
            [file]:
              "hosts:\n  gitlab.example:\n    ssh_host: SSH.Gitlab.Example\n    token: secret\n",
          },
        ),
      ).toEqual([
        ["gitlab.example", "gitlab.example"],
        ["ssh.gitlab.example", "gitlab.example"],
      ]);
    });

    test("a host key keeps its own name against another host's ssh_host", async () => {
      expect(
        await hostsOf(
          {},
          {
            [file]: "hosts:\n  a.example:\n    ssh_host: b.example\n  b.example:\n",
          },
        ),
      ).toEqual([
        ["a.example", "a.example"],
        ["b.example", "b.example"],
      ]);
    });

    test("ignores a missing or non-string ssh_host and values it does not read", async () => {
      expect(
        await hostsOf(
          {},
          {
            [file]:
              "hosts:\n  a.example:\n    ssh_host: 5\n  b.example:\n    ssh_host: [x]\n  c.example: just text\n  d.example:\n    ssh_host: ''\n",
          },
        ),
      ).toEqual([
        ["a.example", "a.example"],
        ["b.example", "b.example"],
        ["c.example", "c.example"],
        ["d.example", "d.example"],
      ]);
    });

    test("does not count the default host key, other top-level keys, or the environment", async () => {
      expect(
        await hostsOf(
          {
            GITLAB_HOST: "env.example",
            GITLAB_URI: "env2.example",
            GL_HOST: "env3.example",
          },
          {
            [file]:
              "host: default.example\ngit_protocol: ssh\nother:\n  nested.example:\nhosts:\n  a.example:\n    nested:\n      deep.example:\n",
          },
        ),
      ).toEqual([["a.example", "a.example"]]);
    });

    test("a missing, empty, malformed, or non-mapping file yields no hosts, without throwing", async () => {
      expect(await hostsOf({})).toEqual([]);
      for (const text of ["hosts: [unclosed\n  b: : :\n", "- a\n- b\n", "hosts: text\n"]) {
        expect(await hostsOf({}, { [file]: text })).toEqual([]);
      }
      const failing: ReadText = async () => {
        throw new Error("EACCES");
      };
      expect(
        await GITLAB.configuredHosts({
          environment: environment({}, "linux"),
          readText: failing,
        }),
      ).toEqual(new Map());
    });
  });
});
