import { isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { stackProseReferenceAutocomplete } from "@ian-pascoe/pi-utils/prose-references";
import {
  SKILL_PARTIAL_NAME,
  SKILL_SIGIL,
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

function createSkillAutocompleteProvider(
  current: AutocompleteProvider,
  pi: ExtensionAPI,
): AutocompleteProvider {
  return stackProseReferenceAutocomplete(current, {
    sigil: SKILL_SIGIL,
    partialName: SKILL_PARTIAL_NAME,
    suggest: (query) =>
      fuzzyFilter(getSkillCatalogue(pi), query, (skill) => skill.name).map((skill) => ({
        value: `${SKILL_SIGIL}${skill.name}`,
        label: `${SKILL_SIGIL}${skill.name}`,
        description: skill.description ?? "",
      })),
  });
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
