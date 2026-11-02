import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";
import type { IssueSummary } from "./issue-host.js";
import { ISSUE_SIGIL } from "./issue-references.js";

export const MAX_ISSUE_SUGGESTIONS = 20;

function describe(issue: IssueSummary): string {
  const kind = issue.kind === "issue" ? "issue" : "PR";
  return `${kind} · ${issue.state} · ${issue.title.replace(/\s+/g, " ").trim()}`;
}

/**
 * Popup items for what follows the `#`: nothing typed lists the latest items, digits filter by
 * number prefix (the exact number first), and anything else fuzzy-matches titles.
 */
export function suggestIssues(issues: readonly IssueSummary[], query: string): AutocompleteItem[] {
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
    value: `${ISSUE_SIGIL}${issue.number}`,
    label: `${ISSUE_SIGIL}${issue.number}`,
    description: describe(issue),
  }));
}
