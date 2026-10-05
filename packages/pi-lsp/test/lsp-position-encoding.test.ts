import { expect, test } from "vitest";
import { LspInputError } from "../src/lsp-input-error.js";
import {
  convertLspCodePointPosition,
  convertLspProtocolPosition,
  measureLspPositionCharacters,
  normalizeLspPositionEncoding,
} from "../src/lsp-position-encoding.js";

test("converts one-based Unicode code-point positions to each negotiated LSP encoding", () => {
  const text = "a😀é\nβ";

  expect(convertLspCodePointPosition(text, { line: 1, character: 3 }, "utf-8")).toEqual({
    line: 0,
    character: 5,
  });
  expect(convertLspCodePointPosition(text, { line: 1, character: 3 }, "utf-16")).toEqual({
    line: 0,
    character: 3,
  });
  expect(convertLspCodePointPosition(text, { line: 1, character: 3 }, "utf-32")).toEqual({
    line: 0,
    character: 2,
  });
});

test("round-trips a negotiated LSP position without splitting a Unicode character", () => {
  const text = "a😀é\nβ";

  expect(convertLspProtocolPosition(text, { line: 0, character: 3 }, "utf-16")).toEqual({
    line: 1,
    character: 3,
  });
  expect(convertLspProtocolPosition(text, { line: 0, character: 5 }, "utf-8")).toEqual({
    line: 1,
    character: 3,
  });
  expect(convertLspProtocolPosition(text, { line: 0, character: 2 }, "utf-32")).toEqual({
    line: 1,
    character: 3,
  });
});

test("rejects non-integral, out-of-range, and split-character positions", () => {
  const text = "a😀é";

  expect(() => convertLspCodePointPosition(text, { line: 0, character: 1 }, "utf-16")).toThrow(
    "Pi LSP: code-point position line must be a positive integer",
  );
  expect(() => convertLspCodePointPosition(text, { line: 1, character: 5 }, "utf-16")).toThrow(
    "Pi LSP: character 5 is past the end of line 1, which has 3 characters (character must be at most 4)",
  );
  expect(() => convertLspProtocolPosition(text, { line: 0, character: 2 }, "utf-16")).toThrow(
    "Pi LSP: protocol position splits a Unicode character",
  );
  expect(() => convertLspProtocolPosition(text, { line: 0, character: 2 }, "utf-8")).toThrow(
    "Pi LSP: protocol position splits a Unicode character",
  );
});

test("reports out-of-range code-point positions as input errors naming the valid bounds", () => {
  const text = "first\nx\n";

  const pastLastLine = () => convertLspCodePointPosition(text, { line: 4, character: 1 }, "utf-16");
  expect(pastLastLine).toThrow(LspInputError);
  expect(pastLastLine).toThrow(
    "Pi LSP: line 4 is past the end of the document, which has 3 lines (line must be at most 3)",
  );
  expect(() => convertLspCodePointPosition("", { line: 2, character: 1 }, "utf-16")).toThrow(
    "Pi LSP: line 2 is past the end of the document, which has 1 line (line must be at most 1)",
  );
  const pastLineEnd = () => convertLspCodePointPosition(text, { line: 2, character: 3 }, "utf-16");
  expect(pastLineEnd).toThrow(LspInputError);
  expect(pastLineEnd).toThrow(
    "Pi LSP: character 3 is past the end of line 2, which has 1 character (character must be at most 2)",
  );
  expect(() => convertLspCodePointPosition(text, { line: 0, character: 1 }, "utf-16")).toThrow(
    LspInputError,
  );
});

test("normalizes negotiated encodings with the required UTF-16 fallback", () => {
  expect(normalizeLspPositionEncoding("utf-8")).toBe("utf-8");
  expect(normalizeLspPositionEncoding("utf-32")).toBe("utf-32");
  expect(normalizeLspPositionEncoding(undefined)).toBe("utf-16");
});

test("measures text in each negotiated encoding", () => {
  expect(measureLspPositionCharacters("a😀é", "utf-8")).toBe(7);
  expect(measureLspPositionCharacters("a😀é", "utf-16")).toBe(4);
  expect(measureLspPositionCharacters("a😀é", "utf-32")).toBe(3);
});
