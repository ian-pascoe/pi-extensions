import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  formatLspStructureReadText,
  type LspStructureReadTextInput,
} from "../src/lsp-structure-text.js";

const temporaryDirectories: string[] = [];

async function workspace(files: Readonly<Record<string, string>>): Promise<string> {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-lsp-structure-text-"));
  temporaryDirectories.push(cwd);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(resolve(cwd, path)), { recursive: true });
    await writeFile(resolve(cwd, path), text);
  }
  return cwd;
}

/** A one-based normalized range, as Structured Results carry them. */
function range(line: number, character: number, endLine = line, endCharacter = character + 1) {
  return { start: { line, character }, end: { line: endLine, character: endCharacter } };
}

function hierarchyItem(name: string, kind: number, uri: string, line: number, character: number) {
  return {
    name,
    kind,
    uri,
    range: range(line, 1, line + 2, 2),
    selectionRange: range(line, character),
  };
}

async function render(
  cwd: string,
  input: Omit<LspStructureReadTextInput, "cwd" | "warnings" | "reads"> & {
    readonly value: unknown;
  },
): Promise<string> {
  const { value, ...rest } = input;
  return formatLspStructureReadText({
    ...rest,
    cwd,
    reads: [{ server_id: "typescript", value }],
    warnings: [],
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("formatLspStructureReadText", () => {
  test("renders document symbols as an indented outline with named kinds", async () => {
    const cwd = await workspace({});
    const path = resolve(cwd, "src/a.ts");
    const text = await render(cwd, {
      operation: "document_symbols",
      documentPath: path,
      value: [
        {
          name: "Greeter",
          kind: 5,
          range: range(1, 1, 4, 2),
          selectionRange: range(1, 7),
          children: [
            { name: "name", kind: 7, range: range(2, 3), selectionRange: range(2, 3) },
            {
              name: "greet",
              kind: 6,
              detail: "(): \n   void",
              range: range(3, 3),
              selectionRange: range(3, 3),
              children: [{ name: "T", kind: 26, range: range(3, 9), selectionRange: range(3, 9) }],
            },
          ],
        },
        { name: "helper", kind: 12, tags: [1], range: range(5, 1), selectionRange: range(5, 10) },
        { name: "odd", kind: 99, range: range(6, 1), selectionRange: range(6, 1) },
      ],
    });
    expect(text).toBe(
      [
        "Greeter (class) src/a.ts:1:7",
        "  name (property) src/a.ts:2:3",
        "  greet (method) src/a.ts:3:3  (): void",
        "    T (type parameter) src/a.ts:3:9",
        "helper (function, deprecated) src/a.ts:5:10",
        "odd (kind 99) src/a.ts:6:1",
      ].join("\n"),
    );
  });

  test("renders workspace symbols with their containers and URI-only locations", async () => {
    const cwd = await workspace({});
    const text = await render(cwd, {
      operation: "workspace_symbols",
      documentPath: resolve(cwd, "src/a.ts"),
      value: [
        {
          name: "greet",
          kind: 6,
          containerName: "Greeter",
          location: { uri: resolve(cwd, "src/a.ts"), range: range(3, 3) },
        },
        { name: "Greeter", kind: 5, location: { uri: resolve(cwd, "src/a.ts") } },
        {
          name: "old",
          kind: 13,
          deprecated: true,
          location: { uri: "/outside/b.ts", range: range(1, 7) },
        },
      ],
    });
    expect(text).toBe(
      [
        "greet (method) src/a.ts:3:3  in Greeter",
        "Greeter (class) src/a.ts",
        "old (variable, deprecated) /outside/b.ts:1:7",
      ].join("\n"),
    );
  });

  test("renders hierarchy items as name (kind) path:line:col", async () => {
    const cwd = await workspace({});
    const text = await render(cwd, {
      operation: "supertypes",
      documentPath: resolve(cwd, "src/a.ts"),
      value: [
        hierarchyItem("Base", 5, resolve(cwd, "src/base.ts"), 1, 14),
        { ...hierarchyItem("Named", 11, resolve(cwd, "src/named.ts"), 2, 18), detail: "named.ts" },
      ],
    });
    expect(text).toBe(
      ["Base (class) src/base.ts:1:14", "Named (interface) src/named.ts:2:18  named.ts"].join("\n"),
    );
  });

  test("renders incoming calls with each call site in the caller's file", async () => {
    const cwd = await workspace({
      "src/caller.ts": "export function caller() {\n  callee();\n  if (x) callee();\n}\n",
    });
    const callerPath = resolve(cwd, "src/caller.ts");
    const text = await render(cwd, {
      operation: "incoming_calls",
      documentPath: resolve(cwd, "src/callee.ts"),
      value: [
        {
          from: hierarchyItem("caller", 12, callerPath, 1, 17),
          fromRanges: [range(2, 3, 2, 9), range(3, 10, 3, 16)],
        },
      ],
    });
    expect(text).toBe(
      [
        "caller (function) src/caller.ts:1:17",
        "  src/caller.ts:2:3  callee();",
        "  src/caller.ts:3:10  if (x) callee();",
      ].join("\n"),
    );
  });

  test("renders outgoing calls with each call site in the queried file", async () => {
    const cwd = await workspace({ "src/main.ts": "function main() {\n  callee();\n}\n" });
    const text = await render(cwd, {
      operation: "outgoing_calls",
      documentPath: resolve(cwd, "src/main.ts"),
      value: [
        {
          to: hierarchyItem("callee", 12, resolve(cwd, "src/callee.ts"), 1, 17),
          fromRanges: [range(2, 3, 2, 9)],
        },
      ],
    });
    expect(text).toBe(
      ["callee (function) src/callee.ts:1:17", "  src/main.ts:2:3  callee();"].join("\n"),
    );
  });

  test("renders selection ranges as a flat innermost-to-outermost list", async () => {
    const cwd = await workspace({});
    const value = [
      {
        range: range(2, 9, 2, 14),
        parent: { range: range(2, 3, 2, 15), parent: { range: range(1, 1, 3, 2) } },
      },
    ];
    expect(
      await render(cwd, {
        operation: "selection_ranges",
        documentPath: resolve(cwd, "a.ts"),
        value,
      }),
    ).toBe(["2:9-2:14", "2:3-2:15", "1:1-3:2"].join("\n"));
    expect(
      await render(cwd, {
        operation: "selection_ranges",
        documentPath: resolve(cwd, "a.ts"),
        positions: [
          { line: 2, character: 10 },
          { line: 1, character: 1 },
        ],
        value: [...value, { range: range(1, 1, 3, 2) }],
      }),
    ).toBe(["2:10:", "  2:9-2:14", "  2:3-2:15", "  1:1-3:2", "1:1:", "  1:1-3:2"].join("\n"));
  });

  test("renders folding ranges as startLine-endLine kind with the first line", async () => {
    const cwd = await workspace({
      "a.ts":
        "import { a } from './a';\nimport { b } from './b';\nfunction f() {\n  return 1;\n}\n",
    });
    const text = await render(cwd, {
      operation: "folding_ranges",
      documentPath: resolve(cwd, "a.ts"),
      value: [
        { startLine: 1, endLine: 2, kind: "imports" },
        { startLine: 3, startCharacter: 15, endLine: 4, endCharacter: 12 },
      ],
    });
    expect(text).toBe(["1-2 imports  import { a } from './a';", "3-4  function f() {"].join("\n"));
  });

  test("groups by server, states empty results, and falls back to JSON for unrecognized values", async () => {
    const cwd = await workspace({});
    const text = await formatLspStructureReadText({
      operation: "call_hierarchy",
      cwd,
      documentPath: resolve(cwd, "a.ts"),
      reads: [
        { server_id: "typescript", value: [] },
        { server_id: "deno", value: null },
        { server_id: "odd", value: [{ name: "missing kind" }] },
      ],
      warnings: ["eslint: timed out"],
    });
    expect(text).toBe(
      [
        "typescript:",
        "  No call hierarchy items found.",
        "deno:",
        "  No call hierarchy items found.",
        "odd:",
        '  [{"name":"missing kind"}]',
        "",
        "Warning: eslint: timed out",
      ].join("\n"),
    );
  });
});
