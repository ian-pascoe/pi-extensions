import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { lastCharCol, snapCol } from "../src/vim/text.js";
import { VimHarness, formatModel } from "./vim-harness.js";

const KEYS = [
  ..."hjklwbeWBE0^$xXdcypPiaoOAIu.vVgG~JrftT;,%{}sSDCY23 ()\"'<>[]{}nN*#R/?:qz!é".split(""),
  "<Esc>",
  "<Esc>",
  "<BS>",
  "<CR>",
  "<C-r>",
  "<Del>",
  "<Up>",
  "<Down>",
];

const lineArb = fc.string({
  unit: fc.constantFrom(..."ab ()[]{}.,\"'xé".split("")),
  maxLength: 12,
});
const textArb = fc.array(lineArb, { minLength: 1, maxLength: 4 }).map((lines) => lines.join("\n"));
const keysArb = fc.array(fc.constantFrom(...KEYS), { maxLength: 40 });

function assertCursorInBounds(harness: VimHarness): void {
  const { lines, cursor } = harness.model;
  expect(lines.length).toBeGreaterThan(0);
  expect(cursor.line).toBeGreaterThanOrEqual(0);
  expect(cursor.line).toBeLessThan(lines.length);
  const line = lines[cursor.line] ?? "";
  // Only normal mode keeps the cursor on a character; visual `$` (and ex or search lines opened
  // from it) may sit on the line end.
  const limit = harness.mode === "normal" ? lastCharCol(line) : line.length;
  expect(cursor.col).toBeGreaterThanOrEqual(0);
  expect(cursor.col).toBeLessThanOrEqual(limit);
  expect(snapCol(line, cursor.col)).toBe(cursor.col);
}

describe("Vim engine properties", () => {
  it("keeps the cursor on a valid position after every key", () => {
    fc.assert(
      fc.property(textArb, keysArb, (text, keys) => {
        const harness = new VimHarness(`|${text}`);
        for (const key of keys) {
          harness.press(key);
          assertCursorInBounds(harness);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("undoes every change back to the original text", () => {
    fc.assert(
      fc.property(textArb, keysArb, (text, keys) => {
        const harness = new VimHarness(`|${text}`);
        for (const key of keys) harness.press(key);
        harness.type("<Esc><Esc><Esc>9999u");
        expect(harness.model.lines.join("\n")).toBe(text);
      }),
      { numRuns: 400 },
    );
  });

  it("redoes every undone change", () => {
    fc.assert(
      fc.property(textArb, keysArb, (text, keys) => {
        const harness = new VimHarness(`|${text}`);
        for (const key of keys) harness.press(key);
        harness.type("<Esc><Esc><Esc>9999<C-r>");
        const edited = harness.model.lines.join("\n");
        harness.type("9999u9999<C-r>");
        expect(harness.model.lines.join("\n")).toBe(edited);
        expect(formatModel(harness.model)).toContain("|");
      }),
      { numRuns: 200 },
    );
  });
});
