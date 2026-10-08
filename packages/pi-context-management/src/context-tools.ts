import { StringEnum, type JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  renderContextToolCall,
  renderContextToolResult,
  type ContextToolDetails,
} from "./context-tool-rendering.js";
import { describeEntry } from "./entry-preview.js";
import {
  appendNote,
  assertContextJournalReadableForModel,
  contextReference,
  MAX_NOTE_CHARACTERS,
  MAX_NOTES,
  NoteName,
  readNotes,
  resolveContextReference,
  withTroubleshootingHint,
} from "./context-store.js";

const NotesParameters = Type.Object(
  {
    action: StringEnum(["list", "read", "write", "append", "delete", "search"]),
    name: Type.Optional(NoteName),
    content: Type.Optional(Type.String({ maxLength: MAX_NOTE_CHARACTERS })),
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
  },
  { additionalProperties: false },
);

const HistoryParameters = Type.Object(
  {
    action: StringEnum(["windows", "list", "read", "search"]),
    ref: Type.Optional(Type.String({ maxLength: 300 })),
    window: Type.Optional(Type.String({ maxLength: 300 })),
    type: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'list/search: only entries of this recorded type, e.g. "message", "custom", "compaction"',
      }),
    ),
    role: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'list/search: only message entries with this role, e.g. "user", "assistant", "toolResult"',
      }),
    ),
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
  },
  { additionalProperties: false },
);

const NextOffset = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()], {
  description: "Offset of the next page or chunk, or null when this one is the last",
});
const SearchMatches = Type.Array(
  Type.Object({
    ref: Type.String(),
    name: Type.Optional(Type.String({ description: "Note name; absent for History matches" })),
    offset: Type.Integer({ minimum: 0 }),
    preview: Type.String(),
  }),
  { description: "search: literal matches" },
);

// Flat on purpose: Pi renders a script-callable tool's result as one declaration line, and each
// action fills a different subset of fields. The tool descriptions and README name the subsets.
const HistoryOutputSchema = Type.Object(
  {
    windows: Type.Optional(
      Type.Array(Type.Object({ ref: Type.String(), items: Type.Integer({ minimum: 0 }) }), {
        description: "windows: one page of Context Windows",
      }),
    ),
    items: Type.Optional(
      Type.Array(
        Type.Object({
          ref: Type.String(),
          type: Type.String(),
          timestamp: Type.String(),
          preview: Type.String(),
        }),
        { description: "list: one page of recorded entries" },
      ),
    ),
    matches: Type.Optional(SearchMatches),
    total: Type.Optional(
      Type.Integer({ minimum: 0, description: "windows/list: total windows or entries" }),
    ),
    next_offset: Type.Optional(NextOffset),
    ref: Type.Optional(Type.String({ description: "read: the requested entry reference" })),
    resolved_in_session: Type.Optional(Type.String({ description: "read: issuing session ID" })),
    format: Type.Optional(
      Type.Literal("recorded-entry-json", { description: "read: content kind" }),
    ),
    content: Type.Optional(Type.String({ description: "read: serialized entry JSON chunk" })),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "read: chunk start" })),
    total_characters: Type.Optional(
      Type.Integer({ minimum: 0, description: "read: length of the whole serialized entry" }),
    ),
    availability: Type.Optional(Type.String({ description: "read: what the content omits" })),
  },
  { additionalProperties: false },
);

const NotesOutputSchema = Type.Object(
  {
    notes: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String(),
          updated_at: Type.String(),
          ref: Type.String(),
          characters: Type.Integer({ minimum: 0 }),
        }),
        { description: "list: one page of Notes" },
      ),
    ),
    matches: Type.Optional(SearchMatches),
    total: Type.Optional(Type.Integer({ minimum: 0, description: "list: total Notes" })),
    next_offset: Type.Optional(NextOffset),
    name: Type.Optional(Type.String({ description: "read/write/append/delete: the Note name" })),
    ref: Type.Optional(Type.String({ description: "read: the Note reference" })),
    content: Type.Optional(Type.String({ description: "read: Note text chunk" })),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "read: chunk start" })),
    total_characters: Type.Optional(
      Type.Integer({ minimum: 0, description: "read: length of the whole Note" }),
    ),
    action: Type.Optional(
      StringEnum(["write", "append", "delete"], { description: "mutations: the action performed" }),
    ),
    saved: Type.Optional(
      Type.Literal(true, { description: "mutations: the change was persisted" }),
    ),
  },
  { additionalProperties: false },
);

