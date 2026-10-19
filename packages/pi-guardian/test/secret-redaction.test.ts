import { describe, expect, it } from "vitest";
import type { ExtensionFactory, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { holdSecret, resolveSecret } from "@ian-pascoe/pi-utils/secret-registry";
import {
  assessment,
  createGuardianHarness,
  reply,
  toolCalls,
} from "./fixtures/guardian-harness.js";

const DeployArguments = Type.Object({ target: Type.String() });
const reviewer = { model: "guardian-test/reviewer" } as const;
const owner = { description: "guardian secret-redaction test" };

/** Resolves `{{secret:NAME}}` in `deploy` targets in place, as Pi Secret does. */
const resolver: ExtensionFactory = (pi) => {
  pi.on("tool_call", (event: ToolCallEvent) => {
    const { input } = event;
    if (event.toolName !== "deploy" || !Value.Check(DeployArguments, input)) return;
    input.target = input.target.replace(
      /\{\{secret:([A-Z0-9_]+)\}\}/g,
      (reference, name: string) => resolveSecret(name) ?? reference,
    );
  });
};

describe.each([
  ["before", "DEPLOY_TOKEN_BEFORE", "tok-before-8c1e77"],
  ["after", "DEPLOY_TOKEN_AFTER", "tok-after-3b90d2"],
] as const)("with Secret resolution loaded %s Guardian", (order, name, value) => {
  it("reviews and journals only the Secret Reference, and reports no argument drift", async () => {
    holdSecret(name, value, owner);
    const notices: string[] = [];
    const harness = await createGuardianHarness({
      guardianSettings: reviewer,
      ui: { notify: (text) => notices.push(text) },
      [order]: [resolver],
    });
    harness.responses.push(
      toolCalls(["deploy", { target: `{{secret:${name}}}` }, "call-1"]),
      reply("Ok."),
    );
    harness.guardianReplies.push(assessment("low", "high", "Requested."));
    await harness.session.prompt("Deploy with the token.");

    // The tool ran with the real value.
    expect(harness.executed).toEqual([`deploy:${value}`]);
    // Guardian's review model and audit journal never saw it.
    expect(harness.reviews).toHaveLength(1);
    expect(JSON.stringify(harness.reviews)).not.toContain(value);
    const journal = harness.entries("pi-guardian-review");
    expect(journal).toMatchObject([
      { result: "allowed", arguments: JSON.stringify({ target: `{{secret:${name}}}` }) },
    ]);
    expect(JSON.stringify(journal)).not.toContain(value);
    expect(journal[0]).not.toHaveProperty("argumentDrift");
    expect(notices.some((notice) => notice.includes("load Guardian last"))).toBe(false);
  });
});

it("redacts a held Secret quoted in the conversation from the review's evidence", async () => {
  const value = "tok-pasted-61b4e8";
  holdSecret("PASTED_TOKEN", value, owner);
  const harness = await createGuardianHarness({ guardianSettings: reviewer });
  harness.responses.push(toolCalls(["deploy", { target: "prod" }, "call-1"]), reply("Ok."));
  harness.guardianReplies.push(assessment("low", "high", "Requested."));
  await harness.session.prompt(`Deploy to prod; my token is ${value}.`);

  expect(harness.executed).toEqual(["deploy:prod"]);
  expect(harness.reviews).toHaveLength(1);
  const request = JSON.stringify(harness.reviews);
  expect(request).toContain("my token is {{secret:PASTED_TOKEN}}");
  expect(request).not.toContain(value);
});
