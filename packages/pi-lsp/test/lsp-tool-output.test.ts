import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import {
  LspApplyOutputSchema,
  LspCodeActionsOutputSchema,
  LspPreviewOutputSchema,
  LspReadOutputSchema,
  LspServerOutputSchema,
  LspStatusOutputSchema,
} from "../src/lsp-tool-contract.js";
import type { LspSessionFiles } from "../src/lsp-session-files.js";
import {
  boundLspStructuredFields,
  createLspToolOutput,
  type LspStructuredFields,
  LSP_STRUCTURED_CONTENT_MAX_BYTES,
} from "../src/lsp-tool-output.js";

const bytesOf = (value: LspStructuredFields) => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("boundLspStructuredFields", () => {
  test("returns results within the cap untouched", () => {
    const fields = { results: [{ value: "small" }], warnings: [] };
    const bounded = boundLspStructuredFields(fields);
    expect(bounded.bounded).toBe(false);
    expect(bounded.fields).toBe(fields);
  });

  test("caps at 1 MiB like Pi's built-in bash tool", () => {
    expect(LSP_STRUCTURED_CONTENT_MAX_BYTES).toBe(1024 * 1024);
  });

  test("shortens the largest strings and array tails deterministically, keeping structure", () => {
    const fields = {
      results: [
        { server_id: "a", value: "é".repeat(2 * 1024 * 1024) },
        {
          server_id: "b",
          value: Array.from({ length: 200_000 }, (_, index) => ({ index })),
        },
      ],
      warnings: ["kept"],
    };
    const first = boundLspStructuredFields(fields);
    const second = boundLspStructuredFields(fields);
    expect(first.bounded).toBe(true);
    expect(first.fields).toEqual(second.fields);
    expect(bytesOf(first.fields)).toBeLessThanOrEqual(LSP_STRUCTURED_CONTENT_MAX_BYTES);
    expect(first.fields).toMatchObject({
      results: [{ server_id: "a" }, { server_id: "b" }],
      warnings: ["kept"],
    });
    const [text, list] = Array.isArray(first.fields["results"]) ? first.fields["results"] : [];
    expect(JSON.stringify(text)).toContain("characters truncated");
    expect(JSON.stringify(list)).toContain('"index":0');
    expect(JSON.stringify(list)).not.toContain('"index":199999');
  });

  test("never cuts server_preview_ids and honors a smaller cap", () => {
    const ids = Array.from({ length: 50 }, (_, index) => `preview-${index}`);
    const bounded = boundLspStructuredFields(
      {
        values: Array.from({ length: 5000 }, (_, index) => `value-${index}`),
        server_preview_ids: ids,
      },
      20_000,
    );
    expect(bounded.bounded).toBe(true);
    expect(bounded.fields["server_preview_ids"]).toEqual(ids);
    expect(bytesOf(bounded.fields)).toBeLessThanOrEqual(20_000);
  });

  test("does not split a surrogate pair when cutting a string", () => {
    const bounded = boundLspStructuredFields({
      text: `a${"😀".repeat(1024 * 1024)}`,
    });
    // A lone surrogate would serialize as an escape, so none may appear in the output.
    expect(JSON.stringify(bounded.fields)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/iu);
  });
});

function memorySessionFiles() {
  const spills: string[] = [];
  const sessionFiles: LspSessionFiles = {
    directoryPath: "/tmp/spill",
    writeResultSpill: (output) => {
      spills.push(output);
      return Promise.resolve(`/tmp/spill/${spills.length - 1}.txt`);
    },
    getServerStderrPath: () => Promise.resolve("/tmp/spill/stderr.log"),
    close: () => Promise.resolve(),
  };
  return { sessionFiles, spills };
}

const big = (length: number) => "z".repeat(length);
const paths = Array.from({ length: 500 }, (_, index) => `/repo/file-${index}.ts`);
const manifest = paths.map((path) => ({ operation: "modify" as const, path }));

