import { describe, expect, test } from "vitest";
import { LspRequestLimiter } from "../src/lsp-request-limiter.js";

describe("LspRequestLimiter", () => {
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
});
