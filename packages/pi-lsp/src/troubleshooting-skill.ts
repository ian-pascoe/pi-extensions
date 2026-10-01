import { fileURLToPath } from "node:url";

/** Absolute path of this package's user-invoked troubleshooting Skill. */
export const TROUBLESHOOTING_SKILL_PATH = fileURLToPath(
  new URL("../skills/pi-lsp/SKILL.md", import.meta.url),
);

/** Model-facing pointer appended to failures this package's Skill diagnoses. */
export const TROUBLESHOOTING_HINT = `For diagnosis, read the pi-lsp troubleshooting Skill at ${TROUBLESHOOTING_SKILL_PATH}.`;
