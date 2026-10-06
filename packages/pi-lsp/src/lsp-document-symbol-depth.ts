import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { compareLspProtocolPositions } from "./lsp-position-encoding.js";
import {
  LSP_MEMBER_CONTAINER_SYMBOL_KINDS,
  type LspDocumentSymbolDepth,
} from "./lsp-tool-contract.js";

const MEMBER_CONTAINER_KINDS: ReadonlySet<number> = new Set(
  Object.values(LSP_MEMBER_CONTAINER_SYMBOL_KINDS),
);

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

/** A `textDocument/documentSymbol` response cut to a depth, and how many nested symbols the cut dropped. */
export interface LspDepthLimitedSymbols {
  // oxlint-disable-next-line anti-slop/no-unknown-property-types -- The response keeps its protocol shape; only its nesting is cut.
  readonly value: unknown;
  readonly omitted: number;
}

/** The budget left for a symbol's children: member containers keep it, other symbols spend one level. */
function childBudget(kind: number, budget: number): number {
  return MEMBER_CONTAINER_KINDS.has(kind) ? budget : budget - 1;
}

/** Count a symbol list and everything nested in it. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Children are opaque until each matches the symbol schema.
function countSymbols(symbols: readonly unknown[]): number {
  return symbols.reduce<number>((count, symbol) => {
    const children = Value.Check(HierarchicalSymbolSchema, symbol) ? symbol.children : undefined;
    return count + 1 + (Array.isArray(children) ? countSymbols(children) : 0);
  }, 0);
}

/** Cut a symbol tree, returning the symbol and adding the count of dropped descendants to `dropped`. */
function pruneHierarchical(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A response item is opaque until it matches a symbol schema.
  symbol: unknown,
  budget: number,
  dropped: { count: number },
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- An item that does not match is returned as the server sent it.
): unknown {
  if (!Value.Check(HierarchicalSymbolSchema, symbol)) return symbol;
  const { children } = symbol;
  if (!Array.isArray(children)) return symbol;
  const remaining = childBudget(symbol.kind, budget);
  if (remaining < 1) dropped.count += countSymbols(children);
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- The item keeps the server's opaque shape.
  return {
    ...symbol,
    children:
      remaining < 1 ? [] : children.map((child) => pruneHierarchical(child, remaining, dropped)),
  };
}

function contains(outer: Range, inner: Range): boolean {
  return (
    compareLspProtocolPositions(outer.start, inner.start) <= 0 &&
    compareLspProtocolPositions(inner.end, outer.end) <= 0
  );
}

function sameRange(left: Range, right: Range): boolean {
  return (
    compareLspProtocolPositions(left.start, right.start) === 0 &&
    compareLspProtocolPositions(left.end, right.end) === 0
  );
}

interface FlatEntry {
  readonly name: string;
  readonly kind: number;
  readonly containerName: string;
  readonly range: Range | undefined;
}

/** The names a `containerName` may stand for: itself and each of its dotted suffixes (`a.b.C` → `C`, `b.C`, `a.b.C`). */
function containerNameSuffixes(containerName: string): string[] {
  const parts = containerName.split(".");
  return parts.map((_, start) => parts.slice(start).join("."));
}

/**
 * Index of the symbol a flat entry's `containerName` names, or undefined for a top-level entry.
 * Candidates with ranges must strictly enclose the entry, and the innermost wins. When either side
 * has no range, the nearest earlier candidate wins.
 */
function containerIndex(
  entries: readonly FlatEntry[],
  byName: ReadonlyMap<string, readonly number[]>,
  index: number,
): number | undefined {
  const entry = entries[index];
  if (entry === undefined || entry.containerName === "") return undefined;
  const candidates = containerNameSuffixes(entry.containerName)
    .flatMap((name) => byName.get(name) ?? [])
    .toSorted((left, right) => left - right);
  let best: number | undefined;
  for (const candidateIndex of candidates) {
    const candidate = entries[candidateIndex];
    if (candidate === undefined || candidateIndex === index) continue;
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

/** Read a response item as a flat `SymbolInformation`, or undefined when it is not one. */
function flatEntry(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A response item is opaque until it matches the flat symbol schema.
  item: unknown,
): FlatEntry | undefined {
  if (!Value.Check(FlatSymbolSchema, item)) return undefined;
  const range = Value.Check(RangeSchema, item.location.range) ? item.location.range : undefined;
  return { name: item.name, kind: item.kind, containerName: item.containerName ?? "", range };
}

/**
 * Keep the flat symbols whose chain of `containerName` containers stays within the depth. A
 * container is the nearest enclosing symbol of that name; a name that matches none is top-level.
 */
function pruneFlat(
  value: readonly unknown[],
  entries: readonly FlatEntry[],
  depth: number,
): LspDepthLimitedSymbols {
  const byName = new Map<string, number[]>();
  for (const [index, { name }] of entries.entries())
    byName.set(name, [...(byName.get(name) ?? []), index]);
  const parents = entries.map((_, index) => containerIndex(entries, byName, index));
  /** The budget available to the children of each entry. */
  const available = new Map<number, number>();
  const resolving = new Set<number>();
  const resolve = (index: number): number => {
    const known = available.get(index);
    if (known !== undefined) return known;
    // A malformed response can name containers that enclose each other; a revisited entry is top-level.
    if (resolving.has(index)) return depth;
    resolving.add(index);
    const parent = parents[index];
    const inherited = parent === undefined ? depth : resolve(parent);
    const budget = childBudget(entries[index]?.kind ?? 0, inherited);
    resolving.delete(index);
    available.set(index, budget);
    return budget;
  };
  // Budgets only shrink down a chain, so an entry is kept when its container still has some left.
  const kept = value.filter((_, index) => {
    const parent = parents[index];
    return parent === undefined || resolve(parent) >= 1;
  });
  return { value: kept, omitted: value.length - kept.length };
}

/**
 * Cut a `textDocument/documentSymbol` response to the depth the call asked for, before positions
 * are normalized. Depth 1 keeps top-level declarations and the members of classes, interfaces,
 * enums, namespaces, modules, packages, objects, and structs; each further level keeps one more
 * level inside function, method, and variable bodies. `"all"` keeps the whole tree. Hierarchical
 * responses lose the children they drop (an empty `children` array stays); flat
 * `SymbolInformation[]` responses lose the entries whose `containerName` chain exceeds the depth.
 * The count of symbols dropped is returned with the cut response.
 */
export function limitLspDocumentSymbolDepth(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A document symbol response may be a tree, a flat list, or null; its items stay opaque.
  value: unknown,
  depth: LspDocumentSymbolDepth,
): LspDepthLimitedSymbols {
  if (depth === "all" || !Array.isArray(value)) return { value, omitted: 0 };
  const entries = value.map(flatEntry);
  if (entries.length > 0 && entries.every((entry) => entry !== undefined)) {
    return pruneFlat(value, entries, depth);
  }
  const dropped = { count: 0 };
  return {
    value: value.map((item) => pruneHierarchical(item, depth, dropped)),
    omitted: dropped.count,
  };
}
