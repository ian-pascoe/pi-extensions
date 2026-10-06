import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/** How many levels of nested symbols `lsp_document_symbols` keeps: a count, or `"all"` for the full tree. */
export type LspDocumentSymbolDepth = number | "all";

/** Depth of a `lsp_document_symbols` call that names none. */
export const DEFAULT_LSP_DOCUMENT_SYMBOL_DEPTH = 1;

/**
 * `SymbolKind` numbers whose children are members of a declaration (module, namespace, package,
 * class, enum, interface, struct) and so stay at every depth. The children of anything else (a
 * function, method, variable, property) are body content: locals, return-object properties, and
 * callbacks.
 */
const MEMBER_CONTAINER_KINDS: ReadonlySet<number> = new Set([2, 3, 4, 5, 10, 11, 23]);

const PositionSchema = Type.Object({ line: Type.Number(), character: Type.Number() });
const RangeSchema = Type.Object({ start: PositionSchema, end: PositionSchema });
const HierarchicalSymbolSchema = Type.Object({
  kind: Type.Number(),
  selectionRange: Type.Unknown(),
  children: Type.Optional(Type.Unknown()),
});
const FlatSymbolSchema = Type.Object({
  name: Type.String(),
  kind: Type.Number(),
  containerName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  location: Type.Object({ range: Type.Optional(Type.Unknown()) }),
});

type Range = Static<typeof RangeSchema>;

/** The budget left for a symbol's children: member containers keep it, other symbols spend one level. */
function childBudget(kind: number, budget: number): number {
  return MEMBER_CONTAINER_KINDS.has(kind) ? budget : budget - 1;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- A response item is opaque until it matches a symbol schema; an item that does not match is returned as the server sent it.
function pruneHierarchical(symbol: unknown, budget: number): unknown {
  if (!Value.Check(HierarchicalSymbolSchema, symbol)) return symbol;
  const { children } = symbol;
  if (!Array.isArray(children)) return symbol;
  const remaining = childBudget(symbol.kind, budget);
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- The item keeps the server's opaque shape.
  return {
    ...symbol,
    children: remaining < 1 ? [] : children.map((child) => pruneHierarchical(child, remaining)),
  };
}

function compare(left: { line: number; character: number }, right: typeof left): number {
  return left.line === right.line ? left.character - right.character : left.line - right.line;
}

function contains(outer: Range, inner: Range): boolean {
  return compare(outer.start, inner.start) <= 0 && compare(inner.end, outer.end) <= 0;
}

function sameRange(left: Range, right: Range): boolean {
  return compare(left.start, right.start) === 0 && compare(left.end, right.end) === 0;
}

interface FlatEntry {
  readonly name: string;
  readonly kind: number;
  readonly containerName: string;
  readonly range: Range | undefined;
}

/** Index of the symbol a flat entry's `containerName` names, or undefined for a top-level entry. */
function containerIndex(entries: readonly FlatEntry[], index: number): number | undefined {
  const entry = entries[index];
  if (entry === undefined || entry.containerName === "") return undefined;
  let best: number | undefined;
  for (const [candidateIndex, candidate] of entries.entries()) {
    if (candidateIndex === index) continue;
    if (
      candidate.name !== entry.containerName &&
      !entry.containerName.endsWith(`.${candidate.name}`)
    ) {
      continue;
    }
    if (entry.range !== undefined && candidate.range !== undefined) {
      if (!contains(candidate.range, entry.range) || sameRange(candidate.range, entry.range)) {
        continue;
      }
      // The innermost enclosing candidate is the container.
      const current = best === undefined ? undefined : entries[best]?.range;
      if (current === undefined || contains(current, candidate.range)) best = candidateIndex;
    } else if (candidateIndex < index) {
      best = candidateIndex;
    }
  }
  return best;
}

/**
 * Keep the flat symbols whose chain of `containerName` containers stays within the depth. A
 * container is the nearest enclosing symbol of that name; a name that matches none is top-level.
 */
function pruneFlat(value: readonly unknown[], depth: number): unknown[] {
  const entries = value.map((item): FlatEntry => {
    if (!Value.Check(FlatSymbolSchema, item)) {
      return { name: "", kind: 0, containerName: "", range: undefined };
    }
    const range = Value.Check(RangeSchema, item.location.range) ? item.location.range : undefined;
    const containerName = item.containerName ?? "";
    return { name: item.name, kind: item.kind, containerName, range };
  });
  const parents = entries.map((_, index) => containerIndex(entries, index));
  /** The budget available to the children of each entry. */
  const available = new Map<number, number>();
  // A container is always enclosing or earlier in the list, so its budget is never in progress.
  const resolve = (index: number): number => {
    const known = available.get(index);
    if (known !== undefined) return known;
    const parent = parents[index];
    const inherited = parent === undefined ? depth : resolve(parent);
    const budget = childBudget(entries[index]?.kind ?? 0, inherited);
    available.set(index, budget);
    return budget;
  };
  const kept = (index: number): boolean => {
    const parent = parents[index];
    return parent === undefined || (resolve(parent) >= 1 && kept(parent));
  };
  return value.filter((_, index) => kept(index));
}

/**
 * Cut a `textDocument/documentSymbol` response to the depth the call asked for, before positions
 * are normalized. Depth 1 keeps top-level declarations and the members of classes, interfaces,
 * enums, namespaces, modules, and structs; each further level keeps one more level inside function,
 * method, and variable bodies. `"all"` keeps the whole tree. Hierarchical responses lose the
 * children they drop (an empty `children` array stays); flat `SymbolInformation[]` responses lose
 * the entries whose `containerName` chain exceeds the depth.
 */
export function limitLspDocumentSymbolDepth(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A document symbol response may be a tree, a flat list, or null; its items stay opaque.
  value: unknown,
  depth: LspDocumentSymbolDepth,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- The response keeps its protocol shape; only its nesting is cut.
): unknown {
  if (depth === "all" || !Array.isArray(value)) return value;
  if (value.length > 0 && value.every((item) => Value.Check(FlatSymbolSchema, item))) {
    return pruneFlat(value, depth);
  }
  return value.map((item) => pruneHierarchical(item, depth));
}
