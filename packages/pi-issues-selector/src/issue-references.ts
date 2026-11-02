import { replaceProseReferences } from "@ian-pascoe/pi-utils/prose-references";
import { findIssueHost } from "./github-host.js";
import { OWNER_PATTERN, REPO_PATTERN, parseOwnerRepo } from "./issue-repository.js";
import type { IssueRepositoryLookup } from "./issue-repository.js";

export const ISSUE_SIGIL = "#";

/** Characters a partially typed issue number or title may hold. */
export const ISSUE_PARTIAL_NAME = "[^\\s#[\\]()`*~<>]*";

/**
 * Characters that may not directly precede a `#` token, besides the letters, digits, `_`, `#`,
 * `/`, `+`, and `-` the shared rule excludes. `&` keeps an HTML entity such as `&#123;` literal. A
 * repository path is not written after `.`, `:`, or `@` (a domain, a scheme, a mention).
 */
export const EXCLUDE_BEFORE = "&.:@";

/** Quick test for text that may hold a reference, before any command runs. */
export const MAY_HOLD_ISSUE_REFERENCE = /#[1-9]/;

// A number is 1 to 10 digits with no leading zero.
const ISSUE_NUMBER = "[1-9][0-9]{0,9}";

/**
 * Replaces `#123` and `owner/repo#123` in prose with Markdown links to the issue's web page.
 * Bare numbers need an Issue Repository on a supported host. A qualified reference uses that
 * host, or github.com when the checkout has no remotes at all, and stays literal when remotes
 * exist but none names a repository on a supported host.
 */
export function transformIssueReferences(text: string, lookup: IssueRepositoryLookup): string {
  if (lookup.kind === "unresolved") return text;
  const repository = lookup.kind === "found" ? lookup.repository : undefined;
  const target = findIssueHost(repository?.host ?? "github.com");
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
      const named = parseOwnerRepo(qualified);
      if (named === undefined) return undefined;
      return `[${qualified}${ISSUE_SIGIL}${number}](${adapter.issueUrl({ host, ...named }, number)})`;
    },
  });
}
