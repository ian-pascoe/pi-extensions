import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { TROUBLESHOOTING_HINT, TROUBLESHOOTING_SKILL_PATH } from "../src/troubleshooting-skill.js";

describe("troubleshooting Skill hint", () => {
  test("points at the shipped user-invoked Skill", () => {
    expect(existsSync(TROUBLESHOOTING_SKILL_PATH)).toBe(true);
    expect(readFileSync(TROUBLESHOOTING_SKILL_PATH, "utf8")).toContain("name: pi-dap");
    expect(TROUBLESHOOTING_HINT).toContain(TROUBLESHOOTING_SKILL_PATH);
  });

  test("diagnoses the js-debug entry breakpoint that re-stops inside the first function", () => {
    const skill = readFileSync(TROUBLESHOOTING_SKILL_PATH, "utf8");
    expect(skill).toContain("stopOnEntry");
    expect(skill).toContain("hit breakpoint ids");
  });
});
