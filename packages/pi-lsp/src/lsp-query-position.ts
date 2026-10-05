import { documentLines, type LspCodePointPosition } from "./lsp-position-encoding.js";
import { lspDisplayPath, shortenLspText } from "./lsp-location-text.js";
import type { LspOperationName } from "./lsp-tool-contract.js";

/** Read operations that query one position of a document. */
export const LSP_POSITION_READ_OPERATIONS = [
  "completion",
  "hover",
  "signature_help",
  "declaration",
  "goto_definition",
  "goto_type_definition",
  "goto_implementation",
  "find_references",
  "document_highlights",
  "call_hierarchy",
  "incoming_calls",
  "outgoing_calls",
  "type_hierarchy",
  "supertypes",
  "subtypes",
  "prepare_rename",
] as const satisfies readonly LspOperationName[];

/** A read operation that queries one position of a document. */
export type LspPositionReadOperation = (typeof LSP_POSITION_READ_OPERATIONS)[number];

const POSITION_READ_OPERATION_SET: ReadonlySet<LspOperationName> = new Set(
  LSP_POSITION_READ_OPERATIONS,
);

/** Report whether an operation queries one position of a document. */
export function isLspPositionReadOperation(
  operation: LspOperationName,
): operation is LspPositionReadOperation {
  return POSITION_READ_OPERATION_SET.has(operation);
}

const WORD_CHARACTER = /^[\p{L}\p{M}\p{N}_$]$/u;
const WHITESPACE_CHARACTER = /^\s$/u;

/**
 * What a position-based query's requested position held in the text sent to the server, so an
 * off-by-one position is visible in its result.
 */
export interface LspQueryPosition {
  /** Absolute path of the queried document. */
  readonly path: string;
  /** One-based requested line. */
  readonly line: number;
  /** One-based requested Unicode code-point character. */
  readonly character: number;
  /** The identifier or punctuation run at the position; absent on whitespace or past the line end. */
  readonly token?: string;
  /** The trimmed line holding the position; empty for a blank line. */
  readonly line_text: string;
}

type CharacterClass = "word" | "whitespace" | "punctuation";

function characterClass(character: string): CharacterClass {
  if (WORD_CHARACTER.test(character)) return "word";
  if (WHITESPACE_CHARACTER.test(character)) return "whitespace";
  return "punctuation";
}

/**
 * Resolve the token at a one-based code-point position: the maximal run of identifier characters,
 * or of punctuation, that contains it. Whitespace, a position past the line end, and a missing
 * line have no token.
 */
export function lspQueryPosition(
  path: string,
  text: string,
  position: LspCodePointPosition,
): LspQueryPosition {
  const characters = Array.from(documentLines(text)[position.line - 1] ?? "");
  const query = {
    path,
    line: position.line,
    character: position.character,
    line_text: characters.join("").trim(),
  };
  const index = position.character - 1;
  const at = characters[index];
  if (at === undefined) return query;
  const kind = characterClass(at);
  if (kind === "whitespace") return query;
  let start = index;
  while (start > 0 && characterClass(characters[start - 1] ?? " ") === kind) start--;
  let end = index + 1;
  while (end < characters.length && characterClass(characters[end] ?? " ") === kind) end++;
  return { ...query, token: characters.slice(start, end).join("") };
}

/**
 * Describe a queried position as `path:line:col ("token")`, with the trimmed line instead when the
 * position holds no token. A very long token or line is shortened.
 */
export function describeLspQueryPosition(cwd: string, query: LspQueryPosition): string {
  const position = `${lspDisplayPath(cwd, query.path)}:${query.line}:${query.character}`;
  if (query.token !== undefined) {
    return `${position} (${JSON.stringify(shortenLspText(query.token))})`;
  }
  if (query.line_text === "") return `${position} (no token; empty line)`;
  return `${position} (no token; line: ${JSON.stringify(shortenLspText(query.line_text))})`;
}

function emptyResultSubject(operation: LspPositionReadOperation, noHierarchyItem: boolean): string {
  switch (operation) {
    case "completion":
      return "No completions";
    case "hover":
      return "No hover information";
    case "signature_help":
      return "No signature help";
    case "declaration":
    case "goto_definition":
    case "goto_type_definition":
    case "goto_implementation":
      return "No locations found";
    case "find_references":
      return "No references found";
    case "document_highlights":
      return "No highlights found";
    case "call_hierarchy":
      return "No call hierarchy item";
    case "incoming_calls":
      return noHierarchyItem ? "No call hierarchy item" : "No incoming calls found";
    case "outgoing_calls":
      return noHierarchyItem ? "No call hierarchy item" : "No outgoing calls found";
    case "type_hierarchy":
      return "No type hierarchy item";
    case "supertypes":
      return noHierarchyItem ? "No type hierarchy item" : "No supertypes found";
    case "subtypes":
      return noHierarchyItem ? "No type hierarchy item" : "No subtypes found";
    case "prepare_rename":
      return "No renameable symbol";
  }
}

/**
 * State that a position-based query found nothing at the described position. For hierarchy
 * follow-ups, `noHierarchyItem` distinguishes a position that prepared no item from an item with
 * no calls or related types.
 */
export function lspEmptyPositionReadMessage(
  operation: LspPositionReadOperation,
  position: string,
  noHierarchyItem: boolean,
): string {
  return `${emptyResultSubject(operation, noHierarchyItem)} at ${position}.`;
}
