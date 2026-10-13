import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { access, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  getAgentDir,
  parseSessionEntries,
  SessionManager,
  type FileEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  AGENT_LINEAGE_ENTRY_TYPE,
  readAgentLineage,
  type AgentLineage,
} from "@ian-pascoe/pi-utils/agent-lineage";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ReadonlySessionManager } from "./context-store.js";

const SessionHeader = Type.Object({ type: Type.Literal("session"), id: Type.String() });

export const SEARCH_SCOPES = ["branch", "lineage", "repository", "all"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/** The custom entry in which a session records the repository its working folder belongs to. */
export const REPOSITORY_ENTRY_TYPE = "pi-context-repository";

const RepositoryRecord = Type.Object({
  version: Type.Literal(1),
  /** The working folder the record describes; a record for another folder is ignored. */
  cwd: Type.String(),
  /** The repository's main worktree folder, or null when the folder was in no repository. */
  repository: Type.Union([Type.String(), Type.Null()]),
});
type RepositoryRecord = Static<typeof RepositoryRecord>;

/**
 * The repository a session recorded for `cwd`: its main worktree folder, null when the folder was
 * in no repository, or undefined when the session recorded none.
 */
function recordedRepository(entries: readonly FileEntry[], cwd: string): string | null | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      entry?.type === "custom" &&
      entry.customType === REPOSITORY_ENTRY_TYPE &&
      Value.Check(RepositoryRecord, entry.data) &&
      entry.data.cwd === cwd
    )
      return entry.data.repository;
  }
  return undefined;
}

/**
 * The main worktree folder of the git repository holding `cwd`, which every linked worktree
 * shares, or undefined when `cwd` is in no repository or git cannot run there.
 */
function repositoryOf(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  // Git hooks export GIT_DIR and friends, which would override `-C`.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const options: ExecFileOptionsWithStringEncoding = { env, timeout: 5_000, encoding: "utf8" };
  if (signal) options.signal = signal;
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      options,
      (error, stdout) => {
        if (error) return resolve(undefined);
        const common = stdout.trim();
        // A bare repository has no main worktree; its common directory names it instead.
        realpath(basename(common) === ".git" ? dirname(common) : common).then(resolve, () =>
          resolve(undefined),
        );
      },
    );
  });
}

/**
 * Records the repository of the session's working folder once, so the repository scope still
 * finds the session after a worktree's folder is removed. `isCurrent` reports whether the session
 * is still the runtime's current one once git answers; a replaced session is left untouched.
 */
export async function recordRepository(
  pi: { appendEntry(customType: string, data: RepositoryRecord): void },
  manager: ReadonlySessionManager,
  isCurrent: () => boolean,
): Promise<void> {
  const cwd = manager.getCwd();
  if (recordedRepository(manager.getBranch(), cwd) !== undefined) return;
  const repository = (await repositoryOf(cwd)) ?? null;
  if (!isCurrent() || recordedRepository(manager.getBranch(), cwd) !== undefined) return;
  pi.appendEntry(REPOSITORY_ENTRY_TYPE, { version: 1, cwd, repository });
}

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

function readHead(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    return buffer.toString("utf8", 0, readSync(fd, buffer, 0, HEAD_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

interface SessionFile {
  readonly sessionId: string;
  readonly branch: readonly SessionEntry[];
}

/** Parses a session file without SessionManager.open, which can migrate and rewrite it. */
function parseSessionFile(text: string): SessionFile | undefined {
  // A live session may end in a half-written line; Pi's parser skips malformed lines.
  const entries = parseSessionEntries(text);
  const header = entries[0];
  if (header?.type !== "session") return undefined;
  // The last entry is the leaf, so the branch is the session's latest.
  const manager = SessionManager.inMemory(header.cwd, undefined, entries);
  return { sessionId: header.id, branch: manager.getBranch() };
}

function readSessionFile(path: string): SessionFile | undefined {
  return parseSessionFile(readFileSync(path, "utf8"));
}

async function readSessionFileAsync(path: string): Promise<SessionFile | undefined> {
  try {
    return parseSessionFile(await readFile(path, "utf8"));
  } catch {
    return undefined; // Deleted since it was listed, or unreadable.
  }
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

function sessionFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".jsonl"))
      .sort()
      .reverse()
      .map((file) => join(dir, file));
  } catch {
    return [];
  }
}

