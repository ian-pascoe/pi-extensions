import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { TROUBLESHOOTING_HINT } from "../src/troubleshooting-skill.js";
import {
  assessment,
  createGuardianHarness,
  DeferredReply,
  reply,
  toolCalls,
} from "./fixtures/guardian-harness.js";

beforeAll(() => initTheme("dark"));

type Harness = Awaited<ReturnType<typeof createGuardianHarness>>;

function resultText(harness: Harness, toolCallId: string): string | undefined {
  for (const message of harness.session.messages)
    if (message.role === "toolResult" && message.toolCallId === toolCallId)
      return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  return undefined;
}

/** The text blocks of a captured Guardian request's single user message. */
function blocks(harness: Harness, index: number): string[] {
  const message = harness.reviews[index]?.messages[0];
  if (message?.role !== "user" || !Array.isArray(message.content)) return [];
  return message.content.map((part) => (part.type === "text" ? part.text : ""));
}

const reviewer = { model: "guardian-test/reviewer" } as const;

describe("Review Failure", () => {
  it("blocks without UI, ending with the troubleshooting hint", async () => {
    const harness = await createGuardianHarness({ guardianSettings: reviewer });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    harness.verdicts.push("I think this is fine.");
    await harness.session.prompt("Deploy a.");

    expect(harness.executed).toEqual([]);
    const text = resultText(harness, "call-1");
    expect(text).toMatch(
      /^Guardian could not review this deploy call, so it was blocked: Guardian returned malformed output/,
    );
    expect(text?.endsWith(TROUBLESHOOTING_HINT)).toBe(true);
    expect(harness.entries("pi-guardian-review")).toMatchObject([
      { outcome: "failed", blocked: true, userOverride: false },
    ]);
  });

  it.each([
    [
      "an unknown model",
      { model: "guardian-test/missing" },
      undefined,
      /Guardian model guardian-test\/missing was not found/,
    ],
    [
      "a provider error",
      reviewer,
      new Error("rate limited"),
      /Guardian model request failed: rate limited/,
    ],
    [
      "a timeout",
      { ...reviewer, reviewTimeoutMs: 20 },
      new DeferredReply(
        (options) =>
          new Promise((_resolve, reject) =>
            options?.signal?.addEventListener("abort", () => reject(new Error("stopped"))),
          ),
      ),
      /Guardian Review timed out after 0.02s/,
    ],
  ] as const)("treats %s as a Review Failure", async (_case, settings, verdict, failure) => {
    const harness = await createGuardianHarness({ guardianSettings: settings });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    if (verdict) harness.verdicts.push(verdict);
    await harness.session.prompt("Deploy a.");
    expect(harness.executed).toEqual([]);
    expect(resultText(harness, "call-1")).toMatch(failure);
  });

  it("asks an interactive user and runs the call once on a User Override", async () => {
    const titles: string[] = [];
    const harness = await createGuardianHarness({
      guardianSettings: reviewer,
      ui: {
        select: async (title, options) => {
          titles.push(title);
          return options.find((option) => option === "Allow once");
        },
      },
    });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    harness.verdicts.push(new Error("provider down"));
    await harness.session.prompt("Deploy a.");

    expect(titles[0]).toMatch(
      /^Guardian could not review deploy: Guardian model request failed: provider down/,
    );
    expect(harness.executed).toEqual(["deploy:a"]);
    expect(harness.entries("pi-guardian-review")).toMatchObject([
      { outcome: "failed", userOverride: true, blocked: false },
    ]);
  });

  it("blocks when the interactive user chooses Block", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: reviewer,
      ui: { select: async () => "Block" },
    });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    harness.verdicts.push(new Error("provider down"));
    await harness.session.prompt("Deploy a.");
    expect(harness.executed).toEqual([]);
    expect(resultText(harness, "call-1")).toMatch(/^Guardian could not review this deploy call/);
  });

  it("fails closed when settings are invalid", async () => {
    const harness = await createGuardianHarness({
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: deliberately invalid authored settings exercise the fail-closed path.
      guardianSettings: { onDeny: "maybe" } as never,
    });
    harness.responses.push(
      toolCalls(["lookup", { query: "q" }, "call-0"], ["deploy", { target: "a" }, "call-1"]),
      reply("Ok."),
    );
    await harness.session.prompt("Deploy a.");
    expect(harness.reviews).toHaveLength(0);
    expect(harness.executed).toEqual(["lookup:q"]);
    expect(resultText(harness, "call-1")).toMatch(
      /Guardian settings are unavailable: Invalid global Guardian settings/,
    );
  });
});

