import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";
import type { IssueSummary } from "./issue-host.js";

export const MAX_ISSUE_SUGGESTIONS = 20;

function describe(issue: IssueSummary): string {
  const kinds = {
    issue: "issue",
    "pull request": "PR",
    "merge request": "MR",
  } as const;
  const kind = kinds[issue.kind];
  return `${kind} · ${issue.state} · ${issue.title.replace(/\s+/g, " ").trim()}`;
}

/**
 * Popup items for what follows `sigil` (`#` or `!`): nothing typed lists the latest items, digits
 * filter by number prefix (the exact number first), and anything else fuzzy-matches titles.
 */
export function suggestIssues(
  issues: readonly IssueSummary[],
  query: string,
  sigil: string,
): AutocompleteItem[] {
  let matches: readonly IssueSummary[];
  if (query === "") {
    matches = issues;
  } else if (/^[0-9]+$/.test(query)) {
    const byNumber = issues.filter((issue) => String(issue.number).startsWith(query));
    matches = [
      ...byNumber.filter((issue) => String(issue.number) === query),
      ...byNumber.filter((issue) => String(issue.number) !== query),
    ];
  } else {
    matches = fuzzyFilter([...issues], query, (issue) => issue.title);
  }
  return matches.slice(0, MAX_ISSUE_SUGGESTIONS).map((issue) => ({
    value: `${sigil}${issue.number}`,
    label: `${sigil}${issue.number}`,
    description: describe(issue),
  }));
}
