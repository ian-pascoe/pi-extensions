import { replaceProseReferences } from "@ian-pascoe/pi-utils/prose-references";
import { DEFAULT_ISSUE_HOST } from "./issue-host.js";
import type { IssueRepositoryLookup } from "./issue-repository.js";

export const ISSUE_SIGIL = "#";

/** The sigil of a GitLab merge request. Pi runs a message that starts with it as a bash command. */
export const MERGE_REQUEST_SIGIL = "!";

/** Characters a partially typed issue number or title may hold. */
export const ISSUE_PARTIAL_NAME = "[^\\s#[\\]()`*~<>]*";

/**
 * Characters that may not directly precede a `#` token, besides the letters, digits, `_`, `#`,
 * `/`, `+`, and `-` the shared rule excludes. `&` keeps an HTML entity such as `&#123;` literal. A
 * repository path is not written after `.`, `:`, or `@` (a domain, a scheme, a mention).
 */
export const EXCLUDE_BEFORE = "&.:@";

/**
 * Characters a partially typed merge request number or title may hold. Excluding `=` keeps `!=`
 * from opening the popup.
 */
export const MERGE_REQUEST_PARTIAL_NAME = "[^\\s!=[\\]()`*~<>]*";

/** Quick test for text that may hold a reference, before any command runs. */
export const MAY_HOLD_ISSUE_REFERENCE = /[#!][1-9]/;

// A number is 1 to 10 digits with no leading zero.
const ISSUE_NUMBER = "[1-9][0-9]{0,9}";

/**
 * Replaces `#123`, `!123`, and `owner/repo#123` in prose with Markdown links to the item's web
 * page, converting each of the Issue Host's sigils in turn (a link one pass made is left alone by
 * the next). Bare numbers need an Issue Repository on a host name an Issue Host serves. A
 * qualified reference uses that host and its adapter, or github.com when the checkout has no
 * remotes at all, and stays literal when remotes exist but no Issue Host serves the selected
 * one's host name.
 */
export function transformIssueReferences(text: string, lookup: IssueRepositoryLookup): string {
  if (lookup.kind === "unresolved") return text;
  const repository = lookup.kind === "found" ? lookup.repository : undefined;
  const { adapter, host } = lookup.kind === "found" ? lookup : DEFAULT_ISSUE_HOST;
  return adapter.sigils.reduce(
    (converted, sigil) =>
      replaceProseReferences(converted, {
        sigil,
        name: ISSUE_NUMBER,
        qualifier: adapter.qualifier,
        excludeBefore: EXCLUDE_BEFORE,
        resolve: (number, qualified) => {
          if (qualified === undefined) {
            if (repository === undefined) return undefined;
            const url = adapter.issueUrl({ ...repository, host }, number, sigil);
            return `[${sigil}${number}](${url})`;
          }
          const named = adapter.parseRepository(qualified);
          if (named === undefined) return undefined;
          return `[${qualified}${sigil}${number}](${adapter.issueUrl({ host, ...named }, number, sigil)})`;
        },
      }),
    text,
  );
}
