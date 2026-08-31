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

const COMMAND_COMPLETIONS: readonly AutocompleteItem[] = [
  { value: "status", label: "status", description: "Show live Child Agent status" },
  { value: "enable", label: "enable", description: "Enable for this branch" },
  {
    value: "enable --global",
    label: "enable --global",
    description: "Enable by default globally",
  },
  {
    value: "enable --project",
    label: "enable --project",
    description: "Enable by default for this project",
  },
  { value: "disable", label: "disable", description: "Disable for this branch" },
  {
    value: "disable --global",
    label: "disable --global",
    description: "Disable by default globally",
  },
  {
    value: "disable --project",
    label: "disable --project",
    description: "Disable by default for this project",
  },
  { value: "reset", label: "reset", description: "Follow settings for this branch" },
  {
    value: "reset --global",
    label: "reset --global",
    description: "Remove the global default",
  },
  {
    value: "reset --project",
    label: "reset --project",
    description: "Remove the project default",
  },
];

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
