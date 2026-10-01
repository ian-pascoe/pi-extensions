import { fileURLToPath } from "node:url";

/** Absolute path of this package's user-invoked troubleshooting Skill. */
export const TROUBLESHOOTING_SKILL_PATH = fileURLToPath(
  new URL("../skills/pi-minimal-subagents/SKILL.md", import.meta.url),
);

/** Model-facing pointer appended to failures this package's Skill diagnoses. */
export const TROUBLESHOOTING_HINT = `For diagnosis, read the pi-minimal-subagents troubleshooting Skill at ${TROUBLESHOOTING_SKILL_PATH}.`;

/** Append the troubleshooting Skill pointer to a model-facing configuration or runtime failure. */
export function withTroubleshootingHint(message: string): string {
  return `${message}\n\n${TROUBLESHOOTING_HINT}`;
}
