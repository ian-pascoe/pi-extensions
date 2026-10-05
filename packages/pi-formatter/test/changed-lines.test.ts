import { describe, expect, test } from "vitest";
import { describeChangedLines } from "../src/changed-lines.js";

describe("describeChangedLines", () => {
  test.each([
    ["identical content", "a\nb\n", "a\nb\n", undefined],
    ["one changed line", "a\nb\nc\n", "a\nB\nc\n", "line 2 changed"],
    [
      "one span from the first to the last changed line, including unchanged lines between",
      "a\nb\nc\nd\ne\n",
      "a\nB\nc\nD\ne\n",
      "lines 2–4 changed",
    ],
    [
      "lines in formatted-file numbering after an insertion",
      "a\nb\n",
      "a\nx\ny\nb\n",
      "lines 2–3 changed",
    ],
    ["a missing final newline", "a\nb", "a\nb\n", "line 2 changed"],
    ["CRLF endings rewritten to LF", "a\r\nb\r\n", "a\nb\n", "lines 1–2 changed"],
    ["removed lines in the middle", "a\nx\ny\nb\n", "a\nb\n", "lines removed after line 1"],
    ["removed lines at the start", "x\na\n", "a\n", "lines removed before line 1"],
    ["removed trailing lines", "a\n\n\n", "a\n", "lines removed after line 1"],
    ["an emptied file", "a\n", "", "all lines removed"],
    ["a file that gained content", "", "a\nb\n", "lines 1–2 changed"],
  ])("describes %s", (_name, before, after, expected) => {
    expect(describeChangedLines(before, after)).toBe(expected);
  });
});
