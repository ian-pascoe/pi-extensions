import { describe, expect, test } from "vitest";
import { LspRequestLimiter } from "../src/lsp-request-limiter.js";

function deferred() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("LspRequestLimiter", () => {
  test("starts queued tasks in first-in, first-out order as slots free", async () => {
    const limiter = new LspRequestLimiter(1, () => new Error("aborted"));
    const started: string[] = [];
    const gates = new Map(["first", "second", "third"].map((name) => [name, deferred()]));
    const runs = [...gates].map(([name, gate]) =>
      limiter.run(undefined, async () => {
        started.push(name);
        await gate.promise;
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["first"]);
    gates.get("first")?.release();
    await runs[0];
    expect(started).toEqual(["first", "second"]);
    gates.get("second")?.release();
    gates.get("third")?.release();
    await Promise.all(runs);
    expect(started).toEqual(["first", "second", "third"]);
  });

  test("releases the slot when a task fails", async () => {
    const limiter = new LspRequestLimiter(1, () => new Error("aborted"));
    const failing = limiter.run(undefined, () => Promise.reject(new Error("failed")));
    const next = limiter.run(undefined, () => Promise.resolve("ran"));

    await expect(failing).rejects.toThrow("failed");
    await expect(next).resolves.toBe("ran");
  });

  test("rejects an already-aborted caller without running its task", async () => {
    const limiter = new LspRequestLimiter(1, () => new Error("aborted"));
    let ran = false;

    await expect(
      limiter.run(AbortSignal.abort(), () => {
        ran = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow("aborted");
    expect(ran).toBe(false);
  });

  test("keeps the queue order of the callers that did not abort", async () => {
    const limiter = new LspRequestLimiter(1, () => new Error("aborted"));
    const started: string[] = [];
    const gate = deferred();
    const controller = new AbortController();
    const holder = limiter.run(undefined, () => gate.promise);
    const dropped = limiter.run(controller.signal, async () => {
      started.push("dropped");
    });
    const kept = limiter.run(undefined, async () => {
      started.push("kept");
    });

    controller.abort();
    await expect(dropped).rejects.toThrow("aborted");
    gate.release();
    await Promise.all([holder, kept]);
    expect(started).toEqual(["kept"]);
  });
});
