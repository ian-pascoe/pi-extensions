import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/** The `FoldingRangeKind` that servers give a block of import declarations. */
const IMPORTS_FOLDING_RANGE_KIND = "imports";

const ImportsFoldingRangeSchema = Type.Object({
  startLine: Type.Integer({ minimum: 0 }),
  endLine: Type.Integer({ minimum: 0 }),
  kind: Type.Literal(IMPORTS_FOLDING_RANGE_KIND),
});
const LineRangeSchema = Type.Object({
  start: Type.Object({ line: Type.Integer({ minimum: 0 }) }),
  end: Type.Object({ line: Type.Integer({ minimum: 0 }) }),
});
const HierarchicalSymbolSchema = Type.Object({
  range: LineRangeSchema,
  children: Type.Optional(Type.Unknown()),
});
const FlatSymbolSchema = Type.Object({
  containerName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  location: Type.Object({ range: LineRangeSchema }),
});

/** An `imports` folding range, which covers its lines from `startLine` to `endLine`, both included. */
type ImportLines = Static<typeof ImportsFoldingRangeSchema>;

type LineRange = Static<typeof LineRangeSchema>;

/** A `textDocument/documentSymbol` response without the import bindings, and how many it dropped. */
export interface LspImportFilteredSymbols {
  // oxlint-disable-next-line anti-slop/no-unknown-property-types -- The response keeps its protocol shape; only top-level import symbols are cut.
  readonly value: unknown;
  readonly omitted: number;
}

/** The `imports` ranges of a `textDocument/foldingRange` response; anything else in it is ignored. */
export function importFoldingRanges(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A folding range response is opaque until each item matches the imports schema.
  response: unknown,
): ImportLines[] {
  if (!Array.isArray(response)) return [];
  return response.filter((item) => Value.Check(ImportsFoldingRangeSchema, item));
}

/** Folding ranges and symbols meet by line: a folding range has no encoding-dependent columns to compare. */
function insideImports(range: LineRange, imports: readonly ImportLines[]): boolean {
  return imports.some(
    ({ startLine, endLine }) => startLine <= range.start.line && range.end.line <= endLine,
  );
}

/** Count a symbol and everything nested in it. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Children are opaque until each matches the symbol schema.
function countSymbol(symbol: unknown): number {
  const children = Value.Check(HierarchicalSymbolSchema, symbol) ? symbol.children : undefined;
  return (
    1 + (Array.isArray(children) ? children.reduce<number>((n, c) => n + countSymbol(c), 0) : 0)
  );
}

/** The line range of a top-level symbol, hierarchical or flat, or undefined for a nested or unreadable one. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A response item is opaque until it matches a symbol schema.
function topLevelRange(item: unknown): LineRange | undefined {
  if (Value.Check(HierarchicalSymbolSchema, item)) return item.range;
  if (Value.Check(FlatSymbolSchema, item) && (item.containerName ?? "") === "") {
    return item.location.range;
  }
  return undefined;
}

/**
 * Drop the top-level symbols of a `textDocument/documentSymbol` response that lie entirely inside
 * a folding range of kind `imports`: servers report each import binding as a top-level variable.
 * Hierarchical responses and flat `SymbolInformation[]` responses are both read; a symbol without a
 * readable range stays. The count of symbols dropped, with their children, is returned.
 */
export function dropImportSymbols(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A document symbol response may be a tree, a flat list, or null; its items stay opaque.
  value: unknown,
  imports: readonly ImportLines[],
): LspImportFilteredSymbols {
  if (imports.length === 0 || !Array.isArray(value)) return { value, omitted: 0 };
  let omitted = 0;
  const kept = value.filter((item) => {
    const range = topLevelRange(item);
    if (range === undefined || !insideImports(range, imports)) return true;
    omitted += countSymbol(item);
    return false;
  });
  return { value: kept, omitted };
}
