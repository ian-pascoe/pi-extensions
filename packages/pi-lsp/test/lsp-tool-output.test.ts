import { describe, expect, test } from "vitest";
import {
  boundLspStructuredFields,
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
