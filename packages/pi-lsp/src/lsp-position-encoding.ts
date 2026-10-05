import { LspInputError } from "./lsp-input-error.js";

/** A negotiated LSP character-unit encoding supported by the protocol. */
export type LspPositionEncoding = "utf-8" | "utf-16" | "utf-32";

/** A one-based source position whose character counts Unicode code points. */
export interface LspCodePointPosition {
  /** One-based document line. */
  readonly line: number;
  /** One-based Unicode-code-point character within the line. */
  readonly character: number;
}

/** A zero-based LSP protocol position whose character uses the negotiated encoding. */
export interface LspProtocolPosition {
  /** Zero-based document line. */
  readonly line: number;
  /** Zero-based encoded character offset within the line. */
  readonly character: number;
}

/** Normalize a server's negotiated position encoding, defaulting protocol omissions to UTF-16. */
export function normalizeLspPositionEncoding(encoding: string | undefined): LspPositionEncoding {
  if (encoding === "utf-8") return "utf-8";
  if (encoding === "utf-32") return "utf-32";
  return "utf-16";
}

/** Split document text into lines on CRLF, LF, or CR separators. */
export function documentLines(documentText: string): readonly string[] {
  return documentText.split(/\r\n|[\n\r]/u);
}

function requireNonNegativeInteger(value: number, description: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Pi LSP: ${description} must be a non-negative integer`);
  }
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function requireCodePointLine(
  lines: readonly string[],
  position: LspCodePointPosition,
): readonly string[] {
  if (!Number.isSafeInteger(position.line) || position.line < 1) {
    throw new LspInputError("code-point position line must be a positive integer");
  }
  if (!Number.isSafeInteger(position.character) || position.character < 1) {
    throw new LspInputError("code-point position character must be a positive integer");
  }
  const line = lines[position.line - 1];
  if (line === undefined) {
    throw new LspInputError(
      `line ${position.line} is past the end of the document, which has ${countOf(lines.length, "line")} (line must be at most ${lines.length})`,
    );
  }
  return Array.from(line);
}

function requireProtocolLine(lines: readonly string[], position: LspProtocolPosition): string {
  requireNonNegativeInteger(position.line, "protocol position line");
  requireNonNegativeInteger(position.character, "protocol position character");
  const line = lines[position.line];
  if (line === undefined) {
    throw new Error("Pi LSP: protocol position line exceeds document length");
  }
  return line;
}

function encodedCharacterLength(character: string, encoding: LspPositionEncoding): number {
  switch (encoding) {
    case "utf-8":
      return Buffer.byteLength(character, "utf8");
    case "utf-16":
      return character.length;
    case "utf-32":
      return 1;
  }
}

/** Return the negotiated LSP character length of one line of document text. */
export function measureLspPositionCharacters(text: string, encoding: LspPositionEncoding): number {
  if (encoding === "utf-8") return Buffer.byteLength(text, "utf8");
  if (encoding === "utf-32") return Array.from(text).length;
  return text.length;
}

function protocolCharacterOffset(
  characters: readonly string[],
  codePointOffset: number,
  encoding: LspPositionEncoding,
): number {
  let encodedOffset = 0;
  for (const character of characters.slice(0, codePointOffset)) {
    encodedOffset += encodedCharacterLength(character, encoding);
  }
  return encodedOffset;
}

/** Convert a one-based Unicode code-point position to a zero-based negotiated LSP position. */
export function convertLspCodePointPosition(
  documentText: string,
  position: LspCodePointPosition,
  encoding: LspPositionEncoding,
): LspProtocolPosition {
  const characters = requireCodePointLine(documentLines(documentText), position);
  const codePointOffset = position.character - 1;
  if (codePointOffset > characters.length) {
    throw new LspInputError(
      `character ${position.character} is past the end of line ${position.line}, which has ${countOf(characters.length, "character")} (character must be at most ${characters.length + 1})`,
    );
  }
  return {
    line: position.line - 1,
    character: protocolCharacterOffset(characters, codePointOffset, encoding),
  };
}

/** Convert a zero-based negotiated LSP position to one-based Unicode code-point coordinates. */
export function convertLspProtocolPosition(
  documentText: string,
  position: LspProtocolPosition,
  encoding: LspPositionEncoding,
): LspCodePointPosition {
  return convertLspProtocolLinePosition(documentLines(documentText), position, encoding);
}

/**
 * Convert a zero-based negotiated LSP position to one-based Unicode code-point coordinates against
 * a document already split by `documentLines`.
 */
export function convertLspProtocolLinePosition(
  lines: readonly string[],
  position: LspProtocolPosition,
  encoding: LspPositionEncoding,
): LspCodePointPosition {
  const line = requireProtocolLine(lines, position);
  const characters = Array.from(line);
  let encodedOffset = 0;
  for (let codePointOffset = 0; codePointOffset <= characters.length; codePointOffset++) {
    if (encodedOffset === position.character) {
      return { line: position.line + 1, character: codePointOffset + 1 };
    }
    const character = characters[codePointOffset];
    if (character === undefined) break;
    encodedOffset += encodedCharacterLength(character, encoding);
    if (encodedOffset > position.character) {
      throw new Error("Pi LSP: protocol position splits a Unicode character");
    }
  }
  throw new Error("Pi LSP: protocol position character exceeds line length");
}
