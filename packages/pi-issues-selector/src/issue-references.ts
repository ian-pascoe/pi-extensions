import { replaceProseReferences } from "@ian-pascoe/pi-utils/prose-references";
import { findIssueHost } from "./github-host.js";
import { OWNER_PATTERN, REPO_PATTERN, type IssueRepository } from "./issue-repository.js";

export const ISSUE_SIGIL = "#";

/** Characters a partially typed issue number or title may hold. */
export const ISSUE_PARTIAL_NAME = "[^\\s#[\\]()`*~<>]*";

/** Quick test for text that may hold a reference, before any command runs. */
export const MAY_HOLD_ISSUE_REFERENCE = /#[1-9]/;

// A number is 1 to 10 digits with no leading zero.
const ISSUE_NUMBER = "[1-9][0-9]{0,9}";
// `&` keeps an HTML entity such as `&#123;` literal. A repository path is not written after `.`,
// `:`, or `@` (a domain, a scheme, a mention).
const EXCLUDE_BEFORE = "&.:@";

/**
 * Replaces `#123` and `owner/repo#123` in prose with Markdown links to the issue's web page.
 * Bare numbers need an Issue Repository on a supported host. A qualified reference uses its host,
 * or github.com outside a repository, and stays literal beside an unsupported remote.
 */
export function transformIssueReferences(
  text: string,
  repository: IssueRepository | undefined,
): string {
  const served = repository === undefined ? undefined : findIssueHost(repository.host);
  if (repository !== undefined && served === undefined) return text;
  const target = served ?? findIssueHost("github.com");
  if (target === undefined) return text;
  const { adapter, host } = target;
  return replaceProseReferences(text, {
    sigil: ISSUE_SIGIL,
    name: ISSUE_NUMBER,
    qualifier: `${OWNER_PATTERN}/${REPO_PATTERN}`,
    excludeBefore: EXCLUDE_BEFORE,
    resolve: (number, qualified) => {
      if (qualified === undefined) {
        if (repository === undefined) return undefined;
        const url = adapter.issueUrl({ ...repository, host }, number);
        return `[${ISSUE_SIGIL}${number}](${url})`;
      }
      const [owner, repo] = qualified.split("/");
      if (owner === undefined || repo === undefined || repo === "." || repo === "..") {
        return undefined;
      }
      return `[${qualified}${ISSUE_SIGIL}${number}](${adapter.issueUrl({ host, owner, repo }, number)})`;
    },
  });
}
