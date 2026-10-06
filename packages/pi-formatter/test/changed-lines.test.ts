import { describe, expect, test } from "vitest";
import { describeChangedLines, diffChangedLines } from "../src/changed-lines.js";

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

describe("diffChangedLines", () => {
  test.each([
    ["identical content", "a\nb\n", "a\nb\n", undefined],
    [
      "a changed line with its neighbours as context",
      "a\nb\nc\n",
      "a\nB\nc\n",
      ["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"],
    ],
    [
      "at most three context lines on each side",
      "1\n2\n3\n4\n5\n6\n7\n8\n9\n",
      "1\n2\n3\n4\nX\n6\n7\n8\n9\n",
      ["@@ -2,7 +2,7 @@", " 2", " 3", " 4", "-5", "+X", " 6", " 7", " 8"],
    ],
    [
      "separate hunks for changes far apart, and no hunk for the unchanged lines between",
      "a\n1\n2\n3\n4\n5\n6\n7\nb\n",
      "A\n1\n2\n3\n4\n5\n6\n7\nB\n",
      [
        "@@ -1,4 +1,4 @@",
        "-a",
        "+A",
        " 1",
        " 2",
        " 3",
        "@@ -6,4 +6,4 @@",
        " 5",
        " 6",
        " 7",
        "-b",
        "+B",
      ],
    ],
    [
      "unchanged lines between nearby changes",
      "a\nb\nc\nd\ne\n",
      "a\nB\nc\nD\ne\n",
      ["@@ -1,5 +1,5 @@", " a", "-b", "+B", " c", "-d", "+D", " e"],
    ],
    ["an insertion", "a\nb\n", "a\nx\ny\nb\n", ["@@ -1,2 +1,4 @@", " a", "+x", "+y", " b"]],
    ["a removal", "a\nx\ny\nb\n", "a\nb\n", ["@@ -1,4 +1,2 @@", " a", "-x", "-y", " b"]],
    ["a file that gained content", "", "a\nb\n", ["@@ -0,0 +1,2 @@", "+a", "+b"]],
    ["an emptied file", "a\n", "", ["@@ -1 +0,0 @@", "-a"]],
    [
      "a missing final newline",
      "a\nb",
      "a\nb\n",
      ["@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+b"],
    ],
    [
      "a newline removed after the last line",
      "a\nb\n",
      "a\nb",
      ["@@ -1,2 +1,2 @@", " a", "-b", "+b", "\\ No newline at end of file"],
    ],
  ])("renders %s", (_name, before, after, expected) => {
    expect(diffChangedLines(before, after)).toEqual(expected);
  });

  test("matches unchanged lines between edits instead of rewriting the whole span", () => {
    const lines = Array.from({ length: 30 }, (_value, index) => `line ${index}\n`);
    const before = lines.join("");
    const after = lines.map((line, index) => (index === 5 || index === 25 ? "X\n" : line)).join("");
    const diff = diffChangedLines(before, after);
    expect(diff?.filter((line) => line.startsWith("-") || line.startsWith("+"))).toEqual([
      "-line 5",
      "+X",
      "-line 25",
      "+X",
    ]);
  });

  test("diffs small changes at both ends of a large file", () => {
    const lines = Array.from({ length: 5_000 }, (_value, index) => `line ${index}\n`);
    const before = lines.join("");
    const after = lines
      .map((line, index) => (index === 0 || index === 4_999 ? "X\n" : line))
      .join("");
    expect(diffChangedLines(before, after)).toEqual([
      "@@ -1,4 +1,4 @@",
      "-line 0",
      "+X",
      " line 1",
      " line 2",
      " line 3",
      "@@ -4997,4 +4997,4 @@",
      " line 4996",
      " line 4997",
      " line 4998",
      "-line 4999",
      "+X",
    ]);
  });

  test("renders hunks that rebuild the formatted content from the original", () => {
    let seed = 7;
    const random = (limit: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % limit;
    };
    for (let round = 0; round < 200; round++) {
      const before = Array.from({ length: random(25) }, () => `${random(6)}\n`);
      const after = Array.from({ length: random(25) }, () => `${random(6)}\n`);
      if (random(4) === 0 && after.length > 0) after[after.length - 1] = "tail";
      const diff = diffChangedLines(before.join(""), after.join(""));
      if (before.join("") === after.join("")) continue;
      expect(diff).toBeDefined();
      expect(applyHunks(before, diff ?? [])).toEqual(after);
    }
  });

  test("gives up on a rewrite too large to diff cheaply", () => {
    const before = Array.from({ length: 2_000 }, (_value, index) => `a${index}\n`).join("");
    const after = Array.from({ length: 2_000 }, (_value, index) => `b${index}\n`).join("");
    expect(diffChangedLines(before, after)).toBeUndefined();
  });
});

/** Apply unified diff hunks to `before` lines (lines keep their terminator). */
function applyHunks(before: readonly string[], diff: readonly string[]): string[] {
  const result: string[] = [];
  let next = 0;
  let previous: string | undefined;
  for (const line of diff) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/.exec(line);
    if (header !== null) {
      const start = Number(header[1]);
      const count = header[2] === undefined ? 1 : Number(header[2]);
      const target = count === 0 ? start : start - 1;
      result.push(...before.slice(next, target));
      next = target;
      continue;
    }
    if (line.startsWith("\\")) {
      // The marker says the added line before it has no terminator; context and removed lines
      // take theirs from the original.
      if (previous === "+") result[result.length - 1] = (result.at(-1) ?? "").replace(/\n$/, "");
      continue;
    }
    const text = `${line.slice(1)}\n`;
    if (line.startsWith(" ")) {
      result.push(before[next] ?? text);
      next++;
    } else if (line.startsWith("-")) next++;
    else result.push(text);
    previous = line[0];
  }
  result.push(...before.slice(next));
  return result;
}
