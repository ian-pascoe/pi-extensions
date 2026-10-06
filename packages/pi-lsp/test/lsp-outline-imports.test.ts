import { describe, expect, test } from "vitest";
import { dropImportSymbols, importFoldingRanges } from "../src/lsp-outline-imports.js";

const VARIABLE = 13;
const FUNCTION = 12;
const CLASS = 5;

function range(startLine: number, endLine: number) {
  return { start: { line: startLine, character: 0 }, end: { line: endLine, character: 4 } };
}

function symbol(name: string, kind: number, startLine: number, endLine = startLine) {
  return {
    name,
    kind,
    range: range(startLine, endLine),
    selectionRange: range(startLine, startLine),
    children: [],
  };
}

function flat(name: string, kind: number, line: number, containerName?: string | null) {
  const entry = { name, kind, location: { uri: "file:///a.ts", range: range(line, line) } };
  return containerName === undefined ? entry : { ...entry, containerName };
}

const imports = [{ startLine: 0, endLine: 2, kind: "imports" as const }];

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test helper reads an opaque filter result.
function names(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map((item) => item.name) : [];
}

describe("importFoldingRanges", () => {
  test("keeps only imports-kind ranges and ignores malformed items and non-lists", () => {
    expect(
      importFoldingRanges([
        { startLine: 0, endLine: 2, kind: "imports" },
        { startLine: 3, endLine: 9, kind: "region" },
        { startLine: 10, endLine: 12 },
        { startLine: "x", endLine: 1, kind: "imports" },
        null,
      ]),
    ).toEqual([{ startLine: 0, endLine: 2, kind: "imports" }]);
    expect(importFoldingRanges(null)).toEqual([]);
    expect(importFoldingRanges({ startLine: 0 })).toEqual([]);
  });
});

describe("dropImportSymbols", () => {
  test("drops hierarchical top-level symbols inside an imports range and counts them", () => {
    const result = dropImportSymbols(
      [
        symbol("a", VARIABLE, 0),
        symbol("b", VARIABLE, 1),
        symbol("c", VARIABLE, 2),
        symbol("run", FUNCTION, 4, 8),
      ],
      imports,
    );
    expect(names(result.value)).toEqual(["run"]);
    expect(result.omitted).toBe(3);
  });

  test("keeps a symbol that only partly overlaps an imports range", () => {
    const result = dropImportSymbols(
      [symbol("spans", VARIABLE, 2, 5), symbol("before", VARIABLE, 0, 0)],
      [{ startLine: 1, endLine: 3, kind: "imports" }],
    );
    expect(names(result.value)).toEqual(["spans", "before"]);
    expect(result.omitted).toBe(0);
  });

  test("does not drop nested symbols, and counts the children of a dropped one", () => {
    const parent = { ...symbol("ns", VARIABLE, 0), children: [symbol("inner", VARIABLE, 1)] };
    const kept = { ...symbol("run", FUNCTION, 4, 8), children: [symbol("local", VARIABLE, 1)] };
    const result = dropImportSymbols([parent, kept], imports);
    expect(names(result.value)).toEqual(["run"]);
    expect(result.value).toEqual([kept]);
    expect(result.omitted).toBe(2);
  });

  test("drops flat top-level entries but not entries inside a container", () => {
    const store = {
      ...flat("Store", CLASS, 0),
      location: { uri: "file:///a.ts", range: range(0, 9) },
    };
    const result = dropImportSymbols(
      [
        flat("a", VARIABLE, 0),
        flat("b", VARIABLE, 1, ""),
        flat("c", VARIABLE, 2, null),
        store,
        flat("member", VARIABLE, 1, "Store"),
        flat("run", FUNCTION, 5),
      ],
      imports,
    );
    // `Store` spans past the imports range, and `member` is nested in it.
    expect(names(result.value)).toEqual(["Store", "member", "run"]);
    expect(result.omitted).toBe(3);
  });

  test("reads a flat entry whose container names no symbol as top-level", () => {
    const result = dropImportSymbols([flat("a", VARIABLE, 0, "Missing")], imports);
    expect(result).toEqual({ value: [], omitted: 1 });
  });

  test("leaves the response alone without imports ranges, without a list, or without ranges", () => {
    const value = [symbol("a", VARIABLE, 0)];
    expect(dropImportSymbols(value, [])).toEqual({ value, omitted: 0 });
    expect(dropImportSymbols(null, imports)).toEqual({ value: null, omitted: 0 });
    const unreadable = [{ name: "a", kind: VARIABLE }, "text"];
    expect(dropImportSymbols(unreadable, imports)).toEqual({ value: unreadable, omitted: 0 });
  });
});
