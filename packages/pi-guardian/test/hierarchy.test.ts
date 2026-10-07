import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import {
  assessment,
  createGuardianHarness,
  reply,
  toolCalls,
} from "./fixtures/guardian-harness.js";

/** A session journal promoted to a Minimal Subagents Child Agent of `rootSessionId`. */
async function childManager(rootSessionId: string) {
  const dir = await mkdtemp(join(tmpdir(), "pi-guardian-child-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  manager.appendCustomEntry("minimal-subagents.identity", {
    version: 1,
    original_root_session_id: rootSessionId,
    canonical_agent_id: "root.worker",
    direct_parent_id: "root",
    created_at: new Date(0).toISOString(),
  });
  return manager;
}

describe("Child Agents and Advisors", () => {
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
    child.verdicts.push(assessment("high", "unknown", "Only another agent asked for this."));
    await child.session.prompt("Task from the parent agent: deploy b.");
    expect(child.executed).toEqual([]);
    expect(child.reviews).toHaveLength(1);
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
      { outcome: "failed", failure: "Guardian model guardian-test/missing was not found" },
    ]);
  });
});
