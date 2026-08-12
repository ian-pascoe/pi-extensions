import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";

type WorkingMessageHandler = (
  event: unknown,
  context: { ui: { setWorkingMessage(message?: string): void } },
) => Promise<void> | void;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Bible Verses extension lifecycle", () => {
  test("sets a formatted passage at turn start and clears it at turn end", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { default: bibleVersesExtension } = await import("../src/index.js");
    const handlers = new Map<string, WorkingMessageHandler>();
    const pi = {
      on(event: string, handler: unknown) {
        handlers.set(event, handler as WorkingMessageHandler);
      },
    } as ExtensionAPI;
    const setWorkingMessage = vi.fn();
    const context = { ui: { setWorkingMessage } };

    bibleVersesExtension(pi);

    expect(handlers).toHaveLength(2);
    await handlers.get("turn_start")?.({}, context);
    await handlers.get("turn_end")?.({}, context);

    expect(setWorkingMessage).toHaveBeenNthCalledWith(
      1,
      "In the beginning God created the heavens and the earth. — Genesis 1:1 (BSB)",
    );
    expect(setWorkingMessage).toHaveBeenNthCalledWith(2);
  });
});
