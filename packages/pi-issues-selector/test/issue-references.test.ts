import { describe, expect, test } from "vitest";
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
    ["See #123.", `See ${bare(123)}.`],
    ["See #123, #124 and #125!", `See ${bare(123)}, ${bare(124)} and ${bare(125)}!`],
    ["(#123)", `(${bare(123)})`],
    ["(see #123)", `(see ${bare(123)})`],
    ["see #123)", `see ${bare(123)})`],
    ["#123", bare(123)],
    ["#123 first", `${bare(123)} first`],
    ["## Fix #123", `## Fix ${bare(123)}`],
    ["Fixes #1234567890", `Fixes ${bare(1234567890)}`],
    ["my #1 priority", `my ${bare(1)} priority`],
    ["- item #7\n- item #8", `- item ${bare(7)}\n- item ${bare(8)}`],
    ["> quoted #9", `> quoted ${bare(9)}`],
    ["**done** in #10", `**done** in ${bare(10)}`],
    ["see #123; and #124", `see ${bare(123)}; and ${bare(124)}`],
    ["see #123: details", `see ${bare(123)}: details`],
    ["Line one\n#11 starts a line", `Line one\n${bare(11)} starts a line`],
  ])("converts %j", (text, expected) => {
    expect(convert(text)).toBe(expected);
  });

  test.each([
    "\\#123",
    "[#123](https://example.com)",
    "[see #123](https://example.com)",
    "&#123;",
    "#1st",
    "#123abc",
    "#123.5",
    "issue#123",
    "PR#1",
    "##123",
    "#0",
    "#0123",
    "#12345678901",
    "`#123`",
    "```\n#123\n```",
    "    #123",
    "<div>#123</div>",
    "https://example.com/page#123",
    "path/to/file.md#12",
    "a-#123",
    "#",
    "# 123",
    "#-123",
    "#123_",
  ])("keeps %j literal", (text) => {
    expect(convert(text)).toBe(text);
  });

  test("converts only the references a message holds in prose", () => {
    expect(convert("Fix #1 in `#2`, not [#3](/x) or \\#4, but #5.")).toBe(
      `Fix ${bare(1)} in \`#2\`, not [#3](/x) or \\#4, but ${bare(5)}.`,
    );
  });

  test("is idempotent", () => {
    const once = convert("See #123 and acme/other#4.");
    expect(convert(once)).toBe(once);
  });

  test("is literal without an Issue Repository", () => {
    expect(transformIssueReferences("See #123", { kind: "none" })).toBe("See #123");
  });
});

describe("owner/repo#123", () => {
  test.each([
    ["See acme/other#5.", `See ${qualified("acme/other", 5)}.`],
    ["(acme/other#5)", `(${qualified("acme/other", 5)})`],
    ["a-b/c.d_e#6", qualified("a-b/c.d_e", 6)],
    ["Both #1 and acme/other#2", `Both ${bare(1)} and ${qualified("acme/other", 2)}`],
    ["acme/widgets#3", qualified("acme/widgets", 3)],
    ["acme/other#5.", `${qualified("acme/other", 5)}.`],
    ["see acme/other#5, then", `see ${qualified("acme/other", 5)}, then`],
  ])("converts %j", (text, expected) => {
    expect(convert(text)).toBe(expected);
  });

  test.each([
    "x/y/z#1",
    "/acme/other#1",
    ".acme/other#1",
    ":acme/other#1",
    "@acme/other#1",
    "a@acme/other#1",
    "xacme/other#1x",
    "acme/other#1/",
    "acme/other#1x",
    "acme/other##1",
    "acme/other#0",
    "-acme/other#1",
    "acme-/other#1",
    "acme--x/other#1",
    "acme/other/more#1",
    "`acme/other#1`",
    "[acme/other#1](/x)",
    "github.com/acme/other#1",
    "https://github.com/acme/other#1",
  ])("keeps %j literal", (text) => {
    expect(convert(text)).toBe(text);
  });

  test("defaults to github.com when the checkout has no remotes", () => {
    expect(transformIssueReferences("See acme/other#5 and #6.", { kind: "none" })).toBe(
      `See ${qualified("acme/other", 5)} and #6.`,
    );
  });
});

describe("remotes that name no hosted repository", () => {
  test("leave every reference literal, qualified or not", () => {
    expect(transformIssueReferences("#7 and me/other#8", { kind: "unresolved" })).toBe(
      "#7 and me/other#8",
    );
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

  test("links ssh.github.com remotes on github.com", async () => {
    expect(await submit("#7", "remote.origin.url ssh://git@ssh.github.com:443/me/core.git\n")).toBe(
      "[#7](https://github.com/me/core/issues/7)",
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
    ["a GitLab host glab is not configured for", "https://gitlab.corp.example/me/core.git"],
    ["an SSH host alias", "git@gh-work:me/core.git"],
    ["bitbucket.org", "https://bitbucket.org/me/core.git"],
    ["a look-alike of github.com", "https://github.com.evil.example/me/core.git"],
    ["ghe.com itself", "https://ghe.com/me/core.git"],
    ["a host that is not configured", "https://github.corp.example/me/core.git"],
  ])("leaves every reference literal beside %s", async (_name, url) => {
    expect(await submit("#7 and me/other#8", `remote.origin.url ${url}\n`)).toBe(
      "#7 and me/other#8",
    );
  });

  test.each([
    ["an SSH host alias", "origin=git@github-work:acme/widgets.git"],
    ["bitbucket.org", "origin=https://bitbucket.org/acme/widgets.git"],
  ])(
    "never falls through to another remote: %s on origin stays literal beside a github.com mirror",
    async (_name, origin) => {
      const [name, url] = origin.split("=");
      expect(
        await submit(
          "Fix #12",
          `remote.${name}.url ${url}\nremote.mirror.url https://github.com/acme/mirror.git\n`,
        ),
      ).toBe("Fix #12");
    },
  );
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
    "e.g./x#1",
    "~/a/b#1",
    "issue#123",
    "group/proj.git#3",
    "group/proj.atom#3",
    "group/proj.git!3",
    "/group/proj#1",
    "https://gitlab.com/group/proj#1",
    "x@group/proj#1",
    "proj#12",
    "proj!12",
    "a != b",
    "x!=3",
    "!0",
    "!012",
    "Hello!3",
    "wow!3",
    "!3x",
    "!3.5",
    "`!3`",
    "[!3](/x)",
    "\\!3",
    "!!3",
    "&!3",
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