interface SearchItem {
  ref: string;
  content: string;
  name?: string;
  recorded?: true;
  /** Recorded JSON range that search must not match, such as the call running this search. */
  skip?: { start: number; end: number } | undefined;
}

/** The recorded JSON range of the tool call currently running, if this entry carries it. */
function inFlightCall(entry: SessionEntry, json: string, toolCallId: string) {
  if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;
  const call = entry.message.content.find(
    (block) => block.type === "toolCall" && block.id === toolCallId,
  );
  if (!call) return undefined;
  const recorded = JSON.stringify(call);
  const start = json.indexOf(recorded);
  return start === -1 ? undefined : { start, end: start + recorded.length };
}

function* searchableText(item: SearchItem) {
  if (!item.recorded) {
    yield { content: item.content, start: 0, encoded: "" };
    return;
  }
  // JSON.stringify emits valid JSON. Decode string values so literal searches do not confuse a newline with backslash+n.
  for (const token of item.content.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    if (item.content[token.index + token[0].length] === ":") continue;
    if (item.skip && token.index >= item.skip.start && token.index < item.skip.end) continue;
    yield {
      content: Value.Parse(Type.String(), JSON.parse(token[0])),
      start: token.index,
      encoded: token[0],
    };
  }
}

function encodedOffset(encoded: string, offset: number): number {
  let cursor = 1; // Skip the JSON string's opening quote.
  for (let i = 0; i < offset; i++) {
    cursor += encoded[cursor] === "\\" ? (encoded[cursor + 1] === "u" ? 6 : 2) : 1;
  }
  return cursor;
}

function search(items: Iterable<SearchItem>, query: string, offset: number, limit: number) {
  const matches: Array<{ ref: string; name: string | undefined; offset: number; preview: string }> =
    [];
  let skipped = 0;
  for (const item of items) {
    for (const part of searchableText(item)) {
      let position = part.content.indexOf(query);
      while (position !== -1) {
        if (skipped < offset) skipped++;
        else if (matches.length === limit) return { matches, nextOffset: offset + matches.length };
        else {
          const recordedPosition = part.encoded
            ? part.start + encodedOffset(part.encoded, position)
            : position;
          matches.push({
            ref: item.ref,
            name: item.name,
            offset: recordedPosition,
            // Preview the decoded text so escapes read as characters, not as JSON.
            preview: part.content.slice(Math.max(0, position - 20), position + 60),
          });
        }
        position = part.content.indexOf(query, position + 1);
      }
    }
  }
  return { matches, nextOffset: null };
}

const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;

/** Rename object keys to snake_case; every key is a fixed field name, so values are untouched. */
function snakeCaseKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(snakeCaseKeys);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: The value is JSON this module just serialized; this separates object nodes from primitives, and the output schema test covers every action.
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key.replace(CAMEL_BOUNDARY, "$1_$2").toLowerCase(),
      snakeCaseKeys(entry),
    ]),
  );
}

function result<T>(data: T) {
  const text = JSON.stringify(data);
  // The text the model reads and the value scripts receive come from one serialization. `details`
  // keeps its persisted camelCase shape; only the script-facing value uses snake_case keys.
  return {
    content: [{ type: "text" as const, text }],
    details: data,
    structuredContent: snakeCaseKeys(JSON.parse(text)),
  };
}