/** One oversized sample of every output shape, with enum and identifying fields. */
const BOUNDED_OUTPUT_CASES = [
  {
    name: "read",
    schema: LspReadOutputSchema,
    fields: {
      results: [{ server_id: "ts", root_path: "/repo", value: [big(50_000), big(50_000)] }],
      warnings: [big(5000)],
    },
  },
  {
    name: "status",
    schema: LspStatusOutputSchema,
    fields: {
      servers: Array.from({ length: 200 }, (_, index) => ({
        server_id: `server-${index}`,
        state: "unavailable",
        root_path: "/repo",
        error: big(2000),
      })),
      warnings: [big(5000)],
    },
  },
  {
    name: "server",
    schema: LspServerOutputSchema,
    fields: { server_id: "ts", root_path: "/repo", capabilities: { text: big(100_000) } },
  },
  {
    name: "preview",
    schema: LspPreviewOutputSchema,
    fields: {
      preview_id: "preview-1",
      server_id: "ts",
      root_path: "/repo",
      summary: big(50_000),
      warnings: [],
      mutation_manifest: manifest,
      server_preview_ids: ["preview-1"],
    },
  },
  {
    name: "code actions",
    schema: LspCodeActionsOutputSchema,
    fields: {
      server_id: "ts",
      actions: Array.from({ length: 300 }, (_, index) => ({
        title: big(1000),
        kind: "quickfix",
        applicable: true,
        preview_id: `preview-${index}`,
        summary: big(1000),
        mutation_manifest: manifest.slice(0, 3),
        command: { command: big(1000) },
      })),
    },
  },
  {
    name: "apply",
    schema: LspApplyOutputSchema,
    fields: {
      preview_id: "preview-1",
      state: "partial_failure",
      changed_paths: paths,
      mutation_manifest: manifest,
      changed_files: paths,
      created_files: paths,
      deleted_files: paths,
      moved_files: paths.map((from) => ({ from, to: `${from}.moved` })),
      message: big(50_000),
    },
  },
] as const;

describe("createLspToolOutput bounding", () => {
  test.each(BOUNDED_OUTPUT_CASES)(
    "keeps a bounded $name result valid for its output schema",
    async ({ schema, fields }) => {
      const { sessionFiles, spills } = memorySessionFiles();
      const result = await createLspToolOutput(
        "short text",
        { kind: "operation", operation: "hover", server_outcomes: [] },
        fields,
        sessionFiles,
        2000,
      );
      expect(Value.Check(schema, result.structuredContent)).toBe(true);
      expect(result.structuredContent).toMatchObject({
        truncated: true,
        structured_truncated: true,
        spill_path: "/tmp/spill/0.txt",
      });
      // Identifying and enum fields survive uncut.
      for (const key of ["preview_id", "server_id", "state", "root_path"]) {
        const original: unknown = Object.entries(fields).find(([name]) => name === key)?.[1];
        if (original !== undefined) expect(result.structuredContent).toHaveProperty(key, original);
      }
      // The spill holds the complete structured data, including what the bounded result lost.
      expect(spills).toHaveLength(1);
      expect(JSON.parse(spills[0] ?? "")).toEqual(fields);
    },
  );

  test("reports a text-only cut without structured_truncated", async () => {
    const { sessionFiles, spills } = memorySessionFiles();
    const text = Array.from({ length: 5000 }, (_, index) => `line ${index}`).join("\n");
    const result = await createLspToolOutput(
      text,
      { kind: "operation", operation: "hover", server_outcomes: [] },
      { results: [], warnings: [] },
      sessionFiles,
    );
    expect(result.structuredContent).toEqual({
      results: [],
      warnings: [],
      truncated: true,
      structured_truncated: false,
      spill_path: "/tmp/spill/0.txt",
    });
    expect(spills).toEqual([text]);
  });

  test("reports complete text and structured data with both flags false", async () => {
    const { sessionFiles, spills } = memorySessionFiles();
    const result = await createLspToolOutput(
      "ok",
      { kind: "operation", operation: "hover", server_outcomes: [] },
      { results: [], warnings: [] },
      sessionFiles,
    );
    expect(result.structuredContent).toEqual({
      results: [],
      warnings: [],
      truncated: false,
      structured_truncated: false,
    });
    expect(spills).toEqual([]);
  });
});
