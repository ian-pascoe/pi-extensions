import type { AutocompleteItem } from "@earendil-works/pi-tui";

const SUBAGENTS_COMMAND_USAGE =
  "Usage: /subagents [status | enable|disable|reset [--global|--project]]";

/** A parsed `/subagents` command accepted by the finite user-facing grammar. */
export type SubagentsCommand =
  | { readonly action: "status" }
  | {
      readonly action: "enable" | "disable" | "reset";
      readonly scope: "session" | "global" | "project";
    };

/** The parse result keeps invalid command input out of lifecycle policy. */
export type ParseSubagentsCommandResult =
  | { readonly ok: true; readonly command: SubagentsCommand }
  | { readonly ok: false; readonly message: string };

const SUBAGENTS_COMMAND_COMPLETION_DETAILS = [
  ["status", "Show live Child Agent status"],
  ["enable", "Enable for this branch"],
  ["enable --global", "Enable by default globally"],
  ["enable --project", "Enable by default for this project"],
  ["disable", "Disable for this branch"],
  ["disable --global", "Disable by default globally"],
  ["disable --project", "Disable by default for this project"],
  ["reset", "Follow settings for this branch"],
  ["reset --global", "Remove the global default"],
  ["reset --project", "Remove the project default"],
] as const;

const COMMAND_COMPLETIONS: readonly AutocompleteItem[] = SUBAGENTS_COMMAND_COMPLETION_DETAILS.map(
  ([value, description]) => ({ value, label: value, description }),
);

/** Parse the exact `/subagents` argument grammar without accepting extra operands. */
export function parseSubagentsCommandArguments(input: string): ParseSubagentsCommandResult {
  const normalized = input.trim().replace(/\s+/g, " ");
  if (normalized === "" || normalized === "status") {
    return { ok: true, command: { action: "status" } };
  }

  const [action, flag, ...extra] = normalized.split(" ");
  if (
    extra.length > 0 ||
    (action !== "enable" && action !== "disable" && action !== "reset") ||
    (flag !== undefined && flag !== "--global" && flag !== "--project")
  ) {
    return { ok: false, message: SUBAGENTS_COMMAND_USAGE };
  }
  return {
    ok: true,
    command: {
      action,
      scope: flag === "--global" ? "global" : flag === "--project" ? "project" : "session",
    },
  };
}

/** Complete only command tails that the strict `/subagents` parser accepts. */
export function completeSubagentsCommandArguments(prefix: string): AutocompleteItem[] {
  return COMMAND_COMPLETIONS.filter((completion) => completion.value.startsWith(prefix));
}
