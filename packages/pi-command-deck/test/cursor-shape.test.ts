import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { stripSoftwareCursor } from "../src/cursor-shape.js";

describe("stripSoftwareCursor", () => {
  it.each([
    ["pi-tui's fake cursor", "\x1b_pi:fc\x07b\x1b_pi:/fc\x07"],
    ["the legacy reverse-video cursor", "\x1b[7mb\x1b[0m"],
  ])("removes %s after the hardware cursor marker", (_name, cursor) => {
    const lines = ["top", `a${CURSOR_MARKER}${cursor}c`];
    stripSoftwareCursor(lines);
    expect(lines).toEqual(["top", `a${CURSOR_MARKER}bc`]);
  });

  it("keeps a fake cursor without a hardware cursor marker", () => {
    const lines = ["a\x1b_pi:fc\x07b\x1b_pi:/fc\x07c"];
    stripSoftwareCursor(lines);
    expect(lines).toEqual(["a\x1b_pi:fc\x07b\x1b_pi:/fc\x07c"]);
  });
});
