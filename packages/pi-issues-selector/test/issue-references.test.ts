import { describe, expect, test } from "vitest";
import type { IssueRepository } from "../src/issue-repository.js";
import { transformIssueReferences } from "../src/issue-references.js";

const github: IssueRepository = { host: "github.com", owner: "acme", repo: "widgets" };
const bare = (number: number | string): string =>
  `[#${number}](https://github.com/acme/widgets/issues/${number})`;
const qualified = (target: string, number: number | string): string =>
  `[${target}#${number}](https://github.com/${target}/issues/${number})`;
const convert = (text: string, repository: IssueRepository | undefined = github): string =>
  transformIssueReferences(text, repository);

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
    expect(transformIssueReferences("See #123", undefined)).toBe("See #123");
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

  test("defaults to github.com outside a Git repository", () => {
    expect(transformIssueReferences("See acme/other#5 and #6.", undefined)).toBe(
      `See ${qualified("acme/other", 5)} and #6.`,
    );
  });
});

describe("hosts", () => {
  test("links on the Issue Repository's host", () => {
    const enterprise: IssueRepository = { host: "octo.ghe.com", owner: "me", repo: "core" };
    expect(convert("#7 and me/other#8", enterprise)).toBe(
      "[#7](https://octo.ghe.com/me/core/issues/7) and [me/other#8](https://octo.ghe.com/me/other/issues/8)",
    );
  });

  test("links ssh.github.com remotes on github.com", () => {
    const ssh: IssueRepository = { host: "ssh.github.com", owner: "me", repo: "core" };
    expect(convert("#7", ssh)).toBe("[#7](https://github.com/me/core/issues/7)");
  });

  test.each(["gitlab.com", "gh-work", "bitbucket.org", "github.com.evil.example", "ghe.com"])(
    "leaves every reference literal beside a %s remote",
    (host) => {
      const other: IssueRepository = { host, owner: "me", repo: "core" };
      expect(convert("#7 and me/other#8", other)).toBe("#7 and me/other#8");
    },
  );
});
