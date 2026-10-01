import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

/**
 * Pi's built-in slash commands. `pi.getCommands()` reports only extension, prompt, and skill
 * commands, and the SDK does not export its built-in list; a test pins this copy against it.
 */
export const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "settings",
  "model",
  "tree",
  "thinking",
  "scoped-models",
  "export",
  "import",
  "share",
  "bug",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
]);

export function isPiCommand(name: string, commands: readonly SlashCommandInfo[]): boolean {
  return BUILTIN_COMMAND_NAMES.has(name) || commands.some((command) => command.name === name);
}
