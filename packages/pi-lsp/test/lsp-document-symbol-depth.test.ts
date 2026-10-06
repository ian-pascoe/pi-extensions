import { describe, expect, test } from "vitest";
import { limitLspDocumentSymbolDepth } from "../src/lsp-document-symbol-depth.js";

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
    expect(outline(limitLspDocumentSymbolDepth(nested, 1))).toEqual([
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
    expect(outline(limitLspDocumentSymbolDepth(nested, 2))).toEqual([
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
    expect(limitLspDocumentSymbolDepth(nested, "all")).toBe(nested);
    // Every level is reachable by count too.
    expect(outline(limitLspDocumentSymbolDepth(nested, 3))).toEqual(outline(nested));
  });

  test("leaves a dropped symbol's own fields and an empty children list in place", () => {
    expect(
      limitLspDocumentSymbolDepth([tree("create", FUNCTION, [tree("x", VARIABLE)])], 1),
    ).toMatchObject([{ name: "create", children: [], selectionRange: range(0, 0) }]);
  });

  test("passes null and empty responses through", () => {
    expect(limitLspDocumentSymbolDepth(null, 1)).toBeNull();
    expect(limitLspDocumentSymbolDepth([], 1)).toEqual([]);
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
      expect(names(limitLspDocumentSymbolDepth(symbols, 1))).toEqual([
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
      expect(names(limitLspDocumentSymbolDepth(symbols, 2))).toHaveLength(symbols.length);
      expect(limitLspDocumentSymbolDepth(symbols, "all")).toBe(symbols);
    });

    test("treats an unknown container, or one without ranges, as best effort", () => {
      const unranged = [
        { name: "f", kind: FUNCTION, location: { uri } },
        { name: "x", kind: VARIABLE, containerName: "f", location: { uri } },
        { name: "y", kind: VARIABLE, containerName: "missing", location: { uri } },
      ];
      const kept = limitLspDocumentSymbolDepth(unranged, 1);
      expect(Array.isArray(kept) ? kept.map(({ name }) => name) : kept).toEqual(["f", "y"]);
    });
  });
});
