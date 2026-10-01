import { expect, it } from "vitest";
import * as piAi from "@earendil-works/pi-ai";
import * as piSdk from "@earendil-works/pi-coding-agent";
import { createSdkHarness } from "../../pi-context-management/test/sdk-harness.js";
import advisor from "../src/index.js";
import { advisorRuntimeIssues, advisorRuntimeWarning } from "../src/advisor-runtime.js";

it("meets every runtime requirement on the installed Pi", () => {
  expect(advisorRuntimeIssues()).toEqual([]);
  expect(advisorRuntimeWarning()).toBeUndefined();
});

it("names missing exports and methods instead of checking a Pi version", () => {
  const without = (names: readonly string[]) =>
    Object.fromEntries(Object.entries(piSdk).filter(([name]) => !names.includes(name)));
  expect(
    advisorRuntimeIssues(piAi, without(["createAgentSessionServices", "AgentSessionRuntime"])),
  ).toEqual([
    "AgentSessionRuntime",
    "createAgentSessionServices",
    "AgentSessionRuntime#dispose",
    "AgentSessionRuntime#setRebindSession",
  ]);
  expect(advisorRuntimeIssues({}, piSdk)).toEqual([
    "pi-ai InMemoryCredentialStore",
    "pi-ai contentText",
    "pi-ai getCurrentSystemPrompt",
    "pi-ai getCurrentTools",
    "pi-ai toToolDeclaration",
  ]);
});

it("warns and stays unavailable without breaking the observed session when a requirement is missing", async () => {
  const prototype = piSdk.AgentSessionRuntime.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "setRebindSession");
  if (!descriptor) throw new Error("Installed Pi lacks AgentSessionRuntime#setRebindSession");
  Reflect.deleteProperty(prototype, "setRebindSession");
  try {
    const { session, manager, extensionErrors } = await createSdkHarness([advisor]);
    expect(extensionErrors).toEqual([]);
    expect(session.getActiveToolNames()).not.toContain("advisor_ask");
    await session.prompt("/advisor status");
    expect(
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
    ).toMatchObject({
      data: {
        state: "paused",
        error: "Advisor is unavailable: this Pi runtime lacks AgentSessionRuntime#setRebindSession",
      },
    });
  } finally {
    Object.defineProperty(prototype, "setRebindSession", descriptor);
  }
});
