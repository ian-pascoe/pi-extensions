import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { stackProseReferenceAutocomplete } from "@ian-pascoe/pi-utils/prose-references";
import {
  EXCLUDE_BEFORE,
  ISSUE_PARTIAL_NAME,
  ISSUE_SIGIL,
  MAY_HOLD_ISSUE_REFERENCE,
  MERGE_REQUEST_PARTIAL_NAME,
  MERGE_REQUEST_SIGIL,
  transformIssueReferences,
} from "./issue-references.js";
import { suggestIssues } from "./issue-suggestions.js";
import { resolveIssueRepository, type RunCommand } from "./issue-repository.js";
import { RecentIssues } from "./recent-issues.js";
import { systemHostSources } from "./system-host-sources.js";

/** Pi runs a message that starts with `!` as a bash command, so `!` there is not a reference. */
const isBashMode = (lines: readonly string[]): boolean =>
  lines.join("\n").trimStart().startsWith("!");

export default function issuesSelectorExtension(pi: ExtensionAPI): void {
  const run: RunCommand = (command, args, options) => pi.exec(command, args, options);
  const recent = new RecentIssues();
  const notifiedHosts = new Set<string>();

  pi.on("session_start", (_event, ctx) => {
    notifiedHosts.clear();
    if (ctx.mode !== "tui") return;
    const cwd = ctx.cwd;
    const notifyOnce = (host: string, cli: { name: string; command: string }): void => {
      if (notifiedHosts.has(host)) return;
      notifiedHosts.add(host);
      ctx.ui.notify(
        `Issue suggestions need the ${cli.name} (${cli.command}) signed in to ${host}. Run /skill:pi-issues-selector to diagnose.`,
        "info",
      );
    };
    // The items `sigil` stands for in the Issue Repository, nothing when its Issue Host has none.
    const suggestFor =
      (sigil: string) =>
      async (query: string, signal: AbortSignal): Promise<AutocompleteItem[]> => {
        const lookup = await resolveIssueRepository(run, cwd, systemHostSources(), signal);
        if (lookup.kind !== "found" || signal.aborted) return [];
        const { repository, adapter, host } = lookup;
        if (!adapter.sigils.includes(sigil)) return [];
        const key = `${sigil} ${host}/${repository.owner}/${repository.repo}`.toLowerCase();
        const listing = await recent.get(
          key,
          (loadSignal) => adapter.listRecent({ ...repository, host }, sigil, run, loadSignal),
          signal,
        );
        if (listing === undefined) return [];
        if (!listing.ok) {
          if (listing.reason === "needs-cli") notifyOnce(host, adapter.cli);
          return [];
        }
        return suggestIssues(listing.issues, query, sigil);
      };
    ctx.ui.addAutocompleteProvider((current): AutocompleteProvider =>
      stackProseReferenceAutocomplete(current, {
        sigil: ISSUE_SIGIL,
        partialName: ISSUE_PARTIAL_NAME,
        excludeBefore: EXCLUDE_BEFORE,
        suggest: suggestFor(ISSUE_SIGIL),
      }),
    );
    // Always registered; it suggests only where the Issue Host has merge requests.
    ctx.ui.addAutocompleteProvider((current): AutocompleteProvider => {
      const stacked = stackProseReferenceAutocomplete(current, {
        sigil: MERGE_REQUEST_SIGIL,
        partialName: MERGE_REQUEST_PARTIAL_NAME,
        excludeBefore: EXCLUDE_BEFORE,
        suggest: suggestFor(MERGE_REQUEST_SIGIL),
      });
      return {
        ...stacked,
        getSuggestions: (lines, cursorLine, cursorCol, options) =>
          (isBashMode(lines) ? current : stacked).getSuggestions(
            lines,
            cursorLine,
            cursorCol,
            options,
          ),
        applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
          (isBashMode(lines) ? current : stacked).applyCompletion(
            lines,
            cursorLine,
            cursorCol,
            item,
            prefix,
          ),
      };
    });
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !MAY_HOLD_ISSUE_REFERENCE.test(event.text)) {
      return { action: "continue" };
    }
    const lookup = await resolveIssueRepository(run, ctx.cwd, systemHostSources());
    const text = transformIssueReferences(event.text, lookup);
    if (text === event.text) return { action: "continue" };
    return event.images === undefined
      ? { action: "transform", text }
      : { action: "transform", text, images: event.images };
  });
}
