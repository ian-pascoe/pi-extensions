import { StringEnum, type JsonValue } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { acceptNullForOptionalArguments } from "@ian-pascoe/pi-utils/null-optional-arguments";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  renderContextToolCall,
  renderContextToolResult,
  type ContextToolDetails,
} from "./context-tool-rendering.js";
import { describeEntry } from "./entry-preview.js";
import { isWideScope, SEARCH_SCOPES, sessionById, sessionsInScope } from "./session-scope.js";
import {
  appendNote,
  assertContextJournalReadableForModel,
  contextReference,
  MAX_NOTE_CHARACTERS,
  MAX_NOTES,
  NoteName,
  noteNameOf,
  parseContextReference,
  readNotes,
  replayNotes,
  resolveContextReference,
  type ContextNote,
  type ReadonlySessionManager,
  withTroubleshootingHint,
} from "./context-store.js";

/**
 * Tool guidelines live in Pi's base prompt, so runs that skip `before_agent_start`, such as
 * idle-triggered custom messages, keep the same prompt prefix. Each names only its own tool:
 * codemode repeats a hidden tool's guideline to scripts, which never see `context_rollover`.
 */
export const CONTEXT_PROMPT_GUIDELINES = {
  context_notes: "Keep named Notes with context_notes; read full Notes only when needed.",
  context_history:
    "Original selected-branch History is available through context_history; inherited references may be unavailable locally.",
  context_rollover:
    "Before Rollover, update Notes with context_notes, then call context_rollover alone with an explicit continuation Handoff.",
} as const;

const Scope = StringEnum(SEARCH_SCOPES, {
  description:
    'Sessions covered, read-only beyond this one: "branch" (default) is this session; "lineage" adds the agents this agent was spawned by and spawned; "repository" adds every session in this git repository, across worktrees; "all" adds every session Pi keeps. Newest session first',
});

const NotesParameters = Type.Object(
  {
    action: StringEnum(["list", "read", "write", "append", "delete", "search", "copy"]),
    scope: Type.Optional(Scope),
    ref: Type.Optional(Type.String({ maxLength: 300 })),
    name: Type.Optional(NoteName),
    content: Type.Optional(Type.String({ maxLength: MAX_NOTE_CHARACTERS })),
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_NOTE_CHARACTERS })),
  },
  { additionalProperties: false },
);

const HistoryParameters = Type.Object(
  {
    action: StringEnum(["windows", "list", "read", "search"]),
    scope: Type.Optional(Scope),
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
    agent: Type.Optional(Type.String({ description: "scoped: owning agent, or root" })),
    session: Type.Optional(Type.String({ description: "scoped: owning session ID" })),
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
          agent: Type.Optional(Type.String({ description: "scoped: owning agent, or root" })),
          session: Type.Optional(Type.String({ description: "scoped: owning session ID" })),
        }),
        { description: "list: one page of Notes" },
      ),
    ),
    matches: Type.Optional(SearchMatches),
    total: Type.Optional(Type.Integer({ minimum: 0, description: "list: total Notes" })),
    next_offset: Type.Optional(NextOffset),
    name: Type.Optional(Type.String({ description: "read/write/append/delete: the Note name" })),
    ref: Type.Optional(Type.String({ description: "read: the Note reference" })),
    agent: Type.Optional(Type.String({ description: "read: owning agent of a Lineage Note" })),
    session: Type.Optional(Type.String({ description: "read: owning session of a Lineage Note" })),
    content: Type.Optional(Type.String({ description: "read: Note text chunk" })),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "read: chunk start" })),
    total_characters: Type.Optional(
      Type.Integer({ minimum: 0, description: "read: length of the whole Note" }),
    ),
    action: Type.Optional(
      StringEnum(["write", "append", "delete", "copy"], {
        description: "mutations: the action performed",
      }),
    ),
    saved: Type.Optional(
      Type.Literal(true, { description: "mutations: the change was persisted" }),
    ),
  },
  { additionalProperties: false },
);

/** Owner labels, present only when a scope reaches beyond the caller's own session. */
interface OwnerLabel {
  agent?: string;
  session?: string;
}
type Labelled<T> = T & OwnerLabel;
type ScopedNote = Labelled<ContextNote>;

