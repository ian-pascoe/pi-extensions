import type { VimEffect } from "./types.js";

const QUIT_COMMAND = /^(?:q|qa|quit|qall|quitall)(!?)$/u;

/**
 * Resolve an ex line typed after `:`.
 * Order: the quit family, then `:!cmd` shell dispatch, then known Pi commands; anything else is
 * reported as unsupported so a typo never reaches the model.
 */
export function resolveExCommand(
  line: string,
  prompt: string,
  isPiCommand: (name: string) => boolean,
): VimEffect | undefined {
  const command = line.trim();
  if (command === "") return undefined;
  const quit = QUIT_COMMAND.exec(command);
  if (quit) {
    if (quit[1] === "!" || prompt.trim() === "") return { kind: "quit" };
    return {
      kind: "notify",
      message: "The prompt has unsent text; use :q! to quit anyway.",
      level: "warning",
    };
  }
  if (command.startsWith("!")) {
    if (command.replace(/^!!?/u, "").trim() === "") {
      return { kind: "notify", message: `Unsupported ex command: ${command}`, level: "warning" };
    }
    return { kind: "dispatch", text: command };
  }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(command);
  const name = match?.[1] ?? command;
  const args = match?.[2]?.trim() ?? "";
  if (isPiCommand(name)) return { kind: "dispatch", text: args ? `/${name} ${args}` : `/${name}` };
  return { kind: "notify", message: `Unsupported ex command: ${command}`, level: "warning" };
}
