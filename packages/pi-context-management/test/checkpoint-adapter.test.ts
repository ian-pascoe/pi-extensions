import { chmodSync } from "node:fs";
import { AgentSession, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, test } from "vitest";
import {
  captureCheckpointAdapter,
  type CheckpointAdapter,
  type CheckpointAdapterOptions,
} from "../src/checkpoint-adapter.js";
import { createSdkHarness, reply, toolCall } from "./sdk-harness.js";

async function fixture(options: CheckpointAdapterOptions = {}) {
  let adapter: CheckpointAdapter | undefined;
  let api: ExtensionAPI | undefined;
  let pending = false;
  let startupError: Error | undefined;
  const harness = await createSdkHarness(
    [
      (pi) => {
        api = pi;
        pi.on("session_start", () => {
          try {
            adapter = captureCheckpointAdapter(pi, options);
          } catch (cause) {
            startupError = cause instanceof Error ? cause : new Error(String(cause));
          }
        });
        pi.registerTool({
          name: "checkpoint_test",
          label: "Checkpoint test",
          description: "SDK boundary test",
          parameters: Type.Object({}),
          async execute() {
            pending = true;
            return { content: [{ type: "text", text: "Requested" }], details: {} };
          },
        });
        pi.on("turn_end", (_event, context) => {
          if (!pending) return;
          pending = false;
          adapter?.commit(
            "Continue the blue widget.",
            undefined,
            100,
            { fixture: true },
            context.signal,
          );
        });
      },
    ],
    { systemPrompt: "Standing instructions survive." },
  );
  if (startupError) throw startupError;
  if (!adapter || !api) throw new Error("The adapter did not activate against the selected SDK");
  afterEach(() => adapter?.dispose());
  harness.settings.applyOverrides({ compaction: { enabled: false } });
  return { ...harness, adapter, api };
}

test("native checkpoint immediately refreshes the ongoing request and survives reopening", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(AgentSession.prototype, "getAllTools");
  const f = await fixture();
  expect(Object.getOwnPropertyDescriptor(AgentSession.prototype, "getAllTools")).toEqual(
    descriptor,
  );
  f.responses.push(toolCall("checkpoint_test", {}), reply("Finished."));
  await f.session.prompt("OLD ARCHIVED MATERIAL");
  expect(f.requests).toHaveLength(2);
  expect(JSON.stringify(f.requests[1])).toContain("Continue the blue widget.");
  expect(JSON.stringify(f.requests[1])).not.toContain("OLD ARCHIVED MATERIAL");
  expect(f.requests[1]?.systemPrompt).toContain("Standing instructions survive.");
  expect(f.session.messages).toEqual(f.manager.buildSessionContext().messages);
  const file = f.manager.getSessionFile();
  if (!file) throw new Error("Missing scratch journal");
  expect(SessionManager.open(file).buildSessionContext().messages).toEqual(f.session.messages);
});

test.each(["checkpoint", "cutoff"] as const)(
  "failed %s append keeps the old active window and blocks later requests until reload",
  async (operation) => {
    const f = await fixture();
    f.responses.push(reply("Ready."));
    await f.session.prompt("Durable original task");
    f.manager.appendCustomEntry("saved-note", { text: "Acknowledged independently" });
    const leaf = f.manager.getLeafId();
    const messages = f.session.messages.slice();
    const file = f.manager.getSessionFile();
    if (!file) throw new Error("Missing scratch journal");
    chmodSync(file, 0o400);
    try {
      expect(() =>
        operation === "checkpoint"
          ? f.adapter.commit("Never activate.", leaf ?? undefined, 100, {})
          : f.adapter.cutoff(undefined),
      ).toThrow(/EACCES/);
    } finally {
      chmodSync(file, 0o600);
    }
    expect(f.manager.getLeafId()).toBe(leaf);
    expect(f.session.messages).toEqual(messages);
    expect(
      SessionManager.open(file)
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === "saved-note"),
    ).toBe(true);
    expect(() => f.adapter.commit("Try again.", undefined, 100, {})).toThrow(/reload required/);
    await f.session.prompt("Do not send this to a model");
    expect(f.requests).toHaveLength(1);
    const recaptured = captureCheckpointAdapter(f.api);
    expect(() => recaptured.commit("Must not commit", undefined, 1, {})).toThrow(
      /not just \/reload/,
    );
    await f.session.prompt("Still blocked after recapture");
    expect(f.requests).toHaveLength(1);
  },
);

test("reload replaces its own callbacks while preserving a later extension's wrapper", async () => {
  const f = await fixture();
  const original = f.session.agent.transformContext;
  if (!original) throw new Error("Missing Pi context transform");
  const later: NonNullable<typeof original> = async (messages, signal) => [
    ...(await original(messages, signal)),
    {
      role: "custom",
      customType: "later-wrapper",
      content: "LATER WRAPPER",
      display: false,
      timestamp: 0,
    },
  ];
  f.session.agent.transformContext = later;
  const replacement = captureCheckpointAdapter(f.api);
  afterEach(() => replacement.dispose());
  expect(() => f.adapter.cutoff(undefined)).toThrow(/disposed/);
  f.responses.push(reply("Ready."));
  await f.session.prompt("First request");
  expect(JSON.stringify(f.requests[0])).toContain("LATER WRAPPER");
  replacement.dispose();
  expect(Object.getOwnPropertyDescriptor(f.session.extensionRunner, "emit")).toBeUndefined();
  expect(Object.getOwnPropertyDescriptor(f.session.extensionRunner, "hasHandlers")).toBeUndefined();
  expect(f.session.agent.transformContext).toBe(later);
  f.responses.push(reply("Still running."));
  await f.session.prompt("After disposal");
  expect(JSON.stringify(f.requests[1])).toContain("LATER WRAPPER");
});

