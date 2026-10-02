import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { LspSessionFiles } from "./lsp-session-files.js";
import { LspToolResultDetailsSchema, type LspToolResultDetails } from "./lsp-tool-contract.js";

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Recursive protocol output remains opaque until JSON.stringify; only container structure is inspected here.
function deterministicLspValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deterministicLspValue);
  if (value instanceof Map) {
    const entries: [unknown, unknown][] = [...value.entries()];
    return entries
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, entryValue]) => [key, deterministicLspValue(entryValue)]);
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Protocol output is recursively normalized at this rendering boundary.
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, deterministicLspValue(entryValue)]),
  );
}

/** Render a protocol result as stable compact JSON while retaining readable URI strings. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Protocol results are serialized without promising a method-specific payload contract.
export function formatLspToolValue(value: unknown): string {
  const text = JSON.stringify(deterministicLspValue(value));
  return text === undefined ? "null" : text;
}

/**
 * Truncate model-visible text against Pi limits, spilling the complete text when truncated.
 * `spillText` replaces the spilled content when the caller holds a more complete rendering.
 */
export async function truncateLspOutputText(
  text: string,
  sessionFiles: LspSessionFiles,
  subject: string,
  spillText: string = text,
): Promise<{ readonly text: string; readonly spillPath?: string }> {
  const truncation = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) return { text };
  const spillPath = await sessionFiles.writeResultSpill(spillText);
  return {
    text: `${truncation.content}\n\n[Pi LSP: ${subject} truncated; complete Result Spill: ${spillPath}]`,
    spillPath,
  };
}

/** JSON-safe structured result Pi hands to programmatic callers such as codemode scripts. */
export type LspStructuredContent = NonNullable<AgentToolResult<undefined>["structuredContent"]>;

/** Structured fields of one result before the output envelope is added. */
export type LspStructuredFields = Readonly<Record<string, LspStructuredContent>>;

/** Parse one object serialized by `formatLspToolValue` back into JSON-safe structured fields. */
export function lspStructuredFields(text: string): LspStructuredFields {
  const fields: LspStructuredFields = JSON.parse(text);
  return fields;
}

/** Parse one value serialized by `formatLspToolValue` back into its JSON-safe structured form. */
export function lspStructuredValue(text: string): LspStructuredContent {
  const value: LspStructuredContent = JSON.parse(text);
  return value;
}

/** Largest `structuredContent` a result carries, matching Pi's built-in `bash` tool (1 MiB). */
export const LSP_STRUCTURED_CONTENT_MAX_BYTES = 1024 * 1024;

/** Fields reserved for the envelope and the bounding warning when sizing the bounded fields. */
const STRUCTURED_ENVELOPE_RESERVE_BYTES = 4096;

/** Top-level fields that identify a result and are never cut. */
const UNBOUNDED_STRUCTURED_FIELDS: ReadonlySet<string> = new Set([
  "truncated",
  "spill_path",
  "server_preview_ids",
]);

/**
 * Keys whose short string values identify a result or name a path, and so are never shortened:
 * they carry enum values and ids that the output schemas and callers rely on. Array items inherit
 * the key of their array (`changed_paths`, `changed_files`, ...).
 */
const IDENTIFYING_STRING_KEYS: ReadonlySet<string> = new Set([
  "state",
  "operation",
  "kind",
  "outcome",
  "server_id",
  "preview_id",
  "root_path",
  "path",
  "destination_path",
  "from",
  "to",
  "changed_paths",
  "changed_files",
  "created_files",
  "deleted_files",
]);

/** Longest identifying string kept whole; anything longer is not an id or enum value. */
const IDENTIFYING_STRING_MAX_LENGTH = 4096;

/** Successively harsher limits; the last one empties every string and array. */
const STRUCTURED_BOUND_LADDER: readonly {
  readonly strings: number;
  readonly items: number;
}[] = [
  { strings: 256 * 1024, items: 10_000 },
  { strings: 64 * 1024, items: 2000 },
  { strings: 16 * 1024, items: 500 },
  { strings: 4096, items: 100 },
  { strings: 1024, items: 20 },
  { strings: 256, items: 5 },
  { strings: 64, items: 1 },
  { strings: 0, items: 0 },
];

function boundStructuredValue(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Structured values are JSON-safe but recursively opaque; only strings, arrays, and objects are inspected.
  value: unknown,
  strings: number,
  items: number,
  key: string = "",
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- The bounded value keeps the JSON-safe structure of its input.
): unknown {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON values are recursively inspected at this boundary.
  if (typeof value === "string") {
    if (value.length <= strings) return value;
    if (IDENTIFYING_STRING_KEYS.has(key) && value.length <= IDENTIFYING_STRING_MAX_LENGTH) {
      return value;
    }
    // Never split a surrogate pair.
    const last = value.charCodeAt(strings - 1);
    const end = strings > 0 && last >= 0xd800 && last <= 0xdbff ? strings - 1 : strings;
    const kept = value.slice(0, end);
    return strings === 0 ? "" : `${kept}…[${value.length - end} characters truncated]`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, items).map((item) => boundStructuredValue(item, strings, items, key));
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON values are recursively inspected at this boundary.
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entry]) => [
      entryKey,
      boundStructuredValue(entry, strings, items, entryKey),
    ]),
  );
}

