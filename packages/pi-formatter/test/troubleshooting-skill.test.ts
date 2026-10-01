import { access } from "node:fs/promises";
import { expect, test } from "vitest";
import { TROUBLESHOOTING_HINT, TROUBLESHOOTING_SKILL_PATH } from "../src/troubleshooting-skill.js";

test("troubleshooting Skill path exists and is named in the hint", async () => {
  await expect(access(TROUBLESHOOTING_SKILL_PATH)).resolves.toBeUndefined();
  expect(TROUBLESHOOTING_HINT).toContain(TROUBLESHOOTING_SKILL_PATH);
});
