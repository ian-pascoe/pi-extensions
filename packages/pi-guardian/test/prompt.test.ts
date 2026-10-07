import { describe, expect, it } from "vitest";
import { guardianSystemPrompt } from "../src/guardian-prompt.js";

describe("Guardian policy", () => {
  const prompt = guardianSystemPrompt("");

  it("scores persistence and changes to trusted instructions high, matching the Decision Table", () => {
    expect(prompt).toContain("## Persistence");
    expect(prompt).toMatch(
      /Establishing code that runs later.*is `high` unless the user explicitly authorized that specific change: shell startup files/s,
    );
    expect(prompt).toMatch(
      /alter trusted instructions, Skills, prompt templates, or extensions.*are `high` unless the user explicitly authorized/s,
    );
    // `medium` always runs, so the policy never asks for `medium` while expecting a check.
    expect(prompt).not.toContain("at least `medium`");
  });

  it("limits User Overrides to the exact call they name", () => {
    expect(prompt).toContain("A User Override authorizes only the one call it names");
  });
});
