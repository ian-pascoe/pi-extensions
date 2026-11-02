import { describe, expect, test } from "vitest";
import { findIssueHost, GITHUB } from "../src/github-host.js";
import type { RunCommand } from "../src/issue-repository.js";

const repository = { host: "github.com", owner: "acme", repo: "widgets" };
const signal = new AbortController().signal;
const reply =
  (stdout: string, code = 0, stderr = "", killed = false): RunCommand =>
  async () => ({ stdout, stderr, code, killed });

describe("findIssueHost", () => {
  test.each([
    ["github.com", "github.com"],
    ["GitHub.com", "github.com"],
    ["ssh.github.com", "github.com"],
    ["octo.ghe.com", "octo.ghe.com"],
    ["a.b.ghe.com", "a.b.ghe.com"],
  ])("%s is served as %s", (host, canonical) => {
    expect(findIssueHost(host)).toEqual({ adapter: GITHUB, host: canonical });
  });

  test.each(["gitlab.com", "ghe.com", "gh-work", "github.com.evil.example", "xghe.com", ""])(
    "%j is not served",
    (host) => {
      expect(findIssueHost(host)).toBeUndefined();
    },
  );
});

describe("GitHub issue URLs", () => {
  test("always use the /issues/ path, which GitHub redirects to /pull/ for pull requests", () => {
    expect(GITHUB.issueUrl({ host: "github.com", owner: "acme", repo: "widgets" }, 12)).toBe(
      "https://github.com/acme/widgets/issues/12",
    );
    expect(GITHUB.issueUrl({ host: "octo.ghe.com", owner: "me", repo: "core" }, "7")).toBe(
      "https://octo.ghe.com/me/core/issues/7",
    );
  });
});

describe("GitHub recent issues", () => {
  test("asks gh for one page of the repository's latest items, on its host", async () => {
    const calls: unknown[] = [];
    await GITHUB.listRecent(
      { host: "octo.ghe.com", owner: "me", repo: "core" },
      async (command, args, options) => {
        calls.push([command, args, options.signal === signal, options.timeout !== undefined]);
        return { stdout: "[]", stderr: "", code: 0, killed: false };
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

  test("asks about github.com for an ssh.github.com remote", async () => {
    const args: string[][] = [];
    await GITHUB.listRecent(
      { host: "ssh.github.com", owner: "me", repo: "core" },
      async (_command, received) => {
        args.push(received);
        return { stdout: "[]", stderr: "", code: 0, killed: false };
      },
      signal,
    );
    expect(args[0]?.slice(1, 3)).toEqual(["--hostname", "github.com"]);
  });

  test("tells issues from pull requests and reads each state", async () => {
    const items = [
      { number: 5, title: "Open issue", state: "open" },
      { number: 4, title: "Closed issue", state: "closed" },
      { number: 3, title: "Open PR", state: "open", pull_request: { merged_at: null } },
      { number: 2, title: "Draft PR", state: "open", draft: true, pull_request: {} },
      {
        number: 1,
        title: "Merged PR",
        state: "closed",
        pull_request: { merged_at: "2026-01-01T00:00:00Z" },
      },
      { number: 0, title: "Closed PR", state: "closed", pull_request: { merged_at: null } },
    ];
    expect(await GITHUB.listRecent(repository, reply(JSON.stringify(items)), signal)).toEqual({
      ok: true,
      issues: [
        { number: 5, title: "Open issue", kind: "issue", state: "open" },
        { number: 4, title: "Closed issue", kind: "issue", state: "closed" },
        { number: 3, title: "Open PR", kind: "pull request", state: "open" },
        { number: 2, title: "Draft PR", kind: "pull request", state: "draft" },
        { number: 1, title: "Merged PR", kind: "pull request", state: "merged" },
        { number: 0, title: "Closed PR", kind: "pull request", state: "closed" },
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
    expect(await GITHUB.listRecent(repository, reply(stdout), signal)).toEqual({
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
    expect(await GITHUB.listRecent(repository, run, signal)).toEqual({
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
    expect(await GITHUB.listRecent(repository, run, signal)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});
