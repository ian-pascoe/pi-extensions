import { describe, expect, test } from "vitest";
import {
  boundLspCompletions,
  boundLspWorkspaceSymbols,
  completionPrefixAt,
  formatLspItemListText,
} from "../src/lsp-item-list.js";

/** Completion item fields the tests vary besides the label. */
interface CompletionFields {
  readonly kind?: number;
  readonly detail?: string;
  readonly labelDetails?: { readonly detail?: string; readonly description?: string };
  readonly filterText?: string;
  readonly sortText?: string;
  readonly data?: string | { readonly secret: string };
}

function completion(label: string, extra: CompletionFields = {}) {
  return { label, ...extra };
}

describe("completionPrefixAt", () => {
  test("is the identifier fragment before the one-based position", () => {
    const text = "const value = console.lo;\n  ém😀x\n";
    expect(completionPrefixAt(text, { line: 1, character: 25 })).toBe("lo");
    expect(completionPrefixAt(text, { line: 1, character: 23 })).toBe("");
    expect(completionPrefixAt(text, { line: 1, character: 12 })).toBe("value");
    expect(completionPrefixAt(text, { line: 1, character: 1 })).toBe("");
    expect(completionPrefixAt(text, { line: 2, character: 5 })).toBe("ém");
    expect(completionPrefixAt(text, { line: 2, character: 6 })).toBe("");
    expect(completionPrefixAt("$el_1 ", { line: 1, character: 6 })).toBe("$el_1");
  });
});

describe("boundLspCompletions", () => {
  test("keeps case-insensitive prefix matches in sort-text order up to the limit", () => {
    const bounded = boundLspCompletions(
      {
        isIncomplete: false,
        items: [
          completion("logError", { sortText: "2" }),
          completion("Log", { sortText: "1" }),
          completion("other"),
          completion("•lookup", { filterText: "lookup", sortText: "3" }),
          completion("lob", { sortText: "4" }),
        ],
      },
      { prefix: "lo", limit: 3 },
    );
    expect(bounded).toEqual({
      value: {
        isIncomplete: false,
        items: [
          completion("Log", { sortText: "1" }),
          completion("logError", { sortText: "2" }),
          completion("•lookup", { filterText: "lookup", sortText: "3" }),
        ],
      },
      omitted: 1,
    });
  });

  test("matches filter text after leading sigils such as # and @", () => {
    const items = [completion("#private"), completion("@decorator"), completion("prior")];
    expect(boundLspCompletions(items, { prefix: "pri", limit: 5 }).value).toEqual([
      completion("#private"),
      completion("prior"),
    ]);
    expect(boundLspCompletions(items, { prefix: "#p", limit: 5 }).value).toEqual([
      completion("#private"),
    ]);
  });

  test("bounds a bare item array and keeps every item for an empty prefix", () => {
    const items = ["b", "a", "c"].map((label) => completion(label));
    expect(boundLspCompletions(items, { prefix: "", limit: 2 })).toEqual({
      value: [completion("a"), completion("b")],
      omitted: 1,
    });
    expect(boundLspCompletions(null, { prefix: "x", limit: 2 })).toEqual({
      value: null,
      omitted: 0,
    });
  });
});

describe("boundLspWorkspaceSymbols", () => {
  test("keeps the server's order up to the limit", () => {
    const symbols = ["c", "a", "b"].map((name) => ({ name, kind: 12, location: { uri: "/a" } }));
    expect(boundLspWorkspaceSymbols(symbols, 2)).toEqual({
      value: symbols.slice(0, 2),
      omitted: 1,
    });
    expect(boundLspWorkspaceSymbols(null, 2)).toEqual({ value: null, omitted: 0 });
  });
});

describe("formatLspItemListText", () => {
  test("lists one completion per line without server-private data and states the omitted count", async () => {
    const text = await formatLspItemListText({
      operation: "completion",
      cwd: "/workspace",
      documentPath: "/workspace/src/a.ts",
      reads: [
        {
          server_id: "typescript",
          prefix: "lo",
          omitted: 12,
          value: {
            isIncomplete: true,
            items: [
              completion("log", {
                kind: 2,
                detail: "(method) Console.log(...data: any[]): void",
                data: { secret: "resolve-token" },
              }),
              completion("logger", {
                kind: 6,
                labelDetails: { description: "./logger" },
                data: "opaque",
              }),
              completion("lookup", {
                labelDetails: { detail: "(key)" },
                detail: "function lookup(\n  key: string,\n): void",
              }),
              completion("loop", { kind: 99 }),
            ],
          },
        },
      ],
      warnings: [],
    });
    expect(text).toBe(
      [
        'Completions starting with "lo":',
        "log (method)  (method) Console.log(...data: any[]): void",
        "logger (variable)  ./logger",
        "lookup(key)  function lookup( key: string, ): void",
        "loop (kind 99)",
        "12 more omitted; raise limit or refine the prefix to see them.",
        "The server's list is incomplete; a longer prefix may return other items.",
      ].join("\n"),
    );
    expect(text).not.toContain("resolve-token");
    expect(text).not.toContain("opaque");
  });

  test("says when nothing matches and groups several servers with warnings", async () => {
    expect(
      await formatLspItemListText({
        operation: "completion",
        cwd: "/workspace",
        documentPath: "/workspace/src/a.ts",
        reads: [{ server_id: "typescript", prefix: "zz", omitted: 0, value: [] }],
        warnings: [],
      }),
    ).toBe('No completions start with "zz".');
    expect(
      await formatLspItemListText({
        operation: "completion",
        cwd: "/workspace",
        documentPath: "/workspace/src/a.ts",
        reads: [
          { server_id: "typescript", prefix: "", omitted: 0, value: null },
          { server_id: "eslint", prefix: "", omitted: 0, value: [completion("a", { kind: 14 })] },
        ],
        warnings: ["biome: timed out"],
      }),
    ).toBe(
      [
        "typescript:",
        "  No completions.",
        "eslint:",
        "  a (keyword)",
        "",
        "Warning: biome: timed out",
      ].join("\n"),
    );
  });

  test("lists workspace symbols in the shared symbol format with the omitted count", async () => {
    const text = await formatLspItemListText({
      operation: "workspace_symbols",
      cwd: "/workspace",
      documentPath: "/workspace/src/a.ts",
      reads: [
        {
          server_id: "typescript",
          omitted: 3,
          value: [
            {
              name: "Widget",
              kind: 5,
              location: {
                uri: "/workspace/src/widget.ts",
                range: { start: { line: 3, character: 14 }, end: { line: 3, character: 20 } },
              },
            },
            {
              name: "render",
              kind: 6,
              containerName: "Widget",
              location: {
                uri: "/workspace/src/widget.ts",
                range: { start: { line: 5, character: 3 }, end: { line: 5, character: 9 } },
              },
              data: { secret: "resolve-token" },
            },
            { name: "external", kind: 22, location: { uri: "/other/lib.ts" } },
          ],
        },
      ],
      warnings: [],
    });
    expect(text).toBe(
      [
        "Widget (class) src/widget.ts:3:14",
        "render (method) src/widget.ts:5:3  in Widget",
        "external (enum member) /other/lib.ts",
        "3 more omitted; raise limit or refine the query to see them.",
      ].join("\n"),
    );
    expect(
      await formatLspItemListText({
        operation: "workspace_symbols",
        cwd: "/workspace",
        documentPath: "/workspace/src/a.ts",
        reads: [{ server_id: "typescript", omitted: 0, value: [] }],
        warnings: [],
      }),
    ).toBe("No symbols found.");
  });
});
