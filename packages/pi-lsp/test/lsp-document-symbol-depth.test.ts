import { describe, expect, test } from "vitest";
import { limitLspDocumentSymbolDepth } from "../src/lsp-document-symbol-depth.js";
import type { LspDocumentSymbolDepth } from "../src/lsp-tool-contract.js";

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Test helper passes opaque protocol responses through.
function limit(value: unknown, depth: LspDocumentSymbolDepth): unknown {
  return limitLspDocumentSymbolDepth(value, depth).value;
}
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test helper passes opaque protocol responses through.
function omitted(value: unknown, depth: LspDocumentSymbolDepth): number {
  return limitLspDocumentSymbolDepth(value, depth).omitted;
}

const FUNCTION = 12;
const VARIABLE = 13;
const CLASS = 5;
const METHOD = 6;
const PROPERTY = 7;
const NAMESPACE = 3;
const INTERFACE = 11;
const ENUM = 10;
const ENUM_MEMBER = 22;

function range(startLine: number, endLine: number) {
  return {
    start: { line: startLine, character: 0 },
    end: { line: endLine, character: 0 },
  };
}

function tree(name: string, kind: number, children: readonly unknown[] = []) {
  return {
    name,
    kind,
    range: range(0, 1),
    selectionRange: range(0, 0),
    children,
  };
}

