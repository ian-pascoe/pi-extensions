import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import {
  hasQueuedSteer,
  onQueuedSteer,
  raiseQueuedSteer,
  settleQueuedSteers,
  trackQueuedSteers,
  watchQueuedSteer,
} from "../src/queued-steer.js";

type TestEvent =
  | { readonly type: "input"; readonly streamingBehavior?: "steer" | "followUp" }
  | { readonly type: "turn_start" }
  | { readonly type: "agent_end" };
type Handler = (event: TestEvent, context: ExtensionContext) => void;

/** A stand-in for `ExtensionAPI` that records `on` handlers so a test can emit events. */
class RecordingPi {
  private readonly handlers = new Map<string, Handler[]>();
  readonly pi: ExtensionAPI;

  constructor() {
    const on = (name: string, handler: Handler) => {
      this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
    };
    const proxy = new Proxy(
      {},
      { get: (_target, property) => (property === "on" ? on : undefined) },
    );
    // SAFETY: trackQueuedSteers only calls `on`, which the proxy answers.
    this.pi = proxy as ExtensionAPI;
  }

  emit(event: TestEvent, sessionId: string): void {
    const fields = { sessionManager: { getSessionId: () => sessionId } };
    // SAFETY: the handlers read only `sessionManager.getSessionId()`.
    const context = fields as ExtensionContext;
    for (const handler of this.handlers.get(event.type) ?? []) handler(event, context);
  }

  count(): number {
    return [...this.handlers.values()].reduce((total, list) => total + list.length, 0);
  }
}

test("a raised steer is pending until settled, and listeners run once per transition", () => {
  let calls = 0;
  const unsubscribe = onQueuedSteer("steer-a", () => {
    calls += 1;
  });
  expect(hasQueuedSteer("steer-a")).toBe(false);
  raiseQueuedSteer("steer-a");
  raiseQueuedSteer("steer-a");
  expect(hasQueuedSteer("steer-a")).toBe(true);
  expect(calls).toBe(1);
  settleQueuedSteers("steer-a");
  expect(hasQueuedSteer("steer-a")).toBe(false);
  raiseQueuedSteer("steer-a");
  expect(calls).toBe(2);
  unsubscribe();
  settleQueuedSteers("steer-a");
});

test("sessions are independent", () => {
  raiseQueuedSteer("steer-b");
  expect(hasQueuedSteer("steer-c")).toBe(false);
  settleQueuedSteers("steer-b");
});

test("a watch aborts when a steer is raised, and at once when one is already pending", () => {
  const watch = watchQueuedSteer("steer-d");
  expect(watch.signal.aborted).toBe(false);
  raiseQueuedSteer("steer-d");
  expect(watch.signal.aborted).toBe(true);
  watch.dispose();

  const late = watchQueuedSteer("steer-d");
  expect(late.signal.aborted).toBe(true);
  late.dispose();
  settleQueuedSteers("steer-d");

  const disposed = watchQueuedSteer("steer-d");
  disposed.dispose();
  raiseQueuedSteer("steer-d");
  expect(disposed.signal.aborted).toBe(false);
  settleQueuedSteers("steer-d");
});

test("tracking raises on user steers only and settles at turn start and run end", () => {
  const recorder = new RecordingPi();
  trackQueuedSteers(recorder.pi);
  trackQueuedSteers(recorder.pi);
  expect(recorder.count()).toBe(3);

  recorder.emit({ type: "input", streamingBehavior: "followUp" }, "steer-e");
  recorder.emit({ type: "input" }, "steer-e");
  expect(hasQueuedSteer("steer-e")).toBe(false);

  recorder.emit({ type: "input", streamingBehavior: "steer" }, "steer-e");
  expect(hasQueuedSteer("steer-e")).toBe(true);
  recorder.emit({ type: "turn_start" }, "steer-e");
  expect(hasQueuedSteer("steer-e")).toBe(false);

  recorder.emit({ type: "input", streamingBehavior: "steer" }, "steer-e");
  recorder.emit({ type: "agent_end" }, "steer-e");
  expect(hasQueuedSteer("steer-e")).toBe(false);
});

test("every copy of the module shares one signal through globalThis", async () => {
  vi.resetModules();
  const copy = await import("../src/queued-steer.js");
  raiseQueuedSteer("steer-f");
  expect(copy.hasQueuedSteer("steer-f")).toBe(true);
  copy.settleQueuedSteers("steer-f");
  expect(hasQueuedSteer("steer-f")).toBe(false);
});
