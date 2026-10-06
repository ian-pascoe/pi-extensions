import { Type } from "typebox";
import { Value } from "typebox/value";
import { isLspLocationOperation, LspNormalizedPositionSchema } from "./lsp-location-text.js";
import { protocolRecord, protocolString } from "./lsp-protocol-result.js";
import { isLspStructureOperation, lspKnownSymbolKindName } from "./lsp-structure-text.js";
import type { LspOperationName } from "./lsp-tool-contract.js";

const RangeStartSchema = Type.Object({ start: LspNormalizedPositionSchema });
const SymbolIdentitySchema = Type.Object({ name: Type.String(), kind: Type.Integer() });

/** Protocol fields that hold server-private data, never inspected or rewritten. */
const PRIVATE_FIELD = "data";

/**
 * Report whether a read's Structured Result lists symbols or locations that gain flat position
 * fields: every location, symbol, and hierarchy read, but not selection or folding ranges.
 */
function hasLocatedItems(operation: LspOperationName): boolean {
  if (isLspLocationOperation(operation)) return true;
  return (
    isLspStructureOperation(operation) &&
    operation !== "selection_ranges" &&
    operation !== "folding_ranges"
  );
}

/** The file and one-based start position one protocol record names, if it names both. */
function locate(
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Protocol records are opaque; each inspected field is validated where read.
  record: Readonly<Record<string, unknown>>,
  documentPath: string,
  operation: LspOperationName,
) {
  const location = protocolRecord(record.location);
  // A symbol or hierarchy item points at its name (the selection range); a location, at its range.
  const range = [
    record.targetSelectionRange,
    record.selectionRange,
    record.range,
    location?.range,
  ].find((candidate) => Value.Check(RangeStartSchema, candidate));
  // A document symbol and a document highlight carry no file; they lie in the queried document.
  const path =
    protocolString(record.targetUri) ??
    protocolString(record.uri) ??
    protocolString(location?.uri) ??
    (record.selectionRange !== undefined ||
    (operation === "document_highlights" && record.range !== undefined)
      ? documentPath
      : undefined);
  return { path, start: Value.Check(RangeStartSchema, range) ? range.start : undefined };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- Normalized protocol values are opaque; only records shaped like symbols or locations are extended.
function annotate(value: unknown, documentPath: string, operation: LspOperationName): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => annotate(entry, documentPath, operation));
  }
  const record = protocolRecord(value);
  if (record === undefined) return value;
  const annotated = Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      key === PRIVATE_FIELD ? entry : annotate(entry, documentPath, operation),
    ]),
  );
  const kindName = Value.Check(SymbolIdentitySchema, record)
    ? lspKnownSymbolKindName(record.kind)
    : undefined;
  if (kindName !== undefined) annotated.kind_name = kindName;
  const { path, start } = locate(record, documentPath, operation);
  if (path !== undefined) annotated.path = path;
  if (path !== undefined && start !== undefined) {
    annotated.line = start.line;
    annotated.character = start.character;
  }
  return annotated;
}

/**
 * Extend a read's normalized response for its Structured Result: each location, symbol, and
 * hierarchy item gains the flat one-based `path`, `line`, and `character` a script passes straight
 * to a position tool, and each symbol of a named kind its `kind_name`. The protocol fields stay. A symbol's
 * position is its name's start, a location's its range start, and a link's its target selection
 * start. A symbol whose server named no range gains only its `path`. Model-visible text never
 * shows these fields.
 */
export function lspStructuredResultValue(
  operation: LspOperationName,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Normalized protocol values are opaque.
  value: unknown,
  documentPath: string,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- The extended value keeps the opaque protocol structure of its input.
): unknown {
  return hasLocatedItems(operation) ? annotate(value, documentPath, operation) : value;
}