/** Registers branch-local storage tools; Handoff/checkpoint policy lives elsewhere. */
export function registerContextTools(
  pi: ExtensionAPI,
  onMutationFailure?: (cause: Error, ctx: ExtensionContext) => void,
): void {
  pi.registerTool<typeof HistoryParameters, ContextToolDetails>({
    name: "context_history",
    label: "Context History",
    description:
      "Read-only selected-branch journal. windows/list/search are paginated (max 20); read returns exact serialized entry JSON with zero-based UTF-16 offsets (max 2000 units). Search is case-sensitive literal text, with JSON string escaping handled for you; returned offsets address serialized entry JSON. Optional window limits list/search. Optional type (entry type, e.g. message) and role (message role, e.g. user) filter list/search; by default every entry is included, and list previews describe each entry's text, tool call, or custom type. Search previews are decoded readable text; a direct search call does not match its own tool-call block. References carry their issuing session; a fork can resolve inherited entry IDs only when present on its selected branch. No unrelated session, abandoned sibling, or external spill file is opened.",
    parameters: HistoryParameters,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: HistoryOutputSchema,
    executionMode: "sequential",
    renderCall: (args, theme, context) =>
      renderContextToolCall("context_history", args, theme, context),
    renderResult: (result, options, theme, context) =>
      renderContextToolResult(result, options, theme, "context_history", context),
    async execute(toolCallId, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      assertContextJournalReadableForModel(ctx.sessionManager);
      if (!Value.Check(HistoryParameters, params))
        throw new Error("Invalid context_history arguments");
      const manager = ctx.sessionManager;
      const branch = manager.getBranch();
      const first = branch[0];
      const windows = first ? [{ id: first.id, start: 0 }] : [];
      branch.forEach((entry, index) => {
        if (entry.type === "compaction" && index > 0) windows.push({ id: entry.id, start: index });
      });
      const offset = params.offset ?? 0;
      const limit = Math.min(params.limit ?? 20, 20);
      if (params.action === "windows") {
        const page = windows.slice(offset, offset + limit).map((window, index) => ({
          ref: contextReference(manager, window.id),
          items: (windows[offset + index + 1]?.start ?? branch.length) - window.start,
        }));
        return result({
          windows: page,
          total: windows.length,
          nextOffset: offset + page.length < windows.length ? offset + page.length : null,
        });
      }
      if (params.action === "read") {
        if (!params.ref) throw new Error("An item reference is required");
        const id = resolveContextReference(manager, params.ref);
        const entry = branch.find((item) => item.id === id);
        if (!entry)
          throw new Error(
            "Reference is unavailable on this selected branch; context-only inheritance does not copy source History",
          );
        const recorded = JSON.stringify(entry);
        const content = recorded.slice(offset, offset + (params.limit ?? 2000));
        return result({
          ref: params.ref,
          resolvedInSession: manager.getSessionId(),
          format: "recorded-entry-json",
          content,
          offset,
          totalCharacters: recorded.length,
          nextOffset: offset + content.length < recorded.length ? offset + content.length : null,
          availability:
            "Only recorded JSON is available here. External spill originals are not read or verified and may be missing; encoded media is not decoded.",
        });
      }
      let entries = branch;
      if (params.window) {
        const id = resolveContextReference(manager, params.window);
        const index = windows.findIndex((window) => window.id === id);
        const window = windows[index];
        if (!window) throw new Error("Context Window is unavailable on the selected branch");
        entries = branch.slice(window.start, windows[index + 1]?.start ?? branch.length);
      }
      const { type, role } = params;
      if (type !== undefined || role !== undefined)
        entries = entries.filter(
          (entry) =>
            (type === undefined || entry.type === type) &&
            (role === undefined || (entry.type === "message" && entry.message.role === role)),
        );
      if (params.action === "list") {
        const page = entries.slice(offset, offset + limit).map((entry) => ({
          ref: contextReference(manager, entry.id),
          type: entry.type,
          timestamp: entry.timestamp,
          preview: describeEntry(entry),
        }));
        return result({
          items: page,
          total: entries.length,
          nextOffset: offset + page.length < entries.length ? offset + page.length : null,
        });
      }
      if (!params.query) throw new Error("A non-empty literal query is required");
      // Only the newest assistant message carries the running call; providers may reuse call IDs.
      const running = branch.findLast(
        (entry) => entry.type === "message" && entry.message.role === "assistant",
      );
      function* recordedEntries(): Generator<SearchItem> {
        for (const entry of entries) {
          const content = JSON.stringify(entry);
          yield {
            ref: contextReference(manager, entry.id),
            content,
            recorded: true,
            skip: entry === running ? inFlightCall(entry, content, toolCallId) : undefined,
          };
        }
      }
      return result(search(recordedEntries(), params.query, offset, limit));
    },
  });
  pi.registerTool<typeof NotesParameters, ContextToolDetails>({
    name: "context_notes",
    label: "Context Notes",
    description:
      "Session-branch Markdown Notes. Actions list/read/write/append/delete/search. Names are labels, not paths. Reads use zero-based UTF-16 offsets and return at most 2000 units; lists return at most 20 Notes. Search is case-sensitive literal text. Forks inherit Notes; plain context-only child inheritance does not copy the store.",
    parameters: NotesParameters,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    outputSchema: NotesOutputSchema,
    executionMode: "sequential",
    renderCall: (args, theme, context) =>
      renderContextToolCall("context_notes", args, theme, context),
    renderResult: (result, options, theme, context) =>
      renderContextToolResult(result, options, theme, "context_notes", context),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      assertContextJournalReadableForModel(ctx.sessionManager);
      if (!Value.Check(NotesParameters, params)) throw new Error("Invalid context_notes arguments");
      const notes = readNotes(ctx.sessionManager);
      const offset = params.offset ?? 0;
      const limit = params.limit ?? (params.action === "read" ? 2000 : 20);
      if (params.action === "list") {
        const page = notes
          .slice(offset, offset + Math.min(limit, 20))
          .map(({ name, updatedAt, ref, content }) => ({
            name,
            updatedAt,
            ref,
            characters: content.length,
          }));
        return result({
          notes: page,
          total: notes.length,
          nextOffset: offset + page.length < notes.length ? offset + page.length : null,
        });
      }
      if (params.action === "search") {
        if (!params.query) throw new Error("A non-empty literal query is required");
        return result(
          search(
            params.name ? notes.filter((n) => n.name === params.name) : notes,
            params.query,
            offset,
            Math.min(limit, 20),
          ),
        );
      }
      if (!params.name) throw new Error("A Note name is required");
      const note = notes.find((item) => item.name === params.name);
      if (params.action === "read") {
        if (!note) throw new Error("Note not found on the selected branch");
        const content = note.content.slice(offset, offset + limit);
        return result({
          name: note.name,
          ref: note.ref,
          content,
          offset,
          totalCharacters: note.content.length,
          nextOffset:
            offset + content.length < note.content.length ? offset + content.length : null,
        });
      }
      if (params.action !== "write" && params.action !== "append" && params.action !== "delete")
        throw new Error("Unsupported Notes action");
      if (params.action === "delete" && !note)
        throw new Error("Note not found on the selected branch");
      if (params.action !== "delete" && params.content === undefined)
        throw new Error("Note content is required");
      if (!note && params.action !== "delete" && notes.length >= MAX_NOTES)
        throw new Error("Note limit reached; delete an obsolete Note first");
      const content =
        params.action === "delete"
          ? null
          : (params.action === "append" ? (note?.content ?? "") : "") + (params.content ?? "");
      if (content !== null && content.length > MAX_NOTE_CHARACTERS)
        throw new Error("Note exceeds 64000 UTF-16 content units");
      signal?.throwIfAborted();
      try {
        appendNote(pi, ctx.sessionManager, params.name, content);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        onMutationFailure?.(error, ctx);
        throw withTroubleshootingHint(error);
      }
      return result({ action: params.action, name: params.name, saved: true });
    },
  });
}
