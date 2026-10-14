import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseSessionEntries,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  AGENT_LINEAGE_ENTRY_TYPE,
  readAgentLineage,
  type AgentLineage,
} from "@ian-pascoe/pi-utils/agent-lineage";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ReadonlySessionManager } from "./context-store.js";

const SessionHeader = Type.Object({ type: Type.Literal("session"), id: Type.String() });

export const SEARCH_SCOPES = ["branch", "lineage"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/** A session whose latest branch a scoped read may cover. */
export interface ScopedSession {
  readonly sessionId: string;
  /** The owning agent's ID, or "root" for the session at the top of its agent tree. */
  readonly agent: string;
  /** Whether this is the calling session, read live rather than from its file. */
  readonly current: boolean;
  readonly branch: readonly SessionEntry[];
}

/** Lineage records sit near the start of a child session, before its conversation. */
const HEAD_BYTES = 16 * 1024;

/** The first bytes of a session file, or "" if it is gone or unreadable. */
async function readHead(path: string): Promise<string> {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return ""; // Deleted since it was listed, or unreadable.
  }
}

interface SessionFile {
  readonly sessionId: string;
  readonly branch: readonly SessionEntry[];
}

/**
 * Parses a session file without SessionManager.open, which can migrate and rewrite it; undefined
 * if it is gone, unreadable, or not a session.
 */
async function readSessionFile(path: string): Promise<SessionFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined; // Deleted since it was listed, or unreadable.
  }
  // A live session may end in a half-written line; Pi's parser skips malformed lines.
  const entries = parseSessionEntries(text);
  const header = entries[0];
  if (header?.type !== "session") return undefined;
  const manager = SessionManager.inMemory(header.cwd, undefined, entries);
  return { sessionId: header.id, branch: manager.getBranch() };
}

function headerId(head: string): string | undefined {
  let header: unknown;
  try {
    header = JSON.parse(head.slice(0, head.indexOf("\n")));
  } catch {
    return undefined; // Not a session file, or an unreadable header.
  }
  return Value.Check(SessionHeader, header) ? header.id : undefined;
}

/** The session files in `dir`, newest first: Pi names each after its creation time. */
async function sessionFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((file) => file.endsWith(".jsonl"))
      .sort()
      .reverse()
      .map((file) => join(dir, file));
  } catch {
    return [];
  }
}

/**
 * The calling session, then its ancestors nearest first, then its descendants newest first.
 * Every agent in one tree keeps its session in the root agent's session folder.
 */
export async function lineageSessions(
  manager: ReadonlySessionManager,
  signal?: AbortSignal,
): Promise<ScopedSession[]> {
  const ownId = manager.getSessionId();
  const ownBranch = manager.getBranch();
  const own = readAgentLineage(ownId, ownBranch);
  const rootSessionId = own?.rootSessionId ?? ownId;
  const current: ScopedSession = {
    sessionId: ownId,
    agent: own?.agentId ?? "root",
    current: true,
    branch: ownBranch,
  };
  const dir = manager.getSessionDir();
  if (!dir) return [current];

  const ownFile = manager.getSessionFile();
  let root: SessionFile | undefined;
  const agents = new Map<string, { lineage: AgentLineage; session: SessionFile }>();
  for (const path of await sessionFiles(dir)) {
    signal?.throwIfAborted();
    if (path === ownFile) continue;
    const head = await readHead(path);
    const id = headerId(head);
    if (id === undefined || id === ownId) continue;
    if (id === rootSessionId) root = await readSessionFile(path);
    else if (head.includes(`"customType":"${AGENT_LINEAGE_ENTRY_TYPE}"`)) {
      const session = await readSessionFile(path);
      const lineage = session && readAgentLineage(session.sessionId, session.branch);
      if (session && lineage?.rootSessionId === rootSessionId && !agents.has(lineage.agentId))
        agents.set(lineage.agentId, { lineage, session });
    }
  }

  const chainOf = (parentAgentId: string | null): string[] => {
    const chain: string[] = [];
    for (let parent = parentAgentId; parent !== null && !chain.includes(parent);) {
      chain.push(parent);
      parent = agents.get(parent)?.lineage.parentAgentId ?? null;
    }
    return chain;
  };
  const scoped = (session: SessionFile, agent: string): ScopedSession => ({
    sessionId: session.sessionId,
    agent,
    current: false,
    branch: session.branch,
  });

  const ancestors: ScopedSession[] = [];
  if (own) {
    for (const agentId of chainOf(own.parentAgentId)) {
      const ancestor = agents.get(agentId);
      if (ancestor) ancestors.push(scoped(ancestor.session, agentId));
    }
    if (root) ancestors.push(scoped(root, "root"));
  }
  const descendants = [...agents.values()]
    .filter(({ lineage }) => !own || chainOf(lineage.parentAgentId).includes(own.agentId))
    .map(({ lineage, session }) => scoped(session, lineage.agentId));
  return [current, ...ancestors, ...descendants];
}
