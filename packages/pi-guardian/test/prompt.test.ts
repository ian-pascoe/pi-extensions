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

  it("keeps ordinary workspace edits low or medium whatever the mechanism or size", () => {
    expect(prompt).toContain(
      "Modifying ordinary, non-sensitive files in the workspace is `low` or `medium` whatever the mechanism: the edit tool, a script, `sed`, or code generation.",
    );
    expect(prompt).toContain(
      "That the user did not specify this exact implementation, or that the change is large, does not by itself raise the risk to `high`",
    );
    expect(prompt).toMatch(
      /Reserve it for destructive or hard-to-reverse effects, persistence, Sensitive Paths, weakening safety configuration, and sensitive egress/,
    );
  });

  it("asks for a rationale only on high or critical risk unless verbose", () => {
    expect(prompt).toContain("For `low` or `medium` risk, omit the rationale:");
    expect(prompt).toContain("For `high` or `critical` risk, include it:");
    const verbose = guardianSystemPrompt("", true);
    expect(verbose).not.toContain("omit the rationale");
    expect(verbose).toMatch(
      /"user_authorization": .*, "rationale": "<one or two concise sentences/,
    );
    // Only the output contract differs, at the end of the cacheable system prompt.
    const shared = prompt.slice(0, prompt.indexOf("# Output"));
    expect(verbose.startsWith(shared)).toBe(true);
  });

  it("limits User Overrides to the exact call they name", () => {
    expect(prompt).toContain("A User Override authorizes only the one call it names");
  });
});
