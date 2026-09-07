import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  renderContextToolCall,
  renderContextToolResult,
  type ContextToolDetails,
} from "./context-tool-rendering.js";
import {
  appendNote,
  assertContextJournalReadable,
  contextReference,
  MAX_NOTE_CHARACTERS,
  MAX_NOTES,
  NoteName,
  readNotes,
  resolveContextReference,
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
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
  },
  { additionalProperties: false },
);

interface SearchItem {
  ref: string;
  content: string;
  name?: string;
  recorded?: true;
}

function* searchableText(item: SearchItem) {
  if (!item.recorded) {
    yield { content: item.content, start: 0, encoded: "" };
    return;
  }
  // JSON.stringify emits valid JSON. Decode string values so literal searches do not confuse a newline with backslash+n.
  for (const token of item.content.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    if (item.content[token.index + token[0].length] === ":") continue;
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
            preview: item.content.slice(Math.max(0, recordedPosition - 20), recordedPosition + 60),
          });
        }
        position = part.content.indexOf(query, position + 1);
      }
    }
  }
  return { matches, nextOffset: null };
}

function result<T>(data: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data };
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
      "Read-only selected-branch journal. windows/list/search are paginated (max 20); read returns exact serialized entry JSON with zero-based UTF-16 offsets (max 2000 units). Search is case-sensitive literal text, with JSON string escaping handled for you; returned offsets address serialized entry JSON. Optional window limits list/search. References carry their issuing session; a fork can resolve inherited entry IDs only when present on its selected branch. No unrelated session, abandoned sibling, or external spill file is opened.",
    parameters: HistoryParameters,
    executionMode: "sequential",
    renderCall: (args, theme, context) =>
      renderContextToolCall(
        "History",
        args,
        theme,
        context.isPartial,
        context.executionStarted,
        context.expanded,
      ),
    renderResult: (result, options, theme, context) =>
      renderContextToolResult(result, options, theme, "History", context.args, context.isError),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      assertContextJournalReadable(ctx.sessionManager);
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
      if (params.action === "list") {
        const page = entries.slice(offset, offset + limit).map((entry) => ({
          ref: contextReference(manager, entry.id),
          type: entry.type,
          timestamp: entry.timestamp,
          preview: JSON.stringify(entry).slice(0, 80),
        }));
        return result({
          items: page,
          total: entries.length,
          nextOffset: offset + page.length < entries.length ? offset + page.length : null,
        });
      }
      if (!params.query) throw new Error("A non-empty literal query is required");
      function* recordedEntries(): Generator<SearchItem> {
        for (const entry of entries)
          yield {
            ref: contextReference(manager, entry.id),
            content: JSON.stringify(entry),
            recorded: true,
          };
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
    executionMode: "sequential",
    renderCall: (args, theme, context) =>
      renderContextToolCall(
        "Notes",
        args,
        theme,
        context.isPartial,
        context.executionStarted,
        context.expanded,
      ),
    renderResult: (result, options, theme, context) =>
      renderContextToolResult(result, options, theme, "Notes", context.args, context.isError),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      assertContextJournalReadable(ctx.sessionManager);
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
        throw error;
      }
      return result({ action: params.action, name: params.name, saved: true });
    },
  });
}
