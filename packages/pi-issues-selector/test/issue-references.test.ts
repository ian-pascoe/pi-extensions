import { describe, expect, test } from "vite-plus/test";
import { configuredFor } from "./configured-hosts.js";
import { GITHUB } from "../src/github-host.js";
import { GITLAB } from "../src/gitlab-host.js";
import {
  lookupIssueRepository,
  type HostedRepository,
  type IssueRepositoryLookup,
} from "../src/issue-repository.js";
import { transformIssueReferences } from "../src/issue-references.js";

const github: HostedRepository = {
  host: "github.com",
  owner: "acme",
  repo: "widgets",
};
const found = (repository: HostedRepository, host = repository.host): IssueRepositoryLookup => ({
  kind: "found",
  repository,
  adapter: GITHUB,
  host,
});
const bare = (number: number | string): string =>
  `[#${number}](https://github.com/acme/widgets/issues/${number})`;
const qualified = (target: string, number: number | string): string =>
  `[${target}#${number}](https://github.com/${target}/issues/${number})`;
const convert = (text: string, lookup: IssueRepositoryLookup = found(github)): string =>
  transformIssueReferences(text, lookup);

describe("bare #123", () => {
  test.each([
    ["See #123, #124 and #125!", `See ${bare(123)}, ${bare(124)} and ${bare(125)}!`],
    ["(see #123)", `(see ${bare(123)})`],
    ["#123", bare(123)],
    ["## Fix #123", `## Fix ${bare(123)}`],
    ["Line one\n#11 starts a line", `Line one\n${bare(11)} starts a line`],
  ])("converts %j", (text, expected) => {
    expect(convert(text)).toBe(expected);
  });

  test.each([
    "\\#123",
    "[#123](https://example.com)",
    "&#123;",
    "#1st",
    "#123.5",
    "issue#123",
    "#0",
    "#12345678901",
    "`#123`",
    "https://example.com/page#123",
  ])("keeps %j literal", (text) => {
    expect(convert(text)).toBe(text);
  });
});

describe("owner/repo#123", () => {
  test.each([
    ["See acme/other#5.", `See ${qualified("acme/other", 5)}.`],
    ["a-b/c.d_e#6", qualified("a-b/c.d_e", 6)],
    ["Both #1 and acme/other#2", `Both ${bare(1)} and ${qualified("acme/other", 2)}`],
  ])("converts %j", (text, expected) => {
    expect(convert(text)).toBe(expected);
  });

  test.each([
    "x/y/z#1",
    ".acme/other#1",
    ":acme/other#1",
    "@acme/other#1",
    "acme/other#1/",
    "-acme/other#1",
    "`acme/other#1`",
    "https://github.com/acme/other#1",
  ])("keeps %j literal", (text) => {
    expect(convert(text)).toBe(text);
  });
});

describe("hosts", () => {
  // End to end: the remotes and the configured hosts decide the lookup, which decides the links.
  const submit = async (text: string, remotes: string, ...configured: string[]) =>
    transformIssueReferences(
      text,
      await lookupIssueRepository(remotes, async () => configuredFor(GITHUB, ...configured)),
    );

  test("links on the Issue Repository's host", async () => {
    expect(
      await submit("#7 and me/other#8", "remote.origin.url https://octo.ghe.com/me/core.git\n"),
    ).toBe(
      "[#7](https://octo.ghe.com/me/core/issues/7) and [me/other#8](https://octo.ghe.com/me/other/issues/8)",
    );
  });

  test("links a remote on a configured host, over https, dropping the port and the .git", async () => {
    expect(
      await submit(
        "Fix #12",
        "remote.origin.url https://github.corp.example/acme/widgets.git\n",
        "github.corp.example",
      ),
    ).toBe("Fix [#12](https://github.corp.example/acme/widgets/issues/12)");
    expect(
      await submit(
        "Fix #12 and acme/other#3",
        "remote.origin.url ssh://git@GitHub.Corp.Example:2222/acme/widgets.git\n",
        "github.corp.example",
      ),
    ).toBe(
      "Fix [#12](https://github.corp.example/acme/widgets/issues/12) and [acme/other#3](https://github.corp.example/acme/other/issues/3)",
    );
  });

  test.each([
    ["an SSH host alias", "git@gh-work:me/core.git"],
    ["a host that is not configured", "https://github.corp.example/me/core.git"],
  ])("leaves every reference literal beside %s", async (_name, url) => {
    expect(await submit("#7 and me/other#8", `remote.origin.url ${url}\n`)).toBe(
      "#7 and me/other#8",
    );
  });
});

