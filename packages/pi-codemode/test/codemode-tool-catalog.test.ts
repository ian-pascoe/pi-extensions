import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  renderCodeModeToolCatalogue,
  searchCodeModeToolCatalogue,
  type CodeModeToolCatalogueTool,
} from "../src/codemode-tool-catalog.js";

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);
const typescriptDirectory = dirname(require.resolve("typescript/package.json"));

function tool(
  name: string,
  inputSchema: CodeModeToolCatalogueTool["inputSchema"],
  description?: string,
  outputSchema?: CodeModeToolCatalogueTool["outputSchema"],
  group = "test",
): CodeModeToolCatalogueTool {
  return {
    name,
    group,
    inputSchema,
    ...(description !== undefined && { description }),
    ...(outputSchema !== undefined && { outputSchema }),
  };
}

describe("renderCodeModeToolCatalogue", () => {
  test("renders sorted exact bracket keys and structural schemas that TypeScript accepts", async () => {
    const rendered = renderCodeModeToolCatalogue([
      tool(
        'quote" key',
        {
          type: "object",
          description: "A */ description",
          properties: {
            path: { type: "string" },
            mode: { enum: ["fast", "safe"] },
            options: { type: ["null", "object"], additionalProperties: { type: "number" } },
          },
          required: ["path"],
        },
        "A */ description",
        {
          type: "object",
          properties: { echoedPath: { type: "string" }, attempts: { type: "integer" } },
          required: ["echoedPath"],
          additionalProperties: false,
        },
      ),
      tool("alpha", { type: "array", prefixItems: [{ const: 1 }, { type: "boolean" }] }),
      tool("typed-extras", {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
        additionalProperties: { type: "number" },
      }),
    ]);

    expect(rendered).toMatchObject({ ok: true });
    if (!rendered.ok) return;
    expect(rendered.text).toContain('readonly ["alpha"]: (input: readonly [1, boolean])');
    expect(rendered.text).toContain('readonly ["quote\\\" key"]: (input: {');
    expect(rendered.text).toContain('readonly ["path"]: string;');
    expect(rendered.text).toContain('readonly ["mode"]?: "fast" | "safe";');
    expect(rendered.text).toContain('readonly ["label"]: string; readonly [key: string]: unknown;');
    expect(rendered.text).toContain("readonly [key: string]: unknown;");
    expect(rendered.text).toContain(
      'Promise<PiToolResult<{ readonly ["attempts"]?: number; readonly ["echoedPath"]: string; }>>',
    );
    expect(rendered.text).toContain(
      'readonly ["alpha"]: (input: readonly [1, boolean]) => Promise<PiToolResult<unknown>>;',
    );
    expect(rendered.text).toContain("A *\\/ description");
    await expectTypeScriptToAccept(rendered.text);
  }, 20_000);

  test("preserves boolean and non-TypeBox structural JSON Schemas", () => {
    const rendered = renderCodeModeToolCatalogue([
      tool("anything", true, undefined, true),
      tool("nothing", false, undefined, false),
      tool("undefined-details", { type: "object" }, undefined, { type: "undefined" }),
      tool("prototype-property", {
        type: "object",
        properties: Object.fromEntries([["__proto__", { type: "string" }]]),
        required: ["__proto__"],
        additionalProperties: false,
      }),
      tool("structural", {
        type: "object",
        properties: {
          "arbitrary/property": { oneOf: [{ type: "integer" }, { type: "null" }] },
        },
        required: ["arbitrary/property"],
        additionalProperties: false,
      }),
    ]);

    expect(rendered).toMatchObject({ ok: true });
    if (!rendered.ok) return;
    expect(rendered.text).toContain('readonly ["anything"]: (input: unknown)');
    expect(rendered.text).toContain('readonly ["nothing"]: (input: never)');
    expect(rendered.text).toContain(
      'readonly ["nothing"]: (input: never) => Promise<PiToolResult<never>>;',
    );
    expect(rendered.text).toContain("Promise<PiToolResult<undefined>>");
    expect(rendered.text).toContain('readonly ["__proto__"]: string;');
    expect(rendered.text).toContain('readonly ["arbitrary/property"]: number | null;');
  });

  test("resolves local definitions but makes recursive, deep, and unsupported regions unknown", () => {
    const rendered = renderCodeModeToolCatalogue([
      tool("local", {
        $defs: { identifier: { type: "string" } },
        type: "object",
        properties: { id: { $ref: "#/$defs/identifier" } },
        required: ["id"],
      }),
      tool("recursive", {
        $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } },
        $ref: "#/$defs/node",
      }),
      tool("external", { $ref: "https://example.test/schema" }),
    ]);

    expect(rendered).toMatchObject({ ok: true });
    if (!rendered.ok) return;
    expect(rendered.text).toContain('readonly ["id"]: string;');
    expect(rendered.text).toContain('readonly ["next"]?: unknown;');
    expect(rendered.text).toContain('readonly ["external"]: (input: unknown)');
  });

  test("bounds inline declarations and searches every omitted exact name", async () => {
    const hugeDescription = "d".repeat(4096);
    const tools = Array.from({ length: 220 }, (_, index) => {
      const schema = {
        type: "object",
        description: hugeDescription,
        properties: Object.fromEntries(
          Array.from({ length: 40 }, (_, propertyIndex) => [
            `property-${propertyIndex}`,
            { type: "string", description: hugeDescription },
          ]),
        ),
      };
      return tool(
        `tool-${String(index).padStart(3, "0")}`,
        schema,
        hugeDescription,
        schema,
        index % 2 === 0 ? "group-a" : "group-b",
      );
    });
    const rendered = renderCodeModeToolCatalogue([
      ...tools,
      tool("codemode_execute", { type: "string" }),
      tool("codemode_search", { type: "string" }),
    ]);

    expect(rendered).toMatchObject({ ok: true });
    if (!rendered.ok) return;
    expect(Math.ceil(Buffer.byteLength(rendered.text, "utf8") / 4)).toBeLessThanOrEqual(2_000);
    expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(1024 * 1024);
    expect(rendered).toMatchObject({ complete: false, totalCount: tools.length });
    expect(rendered.shownCount).toBeLessThan(tools.length);
    expect(rendered.text).not.toContain('readonly ["codemode_execute"]');
    expect(rendered.searchEntries.map((entry) => entry.name)).not.toContain("codemode_search");
    expect(rendered.searchEntries).toHaveLength(tools.length);
    expect(rendered.searchEntries.some((entry) => entry.group === "group-a")).toBe(true);
    expect(rendered.searchEntries.some((entry) => entry.group === "group-b")).toBe(true);

    const omitted = rendered.searchEntries.find(
      (entry) => !rendered.text.includes(`readonly [${JSON.stringify(entry.name)}]`),
    );
    expect(omitted).toBeDefined();
    if (omitted === undefined) return;
    const searched = searchCodeModeToolCatalogue(rendered.searchEntries, {
      query: omitted.name,
    });
    expect(searched).toMatchObject({
      ok: true,
      page: { total: 1, hasMore: false, nextOffset: null },
    });
    if (!searched.ok) return;
    expect(searched.page.items).toEqual([
      {
        name: omitted.name,
        group: omitted.group,
        description: omitted.description,
        declaration: omitted.declaration,
      },
    ]);
    await expectTypeScriptToAccept(rendered.text);
  }, 20_000);

  test("bounds group summaries and rejects a search declaration above its result limit", () => {
    const manyGroups = renderCodeModeToolCatalogue(
      Array.from({ length: 500 }, (_, index) =>
        tool(`tool-${index}`, { type: "object" }, undefined, undefined, `group-${index}`),
      ),
    );
    expect(manyGroups).toMatchObject({ ok: true, complete: false, totalCount: 500 });
    if (!manyGroups.ok) return;
    expect(Math.ceil(Buffer.byteLength(manyGroups.text, "utf8") / 4)).toBeLessThanOrEqual(2_000);
    expect(manyGroups.text).toMatch(/\/\/ - \.\.\. \d+ more groups/);

    const rendered = renderCodeModeToolCatalogue([
      tool("huge", {
        type: "object",
        properties: { ["x".repeat(1024 * 1024)]: { type: "string" } },
      }),
      tool("small", { type: "object" }),
    ]);
    expect(rendered).toMatchObject({ ok: true, complete: false });
    if (!rendered.ok) return;
    expect(searchCodeModeToolCatalogue(rendered.searchEntries, { query: "huge" })).toMatchObject({
      ok: true,
      page: {
        total: 1,
        hasMore: false,
        items: [
          {
            name: "huge",
            declarationError: "Complete declaration exceeds the 1 MiB CodeMode search result limit",
          },
        ],
      },
    });
    expect(searchCodeModeToolCatalogue(rendered.searchEntries, { limit: 1 })).toMatchObject({
      ok: true,
      page: {
        total: 2,
        hasMore: true,
        nextOffset: 1,
        items: [{ name: "huge", declarationError: expect.any(String) }],
      },
    });
    expect(
      searchCodeModeToolCatalogue(rendered.searchEntries, { limit: 1, offset: 1 }),
    ).toMatchObject({
      ok: true,
      page: {
        total: 2,
        hasMore: false,
        nextOffset: null,
        items: [{ name: "small", declaration: expect.any(String) }],
      },
    });
  }, 20_000);

  test("searches exact names, browses groups, paginates, and validates input", () => {
    const rendered = renderCodeModeToolCatalogue([
      tool("alpha_issue", { type: "object" }, "Find alpha issues", undefined, "issues"),
      tool("beta_issue", { type: "object" }, "Find beta issues", undefined, "issues"),
      tool("calendar_lookup", { type: "object" }, "Find calendar events", undefined, "calendar"),
    ]);
    expect(rendered).toMatchObject({ ok: true });
    if (!rendered.ok) return;

    expect(
      searchCodeModeToolCatalogue(rendered.searchEntries, {
        query: 'tools["beta_issue"]',
      }),
    ).toMatchObject({
      ok: true,
      page: { total: 1, items: [{ name: "beta_issue" }] },
    });
    expect(
      searchCodeModeToolCatalogue(rendered.searchEntries, {
        group: "issues",
        limit: 1,
      }),
    ).toMatchObject({
      ok: true,
      page: { total: 2, hasMore: true, nextOffset: 1, items: [{ name: "alpha_issue" }] },
    });
    expect(
      searchCodeModeToolCatalogue(rendered.searchEntries, {
        group: "issues",
        limit: 1,
        offset: 1,
      }),
    ).toMatchObject({
      ok: true,
      page: { total: 2, hasMore: false, nextOffset: null, items: [{ name: "beta_issue" }] },
    });
    expect(searchCodeModeToolCatalogue(rendered.searchEntries, { limit: 0 })).toMatchObject({
      ok: false,
      code: "validation",
    });
    expect(
      searchCodeModeToolCatalogue(rendered.searchEntries, { query: "issue", extra: true }),
    ).toMatchObject({ ok: false, code: "validation" });
  });
});

async function expectTypeScriptToAccept(catalogue: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-codemode-catalogue-"));
  try {
    const sourcePath = join(directory, "catalogue.ts");
    await writeFile(sourcePath, catalogue);
    await executeFile(process.execPath, [
      join(typescriptDirectory, "bin/tsc"),
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      sourcePath,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
