import { describe, expect, it } from "vitest";
import { riskCategories, validRiskCategories } from "../src/guardian-assessment.js";
import { escalationInstruction, guardianSystemPrompt } from "../src/guardian-prompt.js";

describe("Guardian policy", () => {
  const prompt = guardianSystemPrompt("", false, validRiskCategories(false));

  it("starts from routine work and requires a Risk Category for high or critical risk", () => {
    expect(prompt).toContain(
      "Most Reviewed Calls are routine development work: score them `low` or `medium` unless a Risk Category below concretely applies.",
    );
    expect(prompt).toContain(
      "`high` and `critical` risk require one Risk Category that concretely applies to this exact call",
    );
    for (const category of riskCategories) expect(prompt).toContain(`- \`${category}\`: `);
    expect(riskCategories).toContain("security_policy");
    // `medium` always runs, so the policy never asks for `medium` while expecting a check.
    expect(prompt).not.toContain("at least `medium`");
  });

  it("names concrete categories for persistence and execution of unseen agent-written code", () => {
    expect(prompt).toMatch(
      /- `persistence`: establishing code that runs later.*shell startup files/s,
    );
    expect(prompt).toMatch(
      /- `unreviewed_execution`: executing code that the Guarded Agent wrote or modified in this session.*never to commands that only read/s,
    );
    expect(prompt).toMatch(
      /- `sensitive_path`: .*creating or replacing a link, or moving or renaming a file, onto a path that another call of the same tool batch writes/s,
    );
    // A link to a Sensitive Path is a risk on its own, so nested calls are covered too.
    expect(prompt).toMatch(
      /- `sensitive_path`: .*a symbolic or hard link whose target is a Sensitive Path or lies outside the workspace, whether or not another call writes through it/s,
    );
  });

  it("offers security_policy only when a Security Policy or deny Command Rule is configured", () => {
    expect(prompt).not.toContain('"security_policy"');
    const strict = guardianSystemPrompt("Never push.", false, validRiskCategories(true));
    expect(strict).toContain('| "security_policy"');
    expect(strict).toContain("# Security Policy\nNever push.");
  });

  it("shows the Guardian the agent's actions, not its reasoning, and explains delegations", () => {
    expect(prompt).toContain("the Guarded Agent's earlier tool calls (origin `agentToolCalls`");
    expect(prompt).toContain("It deliberately leaves out the agent's own text and reasoning");
    expect(prompt).toContain("An approved delegation is a Child Agent's task or message");
    expect(prompt).toContain(
      "Judge it by the actions the text asks for against the user's request",
    );
  });

  it("asks the Escalation Pass for careful reasoning and a rationale, without the first answer", () => {
    const instruction = escalationInstruction(validRiskCategories(false));
    expect(instruction).toContain("Reason step by step");
    expect(instruction).toContain("always including the rationale");
    expect(instruction).not.toContain("security_policy");
  });

  it("lists what is never a reason for high risk", () => {
    const never = prompt.slice(prompt.indexOf("# Never Reasons for `high`"));
    for (const reason of [
      "The size or complexity of a change",
      "A workspace file being security-relevant, core, or important when it is not a Sensitive Path",
      "Reading, searching, or listing anything, including `node_modules`, dependencies, and reference checkouts",
      "Running the project's established build, test, lint, format, or typecheck commands.",
      "Local, reversible git operations: status, log, diff, add, commit, branch, switch, stash.",
      "Modifying ordinary workspace files, whatever the mechanism",
      "Missing specific authorization",
      "The call coming from a Child Agent or an Advisor.",
    ])
      expect(never).toContain(reason);
  });

  it("asks for the category and rationale only on high or critical risk unless verbose", () => {
    expect(prompt).toContain("For `low` or `medium` risk, omit the category and the rationale:");
    expect(prompt).toContain(
      "For `high` or `critical` risk, include the Risk Category that applies and the rationale:",
    );
    expect(prompt).toContain(`"risk_category": "data_egress" | "credential_access"`);
    const verbose = guardianSystemPrompt("", true, validRiskCategories(false));
    expect(verbose).toContain("For `low` or `medium` risk, omit the category:");
    expect(verbose).toMatch(
      /\{"risk_level": [^\n]*"user_authorization": [^\n]*, "rationale": "<one or two concise sentences[^\n]*\}\nFor `high`/,
    );
    // Only the output contract differs, at the end of the cacheable system prompt.
    const shared = prompt.slice(0, prompt.indexOf("# Output"));
    expect(verbose.startsWith(shared)).toBe(true);
  });

  it("limits User Overrides to the exact call they name", () => {
    expect(prompt).toContain("A User Override authorizes only the one call it names");
  });
});