function structuredByteLength(value: LspStructuredFields): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/** Structured fields after the 1 MiB cap was applied, and whether anything was cut. */
export interface LspBoundedStructuredFields {
  readonly fields: LspStructuredFields;
  readonly bounded: boolean;
}

/**
 * Bound structured fields to `LSP_STRUCTURED_CONTENT_MAX_BYTES`, like Pi's built-in `bash` tool.
 * Results within the cap are returned untouched. A larger result is cut deterministically: the
 * longest strings are shortened and the longest arrays lose their tail, with limits that tighten
 * step by step until the result fits. Identifying and enum fields (state, operation, kinds, ids,
 * paths, `server_preview_ids`) are never shortened, and the result keeps every field, so a bounded
 * result still matches its output schema.
 */
export function boundLspStructuredFields(
  fields: LspStructuredFields,
  maxBytes: number = LSP_STRUCTURED_CONTENT_MAX_BYTES,
): LspBoundedStructuredFields {
  const kept = Object.entries(fields).filter(([key]) => UNBOUNDED_STRUCTURED_FIELDS.has(key));
  const cuttable = Object.entries(fields).filter(([key]) => !UNBOUNDED_STRUCTURED_FIELDS.has(key));
  const reserved =
    structuredByteLength(Object.fromEntries(kept)) + STRUCTURED_ENVELOPE_RESERVE_BYTES;
  const budget = maxBytes - reserved;
  if (structuredByteLength(Object.fromEntries(cuttable)) <= budget)
    return { fields, bounded: false };
  for (const { strings, items } of STRUCTURED_BOUND_LADDER) {
    const candidate: LspStructuredFields = Object.fromEntries(
      cuttable.map(([key, value]) => [
        key,
        lspStructuredValue(JSON.stringify(boundStructuredValue(value, strings, items, key))),
      ]),
    );
    if (structuredByteLength(candidate) <= budget) {
      return {
        fields: { ...candidate, ...Object.fromEntries(kept) },
        bounded: true,
      };
    }
  }
  // Only reachable when identifying fields alone exceed the cap; keep every field, emptied.
  return {
    fields: {
      ...Object.fromEntries(
        cuttable.map(([key, value]) => [
          key,
          lspStructuredValue(JSON.stringify(boundStructuredValue(value, 0, 0, key))),
        ]),
      ),
      ...Object.fromEntries(kept),
    },
    bounded: true,
  };
}

/**
 * Validate normalized details, truncate model-visible text, and spill every complete oversized
 * result. Structured content is capped at 1 MiB; a larger one is bounded, and every bounded or
 * truncated result reports `truncated` and the Result Spill path. A bounded result spills the
 * complete structured data, so the spill holds everything the bounded result lost (manifests,
 * changed paths, and protocol payloads); a text-only truncation spills the complete text.
 * `structured_truncated` reports that the structured data itself is incomplete.
 */
export async function createLspToolOutput(
  text: string,
  details: LspToolResultDetails,
  structured: LspStructuredFields,
  sessionFiles: LspSessionFiles,
  maxStructuredBytes: number = LSP_STRUCTURED_CONTENT_MAX_BYTES,
): Promise<AgentToolResult<LspToolResultDetails>> {
  const normalizedDetails = Value.Parse(LspToolResultDetailsSchema, details);
  const bounded = boundLspStructuredFields(structured, maxStructuredBytes);
  const completeStructured = bounded.bounded ? formatLspToolValue(structured) : text;
  const truncated = await truncateLspOutputText(text, sessionFiles, "output", completeStructured);
  if (truncated.spillPath === undefined && !bounded.bounded) {
    return {
      content: [{ type: "text", text }],
      details: normalizedDetails,
      structuredContent: { ...structured, truncated: false, structured_truncated: false },
    };
  }

  const spillPath =
    truncated.spillPath ?? (await sessionFiles.writeResultSpill(completeStructured));
  const detailsWithSpill =
    normalizedDetails.kind === "operation"
      ? Value.Parse(LspToolResultDetailsSchema, {
          ...normalizedDetails,
          spill_path: spillPath,
        })
      : normalizedDetails;
  const warnings = bounded.fields["warnings"];
  const boundedFields =
    bounded.bounded && Array.isArray(warnings)
      ? {
          ...bounded.fields,
          warnings: [
            ...warnings,
            `Structured result exceeded ${maxStructuredBytes} bytes and was bounded; the complete structured data is in ${spillPath}.`,
          ],
        }
      : bounded.fields;
  return {
    content: [{ type: "text", text: truncated.text }],
    details: detailsWithSpill,
    structuredContent: {
      ...boundedFields,
      truncated: true,
      structured_truncated: bounded.bounded,
      spill_path: spillPath,
    },
  };
}
