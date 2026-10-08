import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { argumentsHash } from "../src/guardian-evidence.js";
import { correctiveMessage } from "../src/guardian-review.js";
import { TROUBLESHOOTING_HINT } from "../src/troubleshooting-skill.js";
import {
  assessment,
  confirmedRejection,
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
    harness.guardianReplies.push("I think this is fine.", "Still fine.");
    await harness.session.prompt("Deploy a.");

    expect(harness.executed).toEqual([]);
    const text = resultText(harness, "call-1");
    expect(text).toMatch(
      /^Guardian could not review this deploy call, so it was blocked: Guardian returned malformed output .*, even after a corrective retry/,
    );
    expect(text?.endsWith(TROUBLESHOOTING_HINT)).toBe(true);
    expect(harness.entries("pi-guardian-review")).toMatchObject([
      { result: "failed", blocked: true, userOverride: false, retried: true },
    ]);
    expect(harness.reviews).toHaveLength(2);
  });

  it("retries a malformed reply once with the output contract, then allows a valid one", async () => {
    const harness = await createGuardianHarness({ guardianSettings: reviewer });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    harness.guardianReplies.push("Looks fine to me.", assessment("low", "high", "Requested."));
    await harness.session.prompt("Deploy a.");

    expect(harness.executed).toEqual(["deploy:a"]);
    const [first, retry] = harness.reviews;
    // The first request is unchanged; the retry extends it with the bad reply and the contract.
    expect(first?.messages).toHaveLength(1);
    expect(retry?.systemPrompt).toBe(first?.systemPrompt);
    expect(retry?.messages[0]).toEqual(first?.messages[0]);
    expect(retry?.messages[1]).toMatchObject({ role: "assistant" });
    expect(retry?.messages[2]).toMatchObject({ role: "user", content: correctiveMessage });
    expect(harness.entries("pi-guardian-review")).toMatchObject([
      { result: "allowed", retried: true, usage: { input: 2_000 } },
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
  ] as const)("treats %s as a Review Failure", async (_case, settings, scripted, failure) => {
    const harness = await createGuardianHarness({ guardianSettings: settings });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    if (scripted) harness.guardianReplies.push(scripted);
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
    harness.guardianReplies.push(new Error("provider down"));
    await harness.session.prompt("Deploy a.");

    expect(titles[0]).toMatch(
      /^Guardian could not review deploy: Guardian model request failed: provider down/,
    );
    expect(harness.executed).toEqual(["deploy:a"]);
    expect(harness.entries("pi-guardian-review")).toMatchObject([
      { result: "failed", userOverride: true, blocked: false },
    ]);
  });

  it("blocks when the interactive user chooses Block", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: reviewer,
      ui: { select: async () => "Block" },
    });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    harness.guardianReplies.push(new Error("provider down"));
    await harness.session.prompt("Deploy a.");
    expect(harness.executed).toEqual([]);
    expect(resultText(harness, "call-1")).toMatch(/^Guardian could not review this deploy call/);
  });

  it("fails closed when settings are invalid, running only built-in read-only tools", async () => {
    const notices: string[] = [];
    const harness = await createGuardianHarness({
      builtinTools: true,
      ui: { notify: (text) => notices.push(text), select: async () => "Block" },
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: deliberately invalid authored settings exercise the fail-closed path.
      guardianSettings: { onDeny: "maybe", tools: { deploy: "deny" } } as never,
    });
    harness.responses.push(
      toolCalls(
        ["ls", { path: "." }, "call-ls"],
        ["lookup", { query: "q" }, "call-0"],
        ["deploy", { target: "a" }, "call-1"],
        ["write", { path: "notes.txt", content: "x" }, "call-2"],
      ),
      reply("Ok."),
    );
    await harness.session.prompt("Deploy a.");
    expect(harness.reviews).toHaveLength(0);
    // Neither the defaults' allow rules nor the unreadable deny rule apply: only reads run.
    expect(harness.executed).toEqual([]);
    expect(resultText(harness, "call-ls")).not.toMatch(/Guardian/);
    for (const id of ["call-0", "call-1", "call-2"])
      expect(resultText(harness, id)).toMatch(
        /Guardian settings are unavailable: Invalid global Guardian settings/,
      );
    expect(notices.some((notice) => notice.includes("Invalid global Guardian settings"))).toBe(
      true,
    );
  });
});

