import { describe, expect, it, vi } from "vitest";
import { shutdownMinimalSubagentsSession } from "../src/minimal-subagents-shutdown.js";

describe("minimal subagents shutdown", () => {
  it("cancels immediately for non-reload shutdown", async () => {
    const coordinator = {
      waitForSettledOperations: vi.fn(),
      shutdownAfterSettling: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    await shutdownMinimalSubagentsSession("exit", coordinator, {
      isRootIdle: vi.fn(() => false),
      waitForRootIdle: vi.fn(),
    });
    expect(coordinator.shutdown).toHaveBeenCalledOnce();
    expect(coordinator.waitForSettledOperations).not.toHaveBeenCalled();
  });

  it("drains child and root work until idle before reload disposal", async () => {
    const calls: string[] = [];
    const coordinator = {
      waitForSettledOperations: vi.fn(async () => void calls.push("children")),
      shutdownAfterSettling: vi.fn(async () => void calls.push("shutdown")),
      shutdown: vi.fn(),
    };
    let idle = false;
    await shutdownMinimalSubagentsSession("reload", coordinator, {
      isRootIdle: () => idle,
      waitForRootIdle: async () => {
        calls.push("root");
        idle = true;
      },
    });
    expect(calls).toEqual(["root", "children", "shutdown"]);
  });
});
