import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { TROUBLESHOOTING_HINT, TROUBLESHOOTING_SKILL_PATH } from "../src/troubleshooting-skill.js";

test("troubleshooting hint points at the shipped Skill", () => {
  expect(existsSync(TROUBLESHOOTING_SKILL_PATH)).toBe(true);
  expect(TROUBLESHOOTING_HINT).toContain(TROUBLESHOOTING_SKILL_PATH);
});