/** Adds the owner labels to a result in place, leaving unscoped results byte-identical to before. */
function labelled<T extends object>(value: T, owner: OwnerLabel): Labelled<T> {
  const result: Labelled<T> = value;
  if (owner.agent !== undefined) result.agent = owner.agent;
  if (owner.session !== undefined) result.session = owner.session;
  return result;
}

interface SearchItem extends OwnerLabel {
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

async function search(
  items: Iterable<SearchItem> | AsyncIterable<SearchItem>,
  query: string,
  offset: number,
  limit: number,
) {
  const matches: Array<
    Labelled<{ ref: string; name: string | undefined; offset: number; preview: string }>
  > = [];
  let skipped = 0;
  for await (const item of items) {
    for (const part of searchableText(item)) {
      let position = part.content.indexOf(query);
      while (position !== -1) {
        if (skipped < offset) skipped++;
        else if (matches.length === limit) return { matches, nextOffset: offset + matches.length };
        else {
          const recordedPosition = part.encoded
            ? part.start + encodedOffset(part.encoded, position)
            : position;
          matches.push(
            labelled(
              {
                ref: item.ref,
                name: item.name,
                offset: recordedPosition,
                // Preview the decoded text so escapes read as characters, not as JSON.
                preview: part.content.slice(Math.max(0, position - 20), position + 60),
              },
              item,
            ),
          );
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
  const historyTool = defineTool<typeof HistoryParameters, ContextToolDetails>({
    name: "context_history",
    label: "Context History",
    description:
      'Read-only selected-branch journal. search also accepts scope "lineage", "repository", or "all" to cover other sessions\' latest branches, labelled by agent and session; read accepts any ref search returns. windows/list/search are paginated (max 20); read returns exact serialized entry JSON, at most 2000 characters per call from a zero-based offset. Search is case-sensitive literal text, with JSON string escaping handled for you; returned offsets address serialized entry JSON. Optional window limits list/search. Optional type (entry type, e.g. message) and role (message role, e.g. user) filter list/search; by default every entry is included, and list previews describe each entry\'s text, tool call, or custom type. Search previews are decoded readable text; a direct search call does not match its own tool-call block. References carry their issuing session; a fork can resolve inherited entry IDs only when present on its selected branch. Other sessions are never written, and no abandoned sibling or external spill file is opened.',
    promptGuidelines: [CONTEXT_PROMPT_GUIDELINES.context_history],
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
      const { scope } = params;
      const scoped = isWideScope(scope);
      if (scoped && (params.action === "windows" || params.action === "list"))
        throw new Error(
          "windows and list browse this session only; use search with scope to find entries in other sessions, then read their refs",
        );
      if (scoped && params.window)
        throw new Error("window selects one of this session's Context Windows; omit it with scope");
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
        const { entry, sessionId } = await historyEntryAt(manager, params.ref, signal);
        const recorded = JSON.stringify(entry);
        const content = recorded.slice(offset, offset + (params.limit ?? 2000));
        return result({
          ref: params.ref,
          resolvedInSession: sessionId,
          format: "recorded-entry-json",
          content,
          offset,
          totalCharacters: recorded.length,
          nextOffset: offset + content.length < recorded.length ? offset + content.length : null,
          availability:
            "Only recorded JSON is available here. External spill originals are not read or verified and may be missing; encoded media is not decoded.",
        });
      }
      let entries: readonly SessionEntry[] = branch;
      if (params.window) {
        const id = resolveContextReference(manager, params.window);
        const index = windows.findIndex((window) => window.id === id);
        const window = windows[index];
        if (!window) throw new Error("Context Window is unavailable on the selected branch");
        entries = branch.slice(window.start, windows[index + 1]?.start ?? branch.length);
      }
      const { type, role } = params;
      const filter = (items: readonly SessionEntry[]) =>
        type === undefined && role === undefined
          ? items
          : items.filter(
              (entry) =>
                (type === undefined || entry.type === type) &&
                (role === undefined || (entry.type === "message" && entry.message.role === role)),
            );
      entries = filter(entries);
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
      const sessions = isWideScope(scope)
        ? sessionsInScope(manager, scope, signal)
        : [{ sessionId: manager.getSessionId(), agent: undefined, current: true, branch }];
      async function* recordedEntries(): AsyncGenerator<SearchItem> {
        for await (const session of sessions) {
          for (const entry of session.current ? entries : filter(session.branch)) {
            signal?.throwIfAborted();
            const content = JSON.stringify(entry);
            yield labelled(
              {
                ref: session.current
                  ? contextReference(manager, entry.id)
                  : `context:${session.sessionId}:${entry.id}`,
                content,
                recorded: true as const,
                skip:
                  session.current && entry === running
                    ? inFlightCall(entry, content, toolCallId)
                    : undefined,
              },
              session.agent === undefined
                ? {}
                : { agent: session.agent, session: session.sessionId },
            );
          }
        }
      }
      return result(await search(recordedEntries(), params.query, offset, limit));
    },
  });
  pi.registerTool(acceptNullForOptionalArguments(historyTool));
  const notesTool = defineTool<typeof NotesParameters, ContextToolDetails>({
    name: "context_notes",
    label: "Context Notes",
    description:
      'Session-branch Markdown Notes. Actions list/read/write/append/delete/search/copy. Names are labels, not paths. list/search with scope "lineage", "repository", or "all" also cover the current Notes of other sessions, labelled by agent and session; those are read-only. read takes a name for your own Notes or a ref from list/search for any; copy saves the Note a ref names into your Notes, under name if given, as an unlinked snapshot. read returns the whole Note unless offset/limit select a character range; lists return at most 20 Notes. Append starts the new text on a new line unless the Note is empty or already ends with one. Search is case-sensitive literal text. Forks inherit Notes.',
    promptGuidelines: [CONTEXT_PROMPT_GUIDELINES.context_notes],
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
      const limit = params.limit ?? (params.action === "read" ? MAX_NOTE_CHARACTERS : 20);
      const { scope } = params;
      /** The Notes in scope, session by session, so a search can stop once its page is full. */
      async function* notesInScope(): AsyncGenerator<ScopedNote> {
        if (!isWideScope(scope)) return yield* notes;
        for await (const session of sessionsInScope(ctx.sessionManager, scope, signal))
          for (const note of session.current
            ? notes
            : replayNotes(session.branch, session.sessionId))
            yield { ...note, agent: session.agent, session: session.sessionId };
      }
      if (params.action === "list") {
        const scoped = await Array.fromAsync(notesInScope());
        const page = scoped.slice(offset, offset + Math.min(limit, 20)).map((note) =>
          labelled(
            {
              name: note.name,
              updatedAt: note.updatedAt,
              ref: note.ref,
              characters: note.content.length,
            },
            note,
          ),
        );
        return result({
          notes: page,
          total: scoped.length,
          nextOffset: offset + page.length < scoped.length ? offset + page.length : null,
        });
      }
      if (params.action === "search") {
        if (!params.query) throw new Error("A non-empty literal query is required");
        const { name } = params;
        async function* named() {
          for await (const note of notesInScope()) if (!name || note.name === name) yield note;
        }
        return result(await search(named(), params.query, offset, Math.min(limit, 20)));
      }
      if (params.action === "read") {
        if (!params.ref && !params.name) throw new Error("A Note name or ref is required");
        const note: ScopedNote | undefined = params.ref
          ? await noteAt(ctx.sessionManager, params.ref, signal)
          : notes.find((item) => item.name === params.name);
        if (!note) throw new Error("Note not found on the selected branch");
        const content = note.content.slice(offset, offset + limit);
        return result(
          labelled(
            {
              name: note.name,
              ref: note.ref,
              content,
              offset,
              totalCharacters: note.content.length,
              nextOffset:
                offset + content.length < note.content.length ? offset + content.length : null,
            },
            note,
          ),
        );
      }
      const source =
        params.action === "copy"
          ? await noteAt(ctx.sessionManager, requireRef(params.ref), signal)
          : undefined;
      const name = params.name ?? source?.name;
      if (!name) throw new Error("A Note name is required");
      const note = notes.find((item) => item.name === name);
      if (params.action === "delete" && !note)
        throw new Error("Note not found on the selected branch");
      if (params.action === "copy" && note)
        throw new Error(
          `A Note named ${JSON.stringify(name)} already exists; pass name to copy under another name`,
        );
      if ((params.action === "write" || params.action === "append") && params.content === undefined)
        throw new Error("Note content is required");
      if (!note && params.action !== "delete" && notes.length >= MAX_NOTES)
        throw new Error("Note limit reached; delete an obsolete Note first");
      const content =
        params.action === "delete"
          ? null
          : params.action === "append"
            ? joinAppend(note?.content ?? "", params.content ?? "")
            : (source?.content ?? params.content ?? "");
      if (content !== null && content.length > MAX_NOTE_CHARACTERS)
        throw new Error(`Note exceeds ${MAX_NOTE_CHARACTERS} characters`);
      signal?.throwIfAborted();
      try {
        appendNote(pi, ctx.sessionManager, name, content);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        onMutationFailure?.(error, ctx);
        throw withTroubleshootingHint(error);
      }
      return result({ action: params.action, name, saved: true });
    },
  });
  pi.registerTool(acceptNullForOptionalArguments(notesTool));
}

/** A recorded History entry and the session whose journal holds it. */
interface HeldEntry {
  entry: SessionEntry;
  sessionId: string;
}

/**
 * The recorded entry a History ref names: on this selected branch (including entries a native
 * fork inherited), or otherwise in another session Pi keeps.
 */
async function historyEntryAt(
  manager: ReadonlySessionManager,
  ref: string,
  signal?: AbortSignal,
): Promise<HeldEntry> {
  const { sourceSession, entryId } = parseContextReference(manager, ref);
  let ownFailure: Error;
  try {
    const id = resolveContextReference(manager, ref);
    const entry = manager.getBranch().find((item) => item.id === id);
    if (entry) return { entry, sessionId: manager.getSessionId() };
    ownFailure = new Error(
      "Reference is unavailable on this selected branch; context-only inheritance does not copy source History",
    );
  } catch (cause) {
    ownFailure = cause instanceof Error ? cause : new Error(String(cause));
  }
  if (sourceSession === manager.getSessionId()) throw ownFailure;
  const session = await sessionById(manager, sourceSession, signal);
  const entry = session?.branch.find((item) => item.id === entryId);
  if (!session || !entry) throw ownFailure;
  return { entry, sessionId: session.sessionId };
}

function requireRef(ref: string | undefined): string {
  if (!ref) throw new Error("copy needs the ref of a Note from context_notes list or search");
  return ref;
}

/**
 * The current version of the Note a ref names: the caller's own (including Notes a native fork
 * inherited), or another session's, read live from its file.
 */
async function noteAt(
  manager: ReadonlySessionManager,
  ref: string,
  signal?: AbortSignal,
): Promise<ScopedNote> {
  const { sourceSession, entryId } = parseContextReference(manager, ref);
  let ownEntryId: string | undefined;
  try {
    ownEntryId = resolveContextReference(manager, ref);
  } catch {
    ownEntryId = undefined; // Not proven on this branch; it may belong to another agent.
  }
  const ownEntry = manager.getBranch().find((entry) => entry.id === ownEntryId);
  if (ownEntry || sourceSession === manager.getSessionId()) {
    const name = noteNameOf(ownEntry);
    const note = readNotes(manager).find((item) => item.name === name);
    if (!note) throw new Error("Note not found on the selected branch");
    return note;
  }
  const session = await sessionById(manager, sourceSession, signal);
  if (!session) throw new Error(`No session ${sourceSession} among the sessions Pi keeps`);
  const name = noteNameOf(session.branch.find((entry) => entry.id === entryId));
  const note = replayNotes(session.branch, session.sessionId).find((item) => item.name === name);
  if (!note) throw new Error(`Note not found in ${session.agent}'s session`);
  return labelled(note, { agent: session.agent, session: session.sessionId });
}

/** Starts appended text on a new line so it never runs into the Note's last line. */
function joinAppend(existing: string, appended: string): string {
  return existing === "" || appended === "" || existing.endsWith("\n")
    ? existing + appended
    : `${existing}\n${appended}`;
}
