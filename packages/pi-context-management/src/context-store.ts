import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export type ReadonlySessionManager = ExtensionContext["sessionManager"];

export const MAX_NOTE_CHARACTERS = 64_000;
export const MAX_NOTES = 128;
export const NoteName = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9 ._-]*$",
});
const NOTE_ENTRY = "pi-context-note";
const ORIGIN_ENTRY = "pi-context-origin";
const JOURNAL_FAULT = Symbol.for("@ian-pascoe/pi-context-management/journal-fault");
const SourceSession = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9-]+$",
});
const NoteRecord = Type.Object(
  {
    version: Type.Literal(1),
    name: NoteName,
    content: Type.Union([Type.String({ maxLength: MAX_NOTE_CHARACTERS }), Type.Null()]),
    sourceSession: SourceSession,
  },
  { additionalProperties: false },
);
const OriginRecord = Type.Object(
  { version: Type.Literal(1), sourceSession: SourceSession },
  { additionalProperties: false },
);
const OwnedCheckpointDetails = Type.Object(
  {
    owner: Type.Literal("pi-context-management"),
    version: Type.Literal(1),
    sourceSession: SourceSession,
  },
  { additionalProperties: true },
);

export interface ContextNote {
  name: string;
  content: string;
  updatedAt: string;
  ref: string;
}

/** Quarantines this exact loaded journal until SessionManager replaces its native header. */
export function quarantineContextJournal(manager: ReadonlySessionManager): void {
  Object.defineProperty(manager, JOURNAL_FAULT, {
    value: manager.getHeader(),
    configurable: true,
  });
}

/** Prevents resource reload from exposing entries that a failed append left only in memory. */
export function assertContextJournalReadable(manager: ReadonlySessionManager): void {
  const marker = Object.getOwnPropertyDescriptor(manager, JOURNAL_FAULT);
  if (marker !== undefined && marker.value === manager.getHeader()) {
    throw new Error(
      "Journal write failed; reopen the persisted session, not just /reload, before using Context Management",
    );
  }
}

/** Persists the current session as a reference issuer; native forks inherit this provenance. */
export function ensureReferenceOrigin(
  pi: {
    appendEntry(customType: string, data: { version: 1; sourceSession: string }): void;
  },
  manager: ReadonlySessionManager,
): void {
  assertContextJournalReadable(manager);
  const sourceSession = manager.getSessionId();
  if (
    manager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === ORIGIN_ENTRY &&
          Value.Check(OriginRecord, entry.data) &&
          entry.data.sourceSession === sourceSession,
      )
  ) {
    return;
  }
  try {
    pi.appendEntry(ORIGIN_ENTRY, { version: 1, sourceSession });
  } catch (cause) {
    quarantineContextJournal(manager);
    throw cause;
  }
}

/** References identify an entry, not a filename or permission to open another session. */
export function contextReference(manager: ReadonlySessionManager, entryId: string): string {
  return `context:${manager.getSessionId()}:${entryId}`;
}

/** Validates that a reference issuer is proven on the selected branch before resolving its entry ID. */
export function resolveContextReference(manager: ReadonlySessionManager, ref: string): string {
  const match = /^context:([A-Za-z0-9-]{1,128}):([A-Za-z0-9-]{1,128})$/.exec(ref);
  const sourceSession = match?.[1];
  const entryId = match?.[2];
  if (!sourceSession || !entryId) {
    throw new Error("Expected a source-qualified context:<session>:<entry> reference");
  }
  assertContextJournalReadable(manager);
  if (sourceSession === manager.getSessionId()) return entryId;
  const branch = manager.getBranch();
  const entryIndex = branch.findIndex((entry) => entry.id === entryId);
  // An owned record proves that its issuing session saw this prefix, not later fork entries.
  const provenThrough = branch.findLastIndex((entry) => {
    if (
      entry.type === "custom" &&
      ((entry.customType === ORIGIN_ENTRY && Value.Check(OriginRecord, entry.data)) ||
        (entry.customType === NOTE_ENTRY && Value.Check(NoteRecord, entry.data)))
    ) {
      return entry.data.sourceSession === sourceSession;
    }
    return (
      entry.type === "compaction" &&
      Value.Check(OwnedCheckpointDetails, entry.details) &&
      entry.details.sourceSession === sourceSession
    );
  });
  if (entryIndex < 0 || entryIndex > provenThrough) {
    throw new Error("Reference source session is not proven for this entry on the selected branch");
  }
  return entryId;
}

/** Replays the selected branch, including Notes inherited by a native journal fork. */
export function readNotes(manager: ReadonlySessionManager): ContextNote[] {
  assertContextJournalReadable(manager);
  const notes = new Map<string, ContextNote>();
  // ponytail: replay is O(branch length); add an invalidated index only if measured retrieval latency warrants it.
  for (const entry of manager.getBranch()) {
    if (
      entry.type !== "custom" ||
      entry.customType !== NOTE_ENTRY ||
      !Value.Check(NoteRecord, entry.data)
    )
      continue;
    if (entry.data.content === null) notes.delete(entry.data.name);
    else
      notes.set(entry.data.name, {
        name: entry.data.name,
        content: entry.data.content,
        updatedAt: entry.timestamp,
        ref: `context:${entry.data.sourceSession}:${entry.id}`,
      });
  }
  return [...notes.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Persists first; no speculative in-memory Notes cache or Cell-return dependency. */
export function appendNote(
  pi: Pick<ExtensionAPI, "appendEntry">,
  manager: ReadonlySessionManager,
  name: string,
  content: string | null,
): void {
  const record = { version: 1, name, content, sourceSession: manager.getSessionId() };
  if (!Value.Check(NoteRecord, record))
    throw new Error(
      "Invalid Note: use a 1–64 character name and at most 64000 UTF-16 content units.",
    );
  try {
    pi.appendEntry(NOTE_ENTRY, record);
  } catch (cause) {
    quarantineContextJournal(manager);
    throw cause;
  }
}

/** A bounded catalogue, never full Note contents. */
export function noteIndex(manager: ReadonlySessionManager, maxCharacters = 4000): string {
  assertContextJournalReadable(manager);
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 0)
    throw new Error("Invalid Note Index bound");
  const notes = readNotes(manager);
  const lines = [
    `Notes: ${notes.length}. Read with context_notes; references are source-qualified.`,
  ];
  const suffix = "\nUse context_notes list for the complete catalogue.";
  for (const note of notes) {
    const line = `\n${JSON.stringify(note.name)} ${note.ref}`;
    if (lines.join("").length + line.length + suffix.length > maxCharacters) break;
    lines.push(line);
  }
  return (lines.join("") + (lines.length - 1 < notes.length ? suffix : "")).slice(0, maxCharacters);
}