/** Names of a symbol tree, depth first, each indented under its parent. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test helper reads an opaque filter result.
function outline(value: unknown, indent = ""): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => [
    `${indent}${item.name}`,
    ...outline(item.children, `${indent}  `),
  ]);
}

const nested = [
  tree("Store", CLASS, [
    tree("add", METHOD, [tree("draft", VARIABLE, [tree("id", PROPERTY)])]),
    tree("size", PROPERTY),
  ]),
  tree("create", FUNCTION, [
    tree("state", VARIABLE),
    tree("find() callback", FUNCTION, [tree("task", VARIABLE)]),
    tree("Local", CLASS, [tree("run", METHOD, [tree("inner", VARIABLE)])]),
  ]),
  tree("result", VARIABLE, [tree("ok", PROPERTY), tree("state", PROPERTY)]),
  tree("Shapes", NAMESPACE, [
    tree("Circle", INTERFACE, [tree("radius", PROPERTY)]),
    tree("Kind", ENUM, [tree("Round", ENUM_MEMBER)]),
    tree("area", FUNCTION, [tree("pi", VARIABLE)]),
  ]),
];

describe("limitLspDocumentSymbolDepth", () => {
  test("by default keeps declarations and container members, not body content", () => {
    expect(outline(limit(nested, 1))).toEqual([
      "Store",
      "  add",
      "  size",
      "create",
      "result",
      "Shapes",
      "  Circle",
      "    radius",
      "  Kind",
      "    Round",
      "  area",
    ]);
  });

  test("each further level adds one level inside function, method, and variable bodies", () => {
    expect(outline(limit(nested, 2))).toEqual([
      "Store",
      "  add",
      "    draft",
      "  size",
      "create",
      "  state",
      "  find() callback",
      "  Local",
      "    run",
      "result",
      "  ok",
      "  state",
      "Shapes",
      "  Circle",
      "    radius",
      "  Kind",
      "    Round",
      "  area",
      "    pi",
    ]);
  });

  test('"all" keeps the full tree untouched', () => {
    expect(limit(nested, "all")).toBe(nested);
    // Every level is reachable by count too.
    expect(outline(limit(nested, 3))).toEqual(outline(nested));
  });

  test("leaves a dropped symbol's own fields and an empty children list in place", () => {
    expect(limit([tree("create", FUNCTION, [tree("x", VARIABLE)])], 1)).toMatchObject([
      { name: "create", children: [], selectionRange: range(0, 0) },
    ]);
  });

  test("keeps the members of an Object symbol, which rust-analyzer reports for an impl block", () => {
    const OBJECT = 19;
    const impl = [
      tree("impl Store", OBJECT, [
        tree("add", METHOD, [tree("draft", VARIABLE)]),
        tree("size", METHOD),
      ]),
    ];
    expect(outline(limit(impl, 1))).toEqual(["impl Store", "  add", "  size"]);
    expect(omitted(impl, 1)).toBe(1);
  });

  test("counts the nested symbols a depth drops", () => {
    expect(omitted(nested, 1)).toBe(outline(nested).length - outline(limit(nested, 1)).length);
    expect(omitted(nested, 2)).toBe(3);
    expect(omitted(nested, "all")).toBe(0);
    expect(omitted(nested, 3)).toBe(0);
  });

  test("passes null and empty responses through", () => {
    expect(limit(null, 1)).toBeNull();
    expect(limit([], 1)).toEqual([]);
  });

  describe("a flat SymbolInformation[] response", () => {
    const uri = "file:///a.ts";
    function flat(name: string, kind: number, lines: [number, number], containerName = "") {
      return {
        name,
        kind,
        location: { uri, range: range(...lines) },
        containerName,
      };
    }
    function symbolWithSelfContainer() {
      return [flat("loop", FUNCTION, [0, 1], "loop")];
    }
    const symbols = [
      flat("Store", CLASS, [0, 10]),
      flat("add", METHOD, [1, 5], "Store"),
      flat("draft", VARIABLE, [2, 3], "add"),
      flat("create", FUNCTION, [11, 20]),
      flat("state", VARIABLE, [12, 12], "create"),
      // The same name in another container resolves to the enclosing one.
      flat("add", FUNCTION, [21, 30]),
      flat("draft", VARIABLE, [22, 23], "add"),
      flat("size", PROPERTY, [6, 6], "Store"),
      flat("Shapes", NAMESPACE, [31, 40], ""),
      flat("Circle", INTERFACE, [32, 35], "Shapes"),
      flat("radius", PROPERTY, [33, 33], "Circle"),
    ];

    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test helper reads an opaque filter result.
    function names(value: unknown) {
      return Array.isArray(value)
        ? value.map((item) => `${item.name}@${item.location.range.start.line}`)
        : [];
    }

    test("drops entries nested in a function, method, or variable by containerName", () => {
      expect(names(limit(symbols, 1))).toEqual([
        "Store@0",
        "add@1",
        "create@11",
        "add@21",
        "size@6",
        "Shapes@31",
        "Circle@32",
        "radius@33",
      ]);
    });

    test("adds a level of body content per depth and keeps everything for all", () => {
      expect(names(limit(symbols, 2))).toHaveLength(symbols.length);
      expect(limit(symbols, "all")).toBe(symbols);
    });

    test("counts the entries a depth drops and keeps the members of an Object entry", () => {
      expect(omitted(symbols, 1)).toBe(3);
      const impl = [
        flat("impl Store", 19, [0, 10]),
        flat("add", METHOD, [1, 5], "impl Store"),
        flat("draft", VARIABLE, [2, 3], "add"),
      ];
      expect(names(limit(impl, 1))).toEqual(["impl Store@0", "add@1"]);
    });

    test("survives containers that name each other, treating a revisited entry as top-level", () => {
      // `a` sits inside `b` by range, `b` names unranged `c` as its container, and `c` names `a`.
      const cyclic = [
        flat("a", VARIABLE, [2, 3], "b"),
        { name: "c", kind: FUNCTION, containerName: "a", location: { uri } },
        flat("b", FUNCTION, [1, 10], "c"),
      ];
      const unranged = [
        { name: "x", kind: FUNCTION, containerName: "y", location: { uri } },
        { name: "y", kind: FUNCTION, containerName: "x", location: { uri } },
      ];
      expect(() => limit(cyclic, 1)).not.toThrow();
      expect(() => limit(unranged, 1)).not.toThrow();
      expect(() => limit(symbolWithSelfContainer(), 1)).not.toThrow();
    });

    test("resolves tens of thousands of entries without quadratic scans", () => {
      const many = [
        flat("root", FUNCTION, [0, 100_000]),
        ...Array.from({ length: 20_000 }, (_, index) =>
          flat(`s${index}`, VARIABLE, [index + 1, index + 1], "root"),
        ),
      ];
      const started = performance.now();
      expect(limit(many, 1)).toHaveLength(1);
      expect(performance.now() - started).toBeLessThan(2000);
    });

    test("treats an unknown container, or one without ranges, as best effort", () => {
      const unranged = [
        { name: "f", kind: FUNCTION, location: { uri } },
        { name: "x", kind: VARIABLE, containerName: "f", location: { uri } },
        { name: "y", kind: VARIABLE, containerName: "missing", location: { uri } },
      ];
      const kept = limit(unranged, 1);
      expect(Array.isArray(kept) ? kept.map(({ name }) => name) : kept).toEqual(["f", "y"]);
    });
  });
});
