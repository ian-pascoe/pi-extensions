import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { countSymbols, topLevelSymbolRanges } from "./lsp-document-symbol-depth.js";

/** The `FoldingRangeKind` that servers give a block of import declarations. */
const IMPORTS_FOLDING_RANGE_KIND = "imports";

const ImportsFoldingRangeSchema = Type.Object({
  startLine: Type.Integer({ minimum: 0 }),
  endLine: Type.Integer({ minimum: 0 }),
  kind: Type.Literal(IMPORTS_FOLDING_RANGE_KIND),
});

/** An `imports` folding range, which covers its lines from `startLine` to `endLine`, both included. */
export type ImportsFoldingRange = Static<typeof ImportsFoldingRangeSchema>;

/** A `textDocument/documentSymbol` response without its import bindings, and how many it dropped. */
export interface LspImportFilteredSymbols {
  // oxlint-disable-next-line anti-slop/no-unknown-property-types -- The response keeps its protocol shape; only top-level import bindings are cut.
  readonly value: unknown;
  readonly omitted: number;
}

/** The `imports` ranges of a `textDocument/foldingRange` response; anything else in it is ignored. */
export function importFoldingRanges(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A folding range response is opaque until each item matches the imports schema.
  response: unknown,
): ImportsFoldingRange[] {
  if (!Array.isArray(response)) return [];
  return response.filter((item) => Value.Check(ImportsFoldingRangeSchema, item));
}

/**
 * Drop the top-level symbols of a `textDocument/documentSymbol` response that lie entirely inside
 * a folding range of kind `imports`: servers report each import binding as a top-level variable.
 * Folding ranges and symbols meet by line, because a folding range's columns are optional. A
 * symbol without a readable range stays. The count of dropped symbols, with their children, is
 * returned.
 */
export function dropImportSymbols(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A document symbol response may be a tree, a flat list, or null; its items stay opaque.
  value: unknown,
  imports: readonly ImportsFoldingRange[],
): LspImportFilteredSymbols {
  if (imports.length === 0 || !Array.isArray(value)) return { value, omitted: 0 };
  const ranges = topLevelSymbolRanges(value);
  let omitted = 0;
  const kept = value.filter((item, index) => {
    const range = ranges[index];
    const isImport =
      range !== undefined &&
      imports.some(
        ({ startLine, endLine }) => startLine <= range.start.line && range.end.line <= endLine,
      );
    if (isImport) omitted += countSymbols([item]);
    return !isImport;
  });
  return { value: kept, omitted };
}