test("cancellation before commit leaves no checkpoint; after commit does not undo it", async () => {
  const f = await fixture();
  f.responses.push(reply("Ready."));
  await f.session.prompt("Original task");
  const before = f.manager.getEntries();
  const cancelled = AbortSignal.abort(new Error("User cancelled"));
  expect(() => f.adapter.commit("Cancelled.", undefined, 100, {}, cancelled)).toThrow(
    "User cancelled",
  );
  expect(f.manager.getEntries()).toEqual(before);
  const controller = new AbortController();
  const checkpoint = f.adapter.commit("Committed.", undefined, 100, {}, controller.signal);
  controller.abort();
  const file = f.manager.getSessionFile();
  if (!file) throw new Error("Missing scratch journal");
  expect(SessionManager.open(file).getLeafId()).toBe(checkpoint.id);
  expect(f.manager.buildSessionContext().messages).toEqual(f.session.messages);
});

test("capability loss is rejected without checkpoint mutation and always restores receiver capture", async () => {
  const f = await fixture();
  const descriptor = Object.getOwnPropertyDescriptor(AgentSession.prototype, "getAllTools");
  const prepare = f.session.agent.prepareNextTurnWithContext;
  if (!prepare) throw new Error("Missing Pi preparation hook");
  const before = f.manager.getEntries();
  try {
    Reflect.deleteProperty(f.session.agent, "prepareNextTurnWithContext");
    expect(() => captureCheckpointAdapter(f.api)).toThrow(/capability unavailable/);
  } finally {
    f.session.agent.prepareNextTurnWithContext = prepare;
  }
  expect(f.manager.getEntries()).toEqual(before);
  expect(() =>
    captureCheckpointAdapter({
      getAllTools() {
        throw new Error("Framework capture failed");
      },
    }),
  ).toThrow("Framework capture failed");
  expect(Object.getOwnPropertyDescriptor(AgentSession.prototype, "getAllTools")).toEqual(
    descriptor,
  );
});

test.each([
  { target: "manager", method: "getHeader" },
  { target: "session", method: "getContextUsage" },
  { target: "settings", method: "isProjectTrusted" },
] as const)(
  "rejects missing $target / $method at capture and before mutation",
  async ({ target, method }) => {
    const f = await fixture();
    f.responses.push(reply("Ready."));
    await f.session.prompt("Original task");
    const owner = f[target];
    const descriptor = Object.getOwnPropertyDescriptor(owner, method);
    const before = f.manager.getEntries();
    let replacement: CheckpointAdapter | undefined;
    try {
      Object.defineProperty(owner, method, { value: undefined, configurable: true });
      expect(() => {
        replacement = captureCheckpointAdapter(f.api);
      }).toThrow(/capability unavailable/);
      expect(() => f.adapter.commit("Must not commit.", undefined, 100, {})).toThrow(
        /capability lost/,
      );
      expect(f.manager.getEntries()).toEqual(before);
    } finally {
      if (descriptor) Object.defineProperty(owner, method, descriptor);
      else Reflect.deleteProperty(owner, method);
      replacement?.dispose();
    }
  },
);

test("an initial unflushed session rejects checkpointing without preventing a shorter request", async () => {
  const f = await fixture();
  const before = f.manager.getEntries();
  expect(() => f.adapter.commit("Too early.", undefined, 100, {})).toThrow(
    /recorded assistant turn/,
  );
  expect(f.manager.getEntries()).toEqual(before);
  f.responses.push(reply("Ready."));
  await f.session.prompt("Short request");
  expect(f.requests).toHaveLength(1);
});

test("normal context projections survive an explicit native checkpoint", async () => {
  const f = await fixture();
  f.api.on("context", (event) => ({
    messages: [
      ...event.messages,
      {
        role: "custom",
        customType: "live-test",
        content: "LIVE PROJECTION",
        display: false,
        timestamp: 0,
      },
    ],
  }));
  f.responses.push(toolCall("checkpoint_test", {}), reply("Finished."));
  await f.session.prompt("OLD ARCHIVED MATERIAL");
  expect(f.requests).toHaveLength(2);
  expect(JSON.stringify(f.requests[1])).toContain("Continue the blue widget.");
  expect(JSON.stringify(f.requests[1])).toContain("LIVE PROJECTION");
  expect(JSON.stringify(f.manager.buildSessionContext())).not.toContain("LIVE PROJECTION");
  expect(JSON.stringify(f.requests[1])).not.toContain("OLD ARCHIVED MATERIAL");
  expect(f.session.messages).toEqual(f.manager.buildSessionContext().messages);
});
