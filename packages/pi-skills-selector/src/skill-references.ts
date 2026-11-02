import { isAbsolute } from "node:path";
import { replaceProseReferences } from "@ian-pascoe/pi-utils/prose-references";

export interface Skill {
  name: string;
  path: string;
  description?: string;
}

export const SKILL_SIGIL = "$";

/** Characters a partially typed Skill name may hold; Pi reports but loads odd names. */
export const SKILL_PARTIAL_NAME = "[^\\s$[\\]()`*~<>]*";

export function transformSkillReferences(text: string, skills: readonly Skill[]): string {
  const catalogue = new Map(skills.map((skill) => [skill.name, skill.path]));
  const names = [...catalogue.keys()]
    .filter((name) => name.length > 0)
    .sort((left, right) => right.length - left.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (names.length === 0) return text;
  return replaceProseReferences(text, {
    sigil: SKILL_SIGIL,
    name: names.join("|"),
    resolve: (name) => {
      const path = catalogue.get(name);
      if (path === undefined || !isAbsolute(path) || !path.isWellFormed()) return undefined;
      const destination = encodeURI(path).replace(
        /[?#()]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      return `[${SKILL_SIGIL}${name}](${destination})`;
    },
  });
}