describe("GitLab references", () => {
  const project: HostedRepository = { host: "gitlab.com", owner: "group/sub", repo: "project" };
  const lookup: IssueRepositoryLookup = {
    kind: "found",
    repository: project,
    adapter: GITLAB,
    host: "gitlab.com",
  };
  const issue = (number: number | string): string =>
    `[#${number}](https://gitlab.com/group/sub/project/-/issues/${number})`;
  const mergeRequest = (number: number | string): string =>
    `[!${number}](https://gitlab.com/group/sub/project/-/merge_requests/${number})`;
  const qualifiedIssue = (target: string, number: number | string): string =>
    `[${target}#${number}](https://gitlab.com/${target}/-/issues/${number})`;
  const gitLab = (text: string): string => transformIssueReferences(text, lookup);

  test("converts # to an issue link and ! to a merge request link", () => {
    expect(gitLab("Fix #12 and !3")).toBe(`Fix ${issue(12)} and ${mergeRequest(3)}`);
    expect(gitLab("!3")).toBe(mergeRequest(3));
    expect(gitLab("(!3), !4. #5; !6: x")).toBe(
      `(${mergeRequest(3)}), ${mergeRequest(4)}. ${issue(5)}; ${mergeRequest(6)}: x`,
    );
  });

  test("converts qualified references of 2 to 21 segments, on the Issue Repository's host", () => {
    expect(gitLab("group/sub/proj#12")).toBe(qualifiedIssue("group/sub/proj", 12));
    expect(gitLab("see a/b!7")).toBe("see [a/b!7](https://gitlab.com/a/b/-/merge_requests/7)");
    const deep = Array.from({ length: 21 }, (_, index) => `g${index}`).join("/");
    expect(gitLab(`${deep}#1`)).toBe(qualifiedIssue(deep, 1));
    expect(gitLab(`${deep}/x#1`)).toBe(`${deep}/x#1`);
  });

  test.each([
    "see ./foo/bar#12",
    "group/proj.git#3",
    "https://gitlab.com/group/proj#1",
    "proj#12",
    "x!=3",
    "!0",
    "Hello!3",
    "`!3`",
    "!!3",
  ])("keeps %j literal", (text) => {
    expect(gitLab(text)).toBe(text);
  });

  test("path-like prose converts, so paths belong in code", () => {
    expect(gitLab("src/foo#12")).toBe(qualifiedIssue("src/foo", 12));
    expect(gitLab("`src/foo#12`")).toBe("`src/foo#12`");
  });

  test("links made by the # pass are left alone by the ! pass, and the conversion is idempotent", () => {
    const once = gitLab("Fix #12, other/team/proj#4 and !3");
    expect(once).toBe(
      `Fix ${issue(12)}, ${qualifiedIssue("other/team/proj", 4)} and ${mergeRequest(3)}`,
    );
    expect(gitLab(once)).toBe(once);
  });

  test("a GitHub Issue Repository converts # only", () => {
    expect(convert("Fix #12 and !3 and a/b/c#4")).toBe(`Fix ${bare(12)} and !3 and a/b/c#4`);
  });

  test("is literal without a recognised Issue Repository, and defaults qualified references to github.com", () => {
    expect(transformIssueReferences("#1 !2 a/b#3", { kind: "unresolved" })).toBe("#1 !2 a/b#3");
    expect(transformIssueReferences("#1 !2 a/b#3 a/b/c#4", { kind: "none" })).toBe(
      `#1 !2 ${qualified("a/b", 3)} a/b/c#4`,
    );
  });
});