describe("Guardian Review lifecycle", () => {
  it("blocks an aborted review as aborted, not as a Review Failure", async () => {
    let harness: Harness | undefined;
    harness = await createGuardianHarness({ guardianSettings: reviewer });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]));
    harness.verdicts.push(
      new DeferredReply(
        (options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            void harness?.session.abort();
          }),
      ),
    );
    await harness.session.prompt("Deploy a.");
    expect(harness.executed).toEqual([]);
    expect(harness.entries("pi-guardian-review")).toMatchObject([
      { outcome: "aborted", blocked: true },
    ]);
  });

  it("denies a tool by Tool Policy without a model call", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { ...reviewer, tools: { deploy: "deny" } },
    });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    await harness.session.prompt("Deploy a.");
    expect(harness.reviews).toHaveLength(0);
    expect(resultText(harness, "call-1")).toMatch(/denied by Guardian's Tool Policy/);
  });

  it("does nothing when disabled", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { ...reviewer, enabled: false, tools: { deploy: "deny" } },
    });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    await harness.session.prompt("Deploy a.");
    expect(harness.reviews).toHaveLength(0);
    expect(harness.executed).toEqual(["deploy:a"]);
  });

  it("ends the turn when the Rejection Streak reaches its limit and resets per request", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { ...reviewer, maxConsecutiveRejections: 2 },
    });
    const reject = assessment("critical", "unknown", "Exfiltration.");
    harness.responses.push(
      toolCalls(["deploy", { target: "a" }, "call-1"]),
      toolCalls(["deploy", { target: "b" }, "call-2"]),
      reply("never requested"),
    );
    harness.verdicts.push(reject, reject);
    await harness.session.prompt("Deploy.");
    // The second Rejection ended the turn: no third model request.
    expect(harness.agentRequests).toHaveLength(2);
    expect(harness.responses).toHaveLength(1);

    harness.responses.splice(0);
    harness.responses.push(toolCalls(["deploy", { target: "c" }, "call-3"]), reply("Ok."));
    harness.verdicts.push(reject);
    await harness.session.prompt("Try again.");
    // A new request starts a new streak: one Rejection does not end the turn.
    expect(harness.agentRequests).toHaveLength(4);
  });

  it("reviews parallel calls concurrently", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { ...reviewer, reviewTimeoutMs: 5_000 },
    });
    let started = 0;
    let release: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const concurrent = new DeferredReply(async () => {
      if (++started === 2) release();
      await bothStarted;
      return assessment("low", "high", "Requested.");
    });
    harness.verdicts.push(concurrent, concurrent);
    harness.responses.push(
      toolCalls(["deploy", { target: "a" }, "call-a"], ["deploy", { target: "b" }, "call-b"]),
      reply("Ok."),
    );
    await harness.session.prompt("Deploy a and b.");
    expect(harness.executed.toSorted()).toEqual(["deploy:a", "deploy:b"]);
    expect(harness.reviews).toHaveLength(2);
    // Both requests share their evidence; only the Reviewed Call differs.
    expect(blocks(harness, 0).slice(0, -1)).toEqual(blocks(harness, 1).slice(0, -1));
    // Reviews started when the response ended already see that response's tool calls.
    expect(blocks(harness, 0).at(-2)).toMatch(
      /^Evidence \(UNTRUSTED, origin: assistant\):\n.*"name":"deploy"/s,
    );
  });

  it("reviews nested calls on their own with the issuing call as context", async () => {
    const harness = await createGuardianHarness({ guardianSettings: reviewer });
    harness.responses.push(
      toolCalls(["script", { targets: ["a", "b"] }, "call-script"]),
      reply("Ok."),
    );
    harness.verdicts.push(
      assessment("low", "high", "Requested."),
      assessment("high", "unknown", "Not requested."),
    );
    await harness.session.prompt("Deploy a.");
    expect(harness.executed).toEqual(["deploy:a"]);
    expect(resultText(harness, "call-script")).toBe("ran,blocked");
    expect(blocks(harness, 1).at(-1)).toContain(
      'Issued by tool call: script\nIssuing call arguments: {"targets":["a","b"]}',
    );
    expect(harness.entries("pi-guardian-review")).toMatchObject([
      { toolName: "deploy", parentToolCallId: "call-script", outcome: "allowed" },
      { toolName: "deploy", parentToolCallId: "call-script", outcome: "rejected" },
    ]);
  });

  it("records a User Override after a Rejection and weighs it as Trusted Evidence later", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { ...reviewer, onDeny: "ask" },
      ui: { select: async () => "Allow once" },
    });
    harness.responses.push(
      toolCalls(["deploy", { target: "prod" }, "call-1"]),
      toolCalls(["deploy", { target: "prod2" }, "call-2"]),
      reply("Ok."),
    );
    harness.verdicts.push(
      assessment("high", "low", "Production."),
      assessment("low", "high", "Ok."),
    );
    await harness.session.prompt("Deploy.");
    expect(harness.executed).toEqual(["deploy:prod", "deploy:prod2"]);
    expect(harness.entries("pi-guardian-review")[0]).toMatchObject({
      outcome: "rejected",
      userOverride: true,
      blocked: false,
    });
    const override = blocks(harness, 1).find((block) => block.includes("origin: userOverride"));
    expect(override).toMatch(/^Evidence \(TRUSTED, origin: userOverride\)/);
    expect(override).toContain(
      'the user interactively allowed deploy with arguments {\\"target\\":\\"prod\\"} after a high-risk Rejection (Production.)',
    );
  });

  it("warns when an extension loaded after Guardian changes reviewed arguments", async () => {
    const notices: string[] = [];
    const harness = await createGuardianHarness({
      guardianSettings: reviewer,
      ui: { notify: (text) => notices.push(text) },
      after: [
        (pi) => {
          pi.on("tool_call", (event: ToolCallEvent) => {
            if (event.toolName === "deploy") event.input["target"] = "rewritten";
          });
        },
      ],
    });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    harness.verdicts.push(assessment("low", "high", "Requested."));
    await harness.session.prompt("Deploy a.");
    expect(harness.executed).toEqual(["deploy:rewritten"]);
    expect(harness.entries("pi-guardian-review")).toMatchObject([{ argumentDrift: true }]);
    expect(notices.some((notice) => notice.includes("load Guardian last"))).toBe(true);
  });

  it("shows idle and reviewing footer states", async () => {
    const statuses: (string | undefined)[] = [];
    const harness = await createGuardianHarness({
      guardianSettings: reviewer,
      ui: { setStatus: (_key, text) => statuses.push(text && stripVTControlCharacters(text)) },
    });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    harness.verdicts.push(assessment("low", "high", "Requested."));
    await harness.session.prompt("Deploy a.");
    expect(statuses).toContain("guardian");
    expect(statuses).toContain("guardian: reviewing deploy");
    expect(statuses.at(-1)).toBe("guardian");
  });
});