/** The header and the first entries of a session file, where its records sit. */
async function readHeadEntries(path: string): Promise<FileEntry[]> {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      // A line cut at the buffer's end is malformed JSON, which the parser skips.
      return parseSessionEntries(buffer.toString("utf8", 0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    return []; // Deleted since it was listed, or unreadable.
  }
}

/**
 * Every session file Pi keeps: the top level of each per-folder directory in Pi's sessions folder,
 * which leaves out nested stores such as advisor sessions, and of this session's own directory,
 * which may be a custom one. Newest first.
 */
async function allSessionFiles(
  manager: ReadonlySessionManager,
  signal?: AbortSignal,
): Promise<string[]> {
  const root = join(getAgentDir(), "sessions");
  const dirs = new Set<string>();
  const own = manager.getSessionDir();
  if (own) dirs.add(own);
  try {
    for (const entry of await readdir(root, { withFileTypes: true }))
      if (entry.isDirectory()) dirs.add(join(root, entry.name));
  } catch {
    // No sessions folder yet.
  }
  const files = new Map<string, number>();
  for (const dir of dirs) {
    signal?.throwIfAborted();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        files.set(path, (await stat(path)).mtimeMs);
      } catch {
        // Deleted since it was listed.
      }
    }
  }
  return [...files]
    .sort(([a, aTime], [b, bTime]) => bTime - aTime || basename(b).localeCompare(basename(a)))
    .map(([path]) => path);
}

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function agentOf(session: SessionFile): string {
  return readAgentLineage(session.sessionId, session.branch)?.agentId ?? "root";
}

/**
 * The calling session, then every other session Pi keeps, newest first: for `repository`, only
 * those whose working folder belongs to the same git repository, through any worktree. A session
 * matches by the repository it recorded, or else by asking git about its folder; a session whose
 * folder is gone and that recorded nothing is covered only by `all`. Files are read one at a time,
 * as the caller consumes them.
 */
export async function* wideSessions(
  manager: ReadonlySessionManager,
  scope: "repository" | "all",
  signal?: AbortSignal,
): AsyncGenerator<ScopedSession> {
  const ownId = manager.getSessionId();
  const ownBranch = manager.getBranch();
  yield {
    sessionId: ownId,
    agent: agentOf({ sessionId: ownId, branch: ownBranch }),
    current: true,
    branch: ownBranch,
  };
  const repositories = new Map<string, Promise<string | undefined>>();
  const repositoryAt = (cwd: string) => {
    let repository = repositories.get(cwd);
    if (!repository) {
      repository = repositoryOf(cwd, signal);
      repositories.set(cwd, repository);
    }
    return repository;
  };
  const ownCwd = manager.getCwd();
  const ownRepository =
    scope === "repository"
      ? (recordedRepository(ownBranch, ownCwd) ?? (await repositoryAt(ownCwd)) ?? null)
      : null;
  if (scope === "repository" && ownRepository === null) return;
  const seen = new Set([ownId]);
  for (const path of await allSessionFiles(manager, signal)) {
    signal?.throwIfAborted();
    const head = await readHeadEntries(path);
    const header = head[0];
    if (header?.type !== "session" || seen.has(header.id)) continue;
    seen.add(header.id);
    let session: SessionFile | undefined;
    if (scope === "repository") {
      let repository = recordedRepository(head, header.cwd);
      if (repository === undefined && (await exists(header.cwd)))
        repository = await repositoryAt(header.cwd);
      else if (repository === undefined) {
        // The folder is gone; a record written after the session's first entries still counts.
        session = await readSessionFileAsync(path);
        repository = session && recordedRepository(session.branch, header.cwd);
      }
      signal?.throwIfAborted();
      if (repository !== ownRepository) continue;
    }
    session ??= await readSessionFileAsync(path);
    if (session) yield { ...session, agent: agentOf(session), current: false };
  }
}

/** Another session Pi keeps, found by its ID, read as its latest branch. */
export async function sessionById(
  manager: ReadonlySessionManager,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ScopedSession | undefined> {
  const files = await allSessionFiles(manager, signal);
  // Pi names a session file after its ID, so try those files first.
  const named = (path: string) => basename(path).includes(sessionId);
  for (const path of [...files.filter(named), ...files.filter((path) => !named(path))]) {
    signal?.throwIfAborted();
    if (readHeaderId(await readHeadEntries(path)) !== sessionId) continue;
    const session = await readSessionFileAsync(path);
    return session && { ...session, agent: agentOf(session), current: false };
  }
  return undefined;
}

function readHeaderId(entries: readonly FileEntry[]): string | undefined {
  const header = entries[0];
  return header?.type === "session" ? header.id : undefined;
}

/**
 * The calling session, then its ancestors nearest first, then its descendants newest first.
 * Every agent in one tree keeps its session in the root agent's session folder.
 */
export function lineageSessions(
  manager: ReadonlySessionManager,
  signal?: AbortSignal,
): ScopedSession[] {
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
  for (const path of sessionFiles(dir)) {
    signal?.throwIfAborted();
    if (path === ownFile) continue;
    const head = readHead(path);
    const id = headerId(head);
    if (id === undefined || id === ownId) continue;
    if (id === rootSessionId) root = readSessionFile(path);
    else if (head.includes(`"customType":"${AGENT_LINEAGE_ENTRY_TYPE}"`)) {
      const session = readSessionFile(path);
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
