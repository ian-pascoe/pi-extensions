import type { TurnEndEvent, TurnStartEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  registerBibleVerseLifecycle,
  type BibleVerseLifecycleHost,
  type BibleVerseWorkingMessageHost,
} from "../src/bible-verse-lifecycle.js";

class RecordingBibleVerseLifecycleHost implements BibleVerseLifecycleHost {
  turnStart: Parameters<BibleVerseLifecycleHost["onTurnStart"]>[0] | undefined;
  turnEnd: Parameters<BibleVerseLifecycleHost["onTurnEnd"]>[0] | undefined;

  onTurnStart(handler: Parameters<BibleVerseLifecycleHost["onTurnStart"]>[0]) {
    this.turnStart = handler;
  }
  onTurnEnd(handler: Parameters<BibleVerseLifecycleHost["onTurnEnd"]>[0]) {
    this.turnEnd = handler;
  }
}

class RecordingWorkingMessageHost implements BibleVerseWorkingMessageHost {
  readonly messages: (string | undefined)[] = [];
  setWorkingMessage(message?: string) {
    this.messages.push(message);
  }
}

function requireHandler<T>(handler: T | undefined): T {
  if (handler === undefined) throw new Error("Expected registered Bible Verse lifecycle handler");
  return handler;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Bible Verses extension lifecycle", () => {
  test("sets a formatted passage at turn start and clears it at turn end", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const lifecycle = new RecordingBibleVerseLifecycleHost();
    const workingMessage = new RecordingWorkingMessageHost();
    registerBibleVerseLifecycle(lifecycle);

    await requireHandler(lifecycle.turnStart)(
      { type: "turn_start", turnIndex: 0, timestamp: 0 } satisfies TurnStartEvent,
      workingMessage,
    );
    await requireHandler(lifecycle.turnEnd)(
      {
        type: "turn_end",
        turnIndex: 0,
        message: { role: "user", content: "done", timestamp: 0 },
        toolResults: [],
      } satisfies TurnEndEvent,
      workingMessage,
    );

    expect(workingMessage.messages).toEqual([
      "In the beginning God created the heavens and the earth. — Genesis 1:1 (BSB)",
      undefined,
    ]);
  });
});
