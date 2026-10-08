import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  formatCacheHit,
  formatContextUsage,
  formatDeckCwd,
  formatStatusFooter,
  renderDeckBorder,
  withEmptyPromptPlaceholder,
} from "../src/deck-chrome.js";

const plain = (text: string) => text;

function assistantEntry(input: number, cacheRead: number, cacheWrite: number): SessionEntry {
  return {
    type: "message",
    id: "assistant",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      api: "anthropic-messages",
      provider: "test",
      model: "test",
      usage: {
        input,
        output: 1,
        cacheRead,
        cacheWrite,
        totalTokens: input + cacheRead + cacheWrite + 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    },
  };
}

describe("renderDeckBorder", () => {
  it("places both labels inside a border of exactly the requested width", () => {
    const border = renderDeckBorder(" left ", " right ", 30, plain);
    expect(border).toBe(`─ left ${"─".repeat(15)} right ─`);
    expect(visibleWidth(border)).toBe(30);
  });

  it("shrinks the longer label first when the labels do not fit", () => {
    const border = renderDeckBorder(" a ", " a very long right label ", 16, plain);
    expect(visibleWidth(border)).toBe(16);
    expect(border.startsWith("─ a ")).toBe(true);
  });

  it("draws a bare border when the width cannot hold labels", () => {
    expect(renderDeckBorder(" left ", " right ", 4, plain)).toBe("────");
    expect(renderDeckBorder(" left ", " right ", 0, plain)).toBe("");
  });
});

describe("session labels", () => {
  it("shows the working directory's base name", () => {
    expect(formatDeckCwd("/home/me/project")).toBe("project");
    expect(formatDeckCwd("/")).toBe("/");
  });

  it("formats context usage", () => {
    expect(formatContextUsage(41.6)).toBe("ctx 42%");
    expect(formatContextUsage(null)).toBe("ctx ?");
    expect(formatContextUsage(undefined)).toBe("ctx ?");
  });

  it("reports the latest assistant message's cache hit rate", () => {
    expect(formatCacheHit([])).toBe("cache ?");
    expect(formatCacheHit([assistantEntry(0, 0, 0)])).toBe("cache ?");
    expect(formatCacheHit([assistantEntry(10, 0, 0), assistantEntry(10, 30, 0)])).toBe(
      "cache 75.0%",
    );
  });
});

describe("withEmptyPromptPlaceholder", () => {
  it("follows the hardware cursor marker", () => {
    const line = withEmptyPromptPlaceholder(`${CURSOR_MARKER}       `, "hint", 8);
    expect(line.startsWith(`${CURSOR_MARKER} hint`)).toBe(true);
    expect(visibleWidth(line)).toBe(8);
  });

  it("follows the software cursor", () => {
    const line = withEmptyPromptPlaceholder("\x1b[7m \x1b[0m   ", "hint", 6);
    expect(line).toContain("\x1b[7m \x1b[0mhint");
    expect(visibleWidth(line)).toBe(6);
  });
});

describe("formatStatusFooter", () => {
  it("joins statuses sorted by key with a single space, like Pi's footer", () => {
    const statuses = new Map([
      ["zeta", "last"],
      ["alpha", " first\n  line\t"],
      ["empty", "  "],
    ]);
    expect(formatStatusFooter(statuses, "...", 80)).toEqual(["first line last"]);
    expect(formatStatusFooter(new Map(), "...", 80)).toEqual([]);
  });

  it("truncates to the width with the given ellipsis", () => {
    const statuses = new Map([
      ["advisor", "alpha beta"],
      ["tps", "gamma delta"],
    ]);
    const [line] = formatStatusFooter(statuses, "...", 12);
    expect(stripTerminalSequences(line ?? "")).toBe("alpha bet...");
    expect(visibleWidth(line ?? "")).toBe(12);
  });
});
