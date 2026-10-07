import { describe, expect, it } from "vitest";
import { SessionManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import {
  assessment,
  confirmedRejection,
  createGuardianHarness,
  reply,
  toolCalls,
  type CapturedReview,
} from "./fixtures/guardian-harness.js";

/** A session journal promoted to a Minimal Subagents Child Agent of `rootSessionId`. */
async function childManager(rootSessionId: string, agentId = "worker", parentAgentId = "root") {
  const dir = await mkdtemp(join(tmpdir(), "pi-guardian-child-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  manager.appendCustomEntry("minimal-subagents.identity", {
    version: 1,
    original_root_session_id: rootSessionId,
    canonical_agent_id: agentId,
    direct_parent_id: parentAgentId,
    created_at: new Date(0).toISOString(),
  });
  return manager;
}

/** A stand-in for Minimal Subagents' `subagent` tool, so a session can delegate. */
const delegatingTool: ExtensionFactory = (pi) => {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate a task.",
    parameters: Type.Object({ task: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: "spawned" }], details: {} }),
  });
};

/**
 * A session journal promoted to an Advisor Session observing `observedSessionId`, with the entry
 * pi-advisor writes (`packages/pi-advisor/src/advisor-session.ts`).
 */
async function advisorManager(observedSessionId: string) {
  const dir = await mkdtemp(join(tmpdir(), "pi-guardian-advisor-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  manager.appendCustomEntry("pi-advisor-role", { role: "advisor", observedSessionId });
  return manager;
}

/** The text blocks of a captured Guardian request. */
function requestTexts(review: CapturedReview | undefined): string[] {
  const [message] = review?.messages ?? [];
  return message?.role === "user" && Array.isArray(message.content)
    ? message.content.map((part) => (part.type === "text" ? part.text : ""))
    : [];
}

describe("Child Agents and Advisors", () => {
  it("detect an Advisor Session, which follows its root and trusts no user message", async () => {
    const root = await createGuardianHarness({
      guardianSettings: { model: "guardian-test/reviewer" },
    });
    await root.session.prompt("/guardian tool deploy review");
    const advisor = await createGuardianHarness({
      guardianSettings: { enabled: false },
      manager: await advisorManager(root.session.sessionManager.getSessionId()),
    });
    advisor.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    advisor.guardianReplies.push(
      ...confirmedRejection("high", "unknown", "Pi asked, not the user."),
    );
    await advisor.session.prompt("Review the observed agent's last turn.");
    expect(advisor.executed).toEqual([]);
    const message = advisor.reviews[0]?.messages[0];
    const texts =
      message?.role === "user" && Array.isArray(message.content)
        ? message.content.map((part) => (part.type === "text" ? part.text : ""))
        : [];
    expect(texts[0]).toMatch(/^Evidence \(UNTRUSTED, origin: user\)/);
    expect(texts.at(-1)).toContain("Guarded Agent: an Advisor");
    await advisor.session.prompt("/guardian status");
    expect(advisor.entries("pi-guardian-status").at(-1)).toMatchObject({
      followsRoot: root.session.sessionManager.getSessionId(),
    });
  });

  it("weigh the root user's typed requests as Trusted Evidence, but not their own task", async () => {
    const root = await createGuardianHarness({
      guardianSettings: { model: "guardian-test/reviewer" },
    });
    root.responses.push(reply("I will delegate it."));
    await root.session.prompt("Have a worker deploy staging.");
    const child = await createGuardianHarness({
      manager: await childManager(root.session.sessionManager.getSessionId()),
    });
    child.responses.push(toolCalls(["deploy", { target: "staging" }, "call-1"]), reply("Ok."));
    child.guardianReplies.push(assessment("low", "high", "The root user asked for it."));
    await child.session.prompt("Task from the parent agent: deploy staging and production.");
    expect(child.executed).toEqual(["deploy:staging"]);
    const message = child.reviews[0]?.messages[0];
    const texts =
      message?.role === "user" && Array.isArray(message.content)
        ? message.content.map((part) => (part.type === "text" ? part.text : ""))
        : [];
    const labels = texts.map((text) => text.split("\n", 1)[0]);
    expect(labels.slice(0, 2)).toEqual([
      "Evidence (TRUSTED, origin: rootUser):",
      "Evidence (UNTRUSTED, origin: user):",
    ]);
    expect(texts[0]).toContain("Have a worker deploy staging.");
    expect(texts[1]).toContain("deploy staging and production");
  });

  it("follow the root session's effective settings live", async () => {
    const root = await createGuardianHarness({
      guardianSettings: { model: "guardian-test/reviewer", tools: { deploy: "deny" } },
    });
    const child = await createGuardianHarness({
      // The child's own settings would allow everything.
      guardianSettings: { enabled: false },
      manager: await childManager(root.session.sessionManager.getSessionId()),
    });
    child.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    await child.session.prompt("Task from the parent agent: deploy a.");
    expect(child.executed).toEqual([]);
    expect(child.reviews).toHaveLength(0);

    // A root session override applies to the child at once.
    await root.session.prompt("/guardian tool deploy review");
    child.responses.push(toolCalls(["deploy", { target: "b" }, "call-2"]), reply("Ok."));
    child.guardianReplies.push(
      ...confirmedRejection("high", "unknown", "Only another agent asked for this."),
    );
    await child.session.prompt("Task from the parent agent: deploy b.");
    expect(child.executed).toEqual([]);
    expect(child.reviews.map((review) => review.escalation)).toEqual([false, true]);
    // The child's task is not Trusted Evidence, and the Reviewed Call names the Child Agent.
    const message = child.reviews[0]?.messages[0];
    const texts =
      message?.role === "user" && Array.isArray(message.content)
        ? message.content.map((part) => (part.type === "text" ? part.text : ""))
        : [];
    expect(texts.filter((text) => text.startsWith("Evidence (TRUSTED"))).toEqual([]);
    expect(texts.at(-1)).toContain("Guarded Agent: a Minimal Subagents Child Agent");

    await child.session.prompt("/guardian status");
    expect(child.entries("pi-guardian-status").at(-1)).toMatchObject({
      state: "enabled",
      followsRoot: root.session.sessionManager.getSessionId(),
      settings: { tools: { deploy: "review" } },
    });
  });

  it("resolve an Advisor observing a Child Agent to the real root", async () => {
    const root = await createGuardianHarness({
      guardianSettings: { model: "guardian-test/reviewer" },
    });
    await root.session.prompt("/guardian tool deploy review");
    root.responses.push(reply("I will delegate it."));
    await root.session.prompt("Have a worker deploy staging.");
    const rootId = root.session.sessionManager.getSessionId();
    const child = await createGuardianHarness({
      guardianSettings: { enabled: false },
      manager: await childManager(rootId),
    });
    const advisor = await createGuardianHarness({
      guardianSettings: { enabled: false },
      manager: await advisorManager(child.session.sessionManager.getSessionId()),
    });
    advisor.responses.push(toolCalls(["deploy", { target: "staging" }, "call-1"]), reply("Ok."));
    advisor.guardianReplies.push(assessment("low", "high", "The root user asked for it."));
    await advisor.session.prompt("Review the worker's last turn.");
    expect(advisor.reviews).toHaveLength(1);
    const texts = requestTexts(advisor.reviews[0]);
    expect(texts[0]).toMatch(/^Evidence \(TRUSTED, origin: rootUser\):/);
    expect(texts[0]).toContain("Have a worker deploy staging.");
    await advisor.session.prompt("/guardian status");
    expect(advisor.entries("pi-guardian-status").at(-1)).toMatchObject({
      followsRoot: rootId,
      settings: { tools: { deploy: "review" } },
    });
  });

  it("keep their root's last settings and requests after the root session ends", async () => {
    const root = await createGuardianHarness({
      guardianSettings: { model: "guardian-test/reviewer", tools: { deploy: "review" } },
    });
    root.responses.push(reply("I will delegate it."));
    await root.session.prompt("Have a worker deploy staging.");
    const rootId = root.session.sessionManager.getSessionId();
    const child = await createGuardianHarness({
      // The child's own settings would allow everything.
      guardianSettings: { enabled: false },
      manager: await childManager(rootId),
    });
    await child.session.prompt("/guardian status");
    // The root ends (as on /new or /resume) and leaves the registry.
    root.session.dispose();
    child.responses.push(toolCalls(["deploy", { target: "staging" }, "call-1"]), reply("Ok."));
    child.guardianReplies.push(assessment("low", "high", "The root user asked for it."));
    await child.session.prompt("Task from the parent agent: deploy staging.");
    expect(child.reviews).toHaveLength(1);
    expect(requestTexts(child.reviews[0])[0]).toContain("Have a worker deploy staging.");
    await child.session.prompt("/guardian status");
    expect(child.entries("pi-guardian-status").at(-1)).toMatchObject({
      state: "enabled",
      followsRoot: rootId,
    });
  });

  it("trust a task their direct parent's Guardian approved, through nested delegation", async () => {
    const root = await createGuardianHarness({
      guardianSettings: { model: "guardian-test/reviewer" },
    });
    root.responses.push(reply("I will delegate it."));
    await root.session.prompt("Have a worker deploy staging and let it delegate.");
    const rootId = root.session.sessionManager.getSessionId();
    // The Child Agent delegates to its own child; its Guardian reviews and allows the call.
    const child = await createGuardianHarness({
      manager: await childManager(rootId, "worker", "root"),
      before: [delegatingTool],
    });
    child.responses.push(
      toolCalls(["subagent", { task: "Deploy staging." }, "call-delegate"]),
      reply("Delegated."),
    );
    child.guardianReplies.push(assessment("low", "high", "The root user asked for it."));
    await child.session.prompt("Deploy staging, delegating the work.");
    expect(child.entries("pi-guardian-review")).toMatchObject([
      { toolName: "subagent", result: "allowed", delegationSha256: expect.any(String) },
    ]);
    const reviewTask = async (agentId: string, parentAgentId: string) => {
      const grandchild = await createGuardianHarness({
        manager: await childManager(rootId, agentId, parentAgentId),
      });
      grandchild.responses.push(
        toolCalls(["deploy", { target: "staging" }, "call-1"]),
        reply("Ok."),
      );
      grandchild.guardianReplies.push(assessment("low", "high", "Delegated."));
      await grandchild.session.prompt("Deploy staging.");
      return requestTexts(grandchild.reviews[0]).map((text) => text.split("\n", 1)[0]);
    };
    // The grandchild of `worker` trusts the task `worker`'s Guardian approved.
    expect(await reviewTask("worker.deployer", "worker")).toEqual([
      "Evidence (TRUSTED, origin: rootUser):",
      "Evidence (TRUSTED, origin: approvedDelegation):",
      expect.stringMatching(/^Reviewed Call/),
    ]);
    // A Child Agent of another parent does not, even with the same text.
    expect((await reviewTask("other", "root"))[1]).toBe("Evidence (UNTRUSTED, origin: user):");
  });

  it("fall back to their own settings when the root does not run Guardian in-process", async () => {
    const child = await createGuardianHarness({
      guardianSettings: { enabled: false },
      manager: await childManager("absent-root"),
    });
    child.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    await child.session.prompt("deploy a");
    expect(child.executed).toEqual(["deploy:a"]);
  });

  it("block Review Failures without asking, since Child Agents have no UI", async () => {
    const root = await createGuardianHarness({
      guardianSettings: { model: "guardian-test/missing" },
    });
    const child = await createGuardianHarness({
      manager: await childManager(root.session.sessionManager.getSessionId()),
    });
    child.responses.push(toolCalls(["deploy", { target: "a" }, "call-1"]), reply("Ok."));
    await child.session.prompt("deploy a");
    expect(child.executed).toEqual([]);
    expect(child.entries("pi-guardian-review")).toMatchObject([
      { result: "failed", failure: "Guardian model guardian-test/missing was not found" },
    ]);
  });
});
