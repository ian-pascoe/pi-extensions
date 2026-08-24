import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  renderCodeModeToolCatalogue,
  type CodeModeToolCatalogueTool,
} from "../src/codemode-tool-catalog.js";

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);
const typescriptDirectory = dirname(require.resolve("typescript/package.json"));

function tool(
  name: string,
  inputSchema: CodeModeToolCatalogueTool["inputSchema"],
  description?: string,
): CodeModeToolCatalogueTool {
  if (description === undefined) return { name, inputSchema };
  return { name, inputSchema, description };
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
    expect(rendered.text).toContain("A *\\/ description");
    await expectTypeScriptToAccept(rendered.text);
  }, 20_000);

  test("preserves boolean and non-TypeBox structural JSON Schemas", () => {
    const rendered = renderCodeModeToolCatalogue([
      tool("anything", true),
      tool("nothing", false),
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

  test("retains every non-reserved exact name when it degrades an oversized catalogue", () => {
    const hugeDescription = "d".repeat(4096);
    const tools = Array.from({ length: 220 }, (_, index) =>
      tool(`tool-${String(index).padStart(3, "0")}`, {
        type: "object",
        description: hugeDescription,
        properties: Object.fromEntries(
          Array.from({ length: 40 }, (_, propertyIndex) => [
            `property-${propertyIndex}`,
            { type: "string", description: hugeDescription },
          ]),
        ),
      }),
    );
    const rendered = renderCodeModeToolCatalogue([
      ...tools,
      tool("codemode_execute", { type: "string" }),
    ]);

    expect(rendered).toMatchObject({ ok: true });
    if (!rendered.ok) return;
    expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(1024 * 1024);
    expect(rendered.text).not.toContain('readonly ["codemode_execute"]');
    for (const candidate of tools) {
      expect(rendered.text).toContain(`readonly [${JSON.stringify(candidate.name)}]`);
    }
  });

  test("fails coherently when exact names and unknown signatures alone exceed the bound", () => {
    const rendered = renderCodeModeToolCatalogue([
      tool("x".repeat(1024 * 1024), { type: "string" }),
    ]);

    expect(rendered).toEqual({ ok: false, reason: "names-exceed-catalogue-limit" });
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
