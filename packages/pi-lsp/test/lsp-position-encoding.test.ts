import { expect, test } from "vitest";
import {
  convertLspCodePointPosition,
  convertLspProtocolPosition,
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
    "Pi LSP: code-point position character exceeds line length",
  );
  expect(() => convertLspProtocolPosition(text, { line: 0, character: 2 }, "utf-16")).toThrow(
    "Pi LSP: protocol position splits a Unicode character",
  );
  expect(() => convertLspProtocolPosition(text, { line: 0, character: 2 }, "utf-8")).toThrow(
    "Pi LSP: protocol position splits a Unicode character",
  );
});
