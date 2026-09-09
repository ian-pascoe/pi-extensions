import { isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteProvider } from "@earendil-works/pi-tui";
import {
  getSkillReferencePrefix,
  transformSkillReferences,
  type Skill,
} from "./skill-references.js";

function getSkillCatalogue(pi: ExtensionAPI): Skill[] {
  return pi
    .getCommands()
    .filter(
      (command) =>
        command.source === "skill" &&
        command.name.startsWith("skill:") &&
        isAbsolute(command.sourceInfo.path),
    )
    .map((command) => {
      const skill: Skill = { name: command.name.slice(6), path: command.sourceInfo.path };
      if (command.description !== undefined) skill.description = command.description;
      return skill;
    });
}

function getEditorSkillPrefix(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): string | null {
  const cursorOffset = lines
    .slice(0, cursorLine)
    .reduce((offset, line) => offset + line.length + 1, cursorCol);
  return getSkillReferencePrefix(lines.join("\n"), cursorOffset);
}

function createSkillAutocompleteProvider(
  current: AutocompleteProvider,
  pi: ExtensionAPI,
): AutocompleteProvider {
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "$"])],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const prefix = getEditorSkillPrefix(lines, cursorLine, cursorCol);
      if (prefix === null) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (options.signal.aborted) return null;
      const items = fuzzyFilter(getSkillCatalogue(pi), prefix.slice(1), (skill) => skill.name).map(
        (skill) => ({
          value: `$${skill.name}`,
          label: `$${skill.name}`,
          description: skill.description ?? "",
        }),
      );
      return items.length === 0 ? null : { prefix, items };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (
        !item.value.startsWith("$") ||
        prefix !== getEditorSkillPrefix(lines, cursorLine, cursorCol)
      ) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }
      const line = lines[cursorLine] ?? "";
      const beforePrefix = line.slice(0, cursorCol - prefix.length);
      const completed = [...lines];
      completed[cursorLine] = `${beforePrefix}${item.value} ${line.slice(cursorCol)}`;
      return {
        lines: completed,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 1,
      };
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export default function skillsSelectorExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(current, pi));
  });

  pi.on("input", (event) => {
    if (event.source === "extension") return { action: "continue" };
    const text = transformSkillReferences(event.text, getSkillCatalogue(pi));
    if (text === event.text) return { action: "continue" };
    return event.images === undefined
      ? { action: "transform", text }
      : { action: "transform", text, images: event.images };
  });
}
