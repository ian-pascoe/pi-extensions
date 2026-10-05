import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { formatLspLocationReadText, lspDisplayPath } from "../src/lsp-location-text.js";

const temporaryDirectories: string[] = [];

async function workspace(files: Readonly<Record<string, string>>): Promise<string> {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-lsp-location-text-"));
  temporaryDirectories.push(cwd);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(resolve(cwd, path)), { recursive: true });
    await writeFile(resolve(cwd, path), text);
  }
  return cwd;
}

function range(line: number, character: number) {
  return { start: { line, character }, end: { line, character: character + 1 } };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("lspDisplayPath", () => {
  test("is relative inside the working directory and absolute outside it", () => {
    expect(lspDisplayPath("/workspace", "/workspace/src/a.ts")).toBe("src/a.ts");
    expect(lspDisplayPath("/workspace", "/workspace/..hidden/a.ts")).toBe("..hidden/a.ts");
    expect(lspDisplayPath("/workspace", "/workspace")).toBe("/workspace");
    expect(lspDisplayPath("/workspace", "/other/a.ts")).toBe("/other/a.ts");
    expect(lspDisplayPath("/workspace", "/workspace-two/a.ts")).toBe("/workspace-two/a.ts");
    expect(lspDisplayPath("/workspace", "@/workspace/src/a.ts")).toBe("src/a.ts");
    expect(lspDisplayPath("/workspace", "src/a.ts")).toBe("src/a.ts");
  });
});

describe("formatLspLocationReadText", () => {
  test("renders one line per reference with relative paths and trimmed source lines", async () => {
    const cwd = await workspace({
      "src/a.ts": "export const value = 1;\n",
      "src/b.ts": "import { value } from './a';\n\n    console.log(value);\n",
    });
    const text = await formatLspLocationReadText({
      operation: "find_references",
      cwd,
      documentPath: resolve(cwd, "src/a.ts"),
      reads: [
        {
          server_id: "typescript",
          value: [
            { uri: resolve(cwd, "src/a.ts"), range: range(1, 14) },
            { uri: resolve(cwd, "src/b.ts"), range: range(1, 10) },
            { uri: resolve(cwd, "src/b.ts"), range: range(3, 17) },
            { uri: "/outside/c.ts", range: range(2, 1) },
          ],
        },
      ],
      warnings: [],
    });
    expect(text).toBe(
      [
        "src/a.ts:1:14  export const value = 1;",
        "src/b.ts:1:10  import { value } from './a';",
        "src/b.ts:3:17  console.log(value);",
        "/outside/c.ts:2:1",
      ].join("\n"),
    );
  });

  test("groups by server only when more than one server answered, then lists warnings", async () => {
    const cwd = await workspace({ "a.ts": "let x = 1;\n" });
    const location = { uri: resolve(cwd, "a.ts"), range: range(1, 5) };
    const text = await formatLspLocationReadText({
      operation: "goto_definition",
      cwd,
      documentPath: resolve(cwd, "a.ts"),
      reads: [
        { server_id: "typescript", value: location },
        { server_id: "deno", value: null },
      ],
      warnings: ["eslint: timed out"],
    });
    expect(text).toBe(
      [
        "typescript:",
        "  a.ts:1:5  let x = 1;",
        "deno:",
        "  No locations found.",
        "",
        "Warning: eslint: timed out",
      ].join("\n"),
    );
  });

  test("renders LocationLinks at their target selection range", async () => {
    const cwd = await workspace({ "target.ts": "\nfunction target() {}\n" });
    const text = await formatLspLocationReadText({
      operation: "goto_implementation",
      cwd,
      documentPath: resolve(cwd, "source.ts"),
      reads: [
        {
          server_id: "typescript",
          value: [
            {
              originSelectionRange: range(1, 1),
              targetUri: resolve(cwd, "target.ts"),
              targetRange: range(2, 1),
              targetSelectionRange: range(2, 10),
            },
          ],
        },
      ],
      warnings: [],
    });
    expect(text).toBe("target.ts:2:10  function target() {}");
  });

  test("names highlight kinds and locates highlights in the queried document", async () => {
    const cwd = await workspace({ "a.ts": "let x = 1;\nx = x + 1;\n" });
    const text = await formatLspLocationReadText({
      operation: "document_highlights",
      cwd,
      documentPath: resolve(cwd, "a.ts"),
      reads: [
        {
          server_id: "typescript",
          value: [
            { range: range(1, 5), kind: 3 },
            { range: range(2, 1), kind: 3 },
            { range: range(2, 5), kind: 2 },
            { range: range(2, 5), kind: 1 },
            { range: range(1, 5) },
          ],
        },
      ],
      warnings: [],
    });
    expect(text).toBe(
      [
        "a.ts:1:5 write  let x = 1;",
        "a.ts:2:1 write  x = x + 1;",
        "a.ts:2:5 read  x = x + 1;",
        "a.ts:2:5 text  x = x + 1;",
        "a.ts:1:5  let x = 1;",
      ].join("\n"),
    );
  });

  test("states empty results and falls back to JSON for unrecognized values", async () => {
    const cwd = await workspace({});
    expect(
      await formatLspLocationReadText({
        operation: "find_references",
        cwd,
        documentPath: resolve(cwd, "a.ts"),
        reads: [{ server_id: "typescript", value: [] }],
        warnings: [],
      }),
    ).toBe("No references found.");
    expect(
      await formatLspLocationReadText({
        operation: "document_highlights",
        cwd,
        documentPath: resolve(cwd, "a.ts"),
        reads: [{ server_id: "typescript", value: { unexpected: true } }],
        warnings: [],
      }),
    ).toBe('{"unexpected":true}');
  });

  test("shortens very long source lines", async () => {
    const cwd = await workspace({ "min.js": `${"a".repeat(500)}\n` });
    const text = await formatLspLocationReadText({
      operation: "declaration",
      cwd,
      documentPath: resolve(cwd, "min.js"),
      reads: [
        { server_id: "typescript", value: [{ uri: resolve(cwd, "min.js"), range: range(1, 1) }] },
      ],
      warnings: [],
    });
    expect(text).toBe(`min.js:1:1  ${"a".repeat(200)}…`);
  });
});