describe("Guardian Review lifecycle", () => {
  it("blocks an aborted review as aborted, not as a Review Failure", async () => {
    let harness: Harness | undefined;
    harness = await createGuardianHarness({ guardianSettings: reviewer });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]));
    harness.guardianReplies.push(
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
      { result: "aborted", blocked: true },
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

  it("is disabled until a setting enables it", async () => {
    const harness = await createGuardianHarness({ guardianSettings: null });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    await harness.session.prompt("Deploy a.");
    expect(harness.reviews).toHaveLength(0);
    expect(harness.executed).toEqual(["deploy:a"]);
    await harness.session.prompt("/guardian status");
    expect(harness.entries("pi-guardian-status").at(-1)).toMatchObject({
      state: "disabled",
      sources: { enabled: "default" },
    });
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
    const reject = confirmedRejection("critical", "unknown", "Exfiltration.");
    harness.responses.push(
      toolCalls(["deploy", { target: "a" }, "call-1"]),
      toolCalls(["deploy", { target: "b" }, "call-2"]),
      reply("never requested"),
    );
    harness.guardianReplies.push(...reject, ...reject);
    await harness.session.prompt("Deploy.");
    // The second Rejection ended the turn: no third model request.
    expect(harness.agentRequests).toHaveLength(2);
    expect(harness.responses).toHaveLength(1);

    harness.responses.splice(0);
    harness.responses.push(toolCalls(["deploy", { target: "c" }, "call-3"]), reply("Ok."));
    harness.guardianReplies.push(...reject);
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
    harness.guardianReplies.push(concurrent, concurrent);
    harness.responses.push(
      toolCalls(["deploy", { target: "a" }, "call-a"], ["deploy", { target: "b" }, "call-b"]),
      reply("Ok."),
    );
    await harness.session.prompt("Deploy a and b.");
    expect(harness.executed.toSorted()).toEqual(["deploy:a", "deploy:b"]);
    expect(harness.reviews).toHaveLength(2);
    // Both requests share their evidence; only the Reviewed Call differs.
    expect(blocks(harness, 0).slice(0, -1)).toEqual(blocks(harness, 1).slice(0, -1));
    // The response's own calls appear only as the Reviewed Call and its batch, not as evidence.
    expect(blocks(harness, 0).slice(0, -1).join("\n")).not.toContain('"name":"deploy"');
    expect(blocks(harness, 0).at(-1)).toContain('- "deploy" with arguments {"target":"b"}');
  });

  it("reviews nested calls on their own with the issuing call as context", async () => {
    const harness = await createGuardianHarness({ guardianSettings: reviewer });
    harness.responses.push(
      toolCalls(["script", { targets: ["a", "b"] }, "call-script"]),
      reply("Ok."),
    );
    harness.guardianReplies.push(
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
      { toolName: "deploy", parentToolCallId: "call-script", result: "allowed" },
      { toolName: "deploy", parentToolCallId: "call-script", result: "rejected" },
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
    harness.guardianReplies.push(
      ...confirmedRejection("high", "low", "Production."),
      assessment("low", "high", "Ok."),
    );
    await harness.session.prompt("Deploy.");
    expect(harness.executed).toEqual(["deploy:prod", "deploy:prod2"]);
    expect(harness.entries("pi-guardian-review")[0]).toMatchObject({
      result: "rejected",
      userOverride: true,
      blocked: false,
    });
    const override = blocks(harness, 2).find((block) => block.includes("origin: userOverride"));
    expect(override).toMatch(/^Evidence \(TRUSTED, origin: userOverride\)/);
    const [, json = ""] = override?.split("\n") ?? [];
    const record = JSON.parse(JSON.parse(json).content);
    expect(record.userOverride).toMatchObject({
      tool: "deploy",
      argumentsSha256: argumentsHash({ target: "prod" }),
      agentAuthoredArguments: '{"target":"prod"}',
    });
    expect(override).not.toContain("Production.");
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
    harness.guardianReplies.push(assessment("low", "high", "Requested."));
    await harness.session.prompt("Deploy a.");
    expect(harness.executed).toEqual(["deploy:rewritten"]);
    expect(harness.entries("pi-guardian-review")).toMatchObject([{ argumentDrift: true }]);
    expect(notices.some((notice) => notice.includes("load Guardian last"))).toBe(true);
  });

  it.each([false, true])(
    "with verbose %s, asks for rationales and shows allowed reviews accordingly",
    async (verbose) => {
      const harness = await createGuardianHarness({ guardianSettings: { ...reviewer, verbose } });
      harness.responses.push(
        toolCalls(["deploy", { target: "a" }, "call-1"]),
        toolCalls(["deploy", { target: "prod" }, "call-2"]),
        reply("Ok."),
      );
      harness.guardianReplies.push(
        JSON.stringify({ risk_level: "low", user_authorization: "high" }),
        JSON.stringify({
          risk_level: "high",
          user_authorization: "low",
          risk_category: "destruction",
        }),
      );
      await harness.session.prompt("Deploy a.");
      expect(harness.executed).toEqual(["deploy:a"]);
      expect(harness.reviews[0]?.systemPrompt.includes("omit the category and the rationale")).toBe(
        !verbose,
      );
      // A high-risk assessment without a rationale still rejects, with a fixed reason.
      expect(resultText(harness, "call-2")).toContain(
        "Reason: The Guardian gave no specific rationale.",
      );
      const runner = harness.session.extensionRunner;
      const renderer = runner?.getEntryRenderer("pi-guardian-review");
      const theme = runner?.getUIContext().theme;
      if (!renderer || !theme) throw new Error("Missing review renderer");
      const rendered = harness.session.sessionManager
        .getBranch()
        .flatMap((entry) =>
          entry.type === "custom" && entry.customType === "pi-guardian-review" ? [entry] : [],
        )
        .map((entry) => renderer(entry, { expanded: false }, theme) !== undefined);
      // The allowed review shows only when verbose; the Rejection always shows.
      expect(rendered).toEqual([verbose, true]);
    },
  );

  it("decides an uncategorized high or critical assessment as medium, and records it", async () => {
    const harness = await createGuardianHarness({ guardianSettings: reviewer });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    const uncategorized = assessment(
      "critical",
      "unknown",
      "It edits a core security module.",
      "core_module",
    );
    harness.guardianReplies.push(uncategorized, uncategorized);
    await harness.session.prompt("Deploy a.");
    expect(harness.executed).toEqual(["deploy:a"]);
    // One corrective retry restated the Risk Categories before the downgrade.
    const retry = harness.reviews[1]?.messages.at(-1);
    expect(retry?.role === "user" ? retry.content : "").toEqual(
      expect.stringContaining("without naming a valid Risk Category"),
    );
    const [entry] = harness.entries("pi-guardian-review");
    expect(entry).toMatchObject({
      result: "allowed",
      risk: "critical",
      downgraded: true,
      retried: true,
    });
    expect(entry).not.toHaveProperty("riskCategory");
  });

  it("asks again for a missing Risk Category and decides by the corrected answer", async () => {
    const harness = await createGuardianHarness({ guardianSettings: reviewer });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    harness.guardianReplies.push(
      JSON.stringify({
        risk_level: "high",
        user_authorization: "low",
        risk_category: null,
        rationale: null,
      }),
      // Case and hyphen variants name the same Risk Category.
      ...confirmedRejection("high", "low", "Wipes data.", "Destruction"),
    );
    await harness.session.prompt("Deploy a.");
    expect(harness.executed).toEqual([]);
    expect(harness.entries("pi-guardian-review")).toMatchObject([
      { result: "rejected", riskCategory: "destruction", retried: true },
    ]);
  });

  it("names the Risk Category and a fixed reason in the warning and the dialog", async () => {
    const notices: string[] = [];
    const titles: string[] = [];
    const harness = await createGuardianHarness({
      guardianSettings: { ...reviewer, onDeny: "ask" },
      ui: {
        notify: (text) => notices.push(text),
        select: async (title) => {
          titles.push(title);
          return "Block";
        },
      },
    });
    harness.responses.push(toolCalls(["deploy", { target: "prod" }, "call-1"]), reply("Ok."));
    harness.guardianReplies.push(
      JSON.stringify({
        risk_level: "critical",
        user_authorization: "unknown",
        risk_category: "data_egress",
      }),
    );
    await harness.session.prompt("Deploy.");
    expect(harness.executed).toEqual([]);
    expect(notices).toContain(
      "Guardian: rejected deploy (critical (data_egress) risk): The Guardian gave no specific rationale.",
    );
    expect(titles[0]).toMatch(
      /^Guardian rejected deploy \u2014 risk critical \(data_egress\), authorization unknown\nThe Guardian gave no specific rationale\./,
    );
    expect(resultText(harness, "call-1")).toContain(
      "Risk: critical (data_egress). Authorization: unknown.",
    );
    expect(harness.entries("pi-guardian-review")).toMatchObject([
      { result: "rejected", riskCategory: "data_egress" },
    ]);
  });

  it("recommends a dedicated small model once when reviews would use the session model", async () => {
    const notices: string[] = [];
    await createGuardianHarness({ ui: { notify: (text) => notices.push(text) } });
    const recommendation = notices.filter((text) => text.includes("small, fast model"));
    expect(recommendation).toHaveLength(1);
    expect(recommendation[0]).toContain("/guardian");

    const configured: string[] = [];
    await createGuardianHarness({
      guardianSettings: reviewer,
      ui: { notify: (text) => configured.push(text) },
    });
    expect(configured.some((text) => text.includes("small, fast model"))).toBe(false);
  });

  it("shows idle and reviewing footer states", async () => {
    const statuses: (string | undefined)[] = [];
    const harness = await createGuardianHarness({
      guardianSettings: reviewer,
      ui: { setStatus: (_key, text) => statuses.push(text && stripVTControlCharacters(text)) },
    });
    harness.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    harness.guardianReplies.push(assessment("low", "high", "Requested."));
    await harness.session.prompt("Deploy a.");
    expect(statuses).toContain("\u25cf guardian on");
    expect(statuses).toContain("\u25cf guardian reviewing deploy");
    expect(statuses.at(-1)).toBe("\u25cf guardian on");
  });
});
