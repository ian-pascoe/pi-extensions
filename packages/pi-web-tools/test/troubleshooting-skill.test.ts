import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { expect, test } from "vitest";
import { TROUBLESHOOTING_HINT, TROUBLESHOOTING_SKILL_PATH } from "../src/troubleshooting-skill.js";

test("troubleshooting Skill path is absolute and exists", async () => {
  expect(isAbsolute(TROUBLESHOOTING_SKILL_PATH)).toBe(true);
  await expect(access(TROUBLESHOOTING_SKILL_PATH)).resolves.toBeUndefined();
  expect(TROUBLESHOOTING_HINT).toContain(TROUBLESHOOTING_SKILL_PATH);
});
