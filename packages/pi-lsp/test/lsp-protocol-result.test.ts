import { describe, expect, test } from "vitest";
import {
  lspApproximatePositionsWarning,
  normalizeLspProtocolResult,
} from "../src/lsp-protocol-result.js";

const span = (line: number, start: number, end: number) => ({
  start: { line, character: start },
  end: { line, character: end },
});

const item = (uri: string, line: number, character: number) => ({
  name: "caller",
  kind: 12,
  uri,
  range: span(line, 0, character),
  selectionRange: span(line, character, character),
});

describe("normalizeLspProtocolResult", () => {
  test("reads each file once per result and never reads the requested document", async () => {
    const reads: string[] = [];
    const texts = new Map([["file:///caller.ts", "const 😀 = a(); b(); c();\n"]]);
    const document = { uri: "file:///source.ts", text: "😀source\n" };
    const calls = [1, 2, 3].map((index) => ({
      from: item("file:///caller.ts", 0, 0),
      fromRanges: [span(0, 9 + index * 5, 10 + index * 5)],
    }));

    const result = await normalizeLspProtocolResult(
      [...calls, { from: item(document.uri, 0, 2), fromRanges: [span(0, 2, 8)] }],
      {
        encoding: "utf-16",
        document,
        readText: async (uri) => {
          reads.push(uri);
          return texts.get(uri);
        },
      },
    );

    expect(reads).toEqual(["file:///caller.ts"]);
    expect(result).toMatchObject({
      value: [
        { from: { uri: "/caller.ts" }, fromRanges: [{ start: { line: 1, character: 14 } }] },
        { fromRanges: [{ start: { line: 1, character: 19 } }] },
        { fromRanges: [{ start: { line: 1, character: 24 } }] },
        { from: { selectionRange: span(1, 2, 2) }, fromRanges: [span(1, 2, 8)] },
      ],
      approximateFiles: [],
    });
  });

  test("approximates positions of unreadable files without the requested document's text", async () => {
    const result = await normalizeLspProtocolResult(
      [{ uri: "jdt://contents/A.class", range: span(0, 3, 4) }],
      {
        encoding: "utf-16",
        document: { uri: "file:///source.ts", text: "😀\n" },
        readText: async () => undefined,
      },
    );

    expect(result).toEqual({
      value: [{ uri: "jdt://contents/A.class", range: span(1, 4, 5) }],
      approximateFiles: ["jdt://contents/A.class"],
    });
  });

  test("leaves positions with no file in scope unchanged", async () => {
    const value = [{ name: "Helper", kind: 5, data: { pos: { line: 0, character: 3 } } }];

    const result = await normalizeLspProtocolResult(value, {
      encoding: "utf-16",
      readText: async () => undefined,
    });

    expect(result).toEqual({ value, approximateFiles: [] });
  });

  test("adds 1 without a warning when the negotiated encoding counts code points", async () => {
    const result = await normalizeLspProtocolResult(
      [{ uri: "jdt://contents/A.class", range: span(0, 3, 4) }],
      { encoding: "utf-32", readText: async () => undefined },
    );

    expect(result).toEqual({
      value: [{ uri: "jdt://contents/A.class", range: span(1, 4, 5) }],
      approximateFiles: [],
    });
  });
});

describe("lspApproximatePositionsWarning", () => {
  test("shows paths relative to the working directory and reports nothing when exact", () => {
    expect(lspApproximatePositionsWarning("jdtls", [], "/repo")).toBeUndefined();
    expect(
      lspApproximatePositionsWarning(
        "jdtls",
        ["/repo/src/a.ts", "jdt://contents/A.class"],
        "/repo",
      ),
    ).toBe(
      "jdtls: positions in src/a.ts, jdt://contents/A.class are approximate because their text could not be read; lines are exact, but columns may be off after non-ASCII text.",
    );
  });
});
