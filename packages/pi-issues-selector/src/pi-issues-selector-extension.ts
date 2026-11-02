import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { stackProseReferenceAutocomplete } from "@ian-pascoe/pi-utils/prose-references";
import { findIssueHost } from "./github-host.js";
import {
  ISSUE_PARTIAL_NAME,
  ISSUE_SIGIL,
  MAY_HOLD_ISSUE_REFERENCE,
  transformIssueReferences,
} from "./issue-references.js";
import { suggestIssues } from "./issue-suggestions.js";
import { resolveIssueRepository, type RunCommand } from "./issue-repository.js";
import { RecentIssues } from "./recent-issues.js";

// Characters other than letters and digits that keep `#` from opening a completion: an HTML entity
// such as `&#123;` is not a reference. Matches the conversion rule.
const EXCLUDE_BEFORE = "&.:@";

export default function issuesSelectorExtension(pi: ExtensionAPI): void {
  const run: RunCommand = (command, args, options) => pi.exec(command, args, options);
  const recent = new RecentIssues();
  const notifiedHosts = new Set<string>();

  pi.on("session_start", (_event, ctx) => {
    notifiedHosts.clear();
    if (ctx.mode !== "tui") return;
    const cwd = ctx.cwd;
    const notifyOnce = (host: string): void => {
      if (notifiedHosts.has(host)) return;
      notifiedHosts.add(host);
      ctx.ui.notify(
        `Issue suggestions need the GitHub CLI (gh) signed in to ${host}. Run /skill:pi-issues-selector to diagnose.`,
        "info",
      );
    };
    ctx.ui.addAutocompleteProvider((current): AutocompleteProvider =>
      stackProseReferenceAutocomplete(current, {
        sigil: ISSUE_SIGIL,
        partialName: ISSUE_PARTIAL_NAME,
        excludeBefore: EXCLUDE_BEFORE,
        suggest: async (query, signal) => {
          const repository = await resolveIssueRepository(run, cwd, signal);
          if (repository === undefined || signal.aborted) return [];
          const served = findIssueHost(repository.host);
          if (served === undefined) return [];
          const { adapter, host } = served;
          const key = `${host}/${repository.owner}/${repository.repo}`.toLowerCase();
          const listing = await recent.get(
            key,
            (loadSignal) => adapter.listRecent({ ...repository, host }, run, loadSignal),
            signal,
          );
          if (listing === undefined) return [];
          if (!listing.ok) {
            if (listing.reason === "needs-cli") notifyOnce(host);
            return [];
          }
          return suggestIssues(listing.issues, query);
        },
      }),
    );
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !MAY_HOLD_ISSUE_REFERENCE.test(event.text)) {
      return { action: "continue" };
    }
    const repository = await resolveIssueRepository(run, ctx.cwd);
    const text = transformIssueReferences(event.text, repository);
    if (text === event.text) return { action: "continue" };
    return event.images === undefined
      ? { action: "transform", text }
      : { action: "transform", text, images: event.images };
  });
}
