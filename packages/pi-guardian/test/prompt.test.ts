import { describe, expect, it } from "vite-plus/test";
import { validRiskCategories } from "../src/guardian-assessment.js";
import { guardianSystemPrompt } from "../src/guardian-prompt.js";

describe("Guardian policy", () => {
  const prompt = guardianSystemPrompt("", false, validRiskCategories(false));

  it("offers security_policy only when a Security Policy or deny Command Rule is configured", () => {
    expect(prompt).not.toContain('"security_policy"');
    const strict = guardianSystemPrompt("Never push.", false, validRiskCategories(true));
    expect(strict).toContain('| "security_policy"');
    expect(strict).toContain("# Security Policy\nNever push.");
  });

  it("changes only the output contract, at the end, when verbose", () => {
    const verbose = guardianSystemPrompt("", true, validRiskCategories(false));
    expect(verbose).not.toBe(prompt);
    // Only the output contract differs, at the end of the cacheable system prompt.
    const shared = prompt.slice(0, prompt.indexOf("# Output"));
    expect(verbose.startsWith(shared)).toBe(true);
  });
});
