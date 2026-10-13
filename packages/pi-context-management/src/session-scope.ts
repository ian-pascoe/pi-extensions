import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { access, open, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
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

export const SEARCH_SCOPES = ["branch", "lineage", "repository", "all"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];
/** A scope that reaches beyond this session's own branch. */
export type WideScope = Exclude<SearchScope, "branch">;

/** Narrows a requested scope to one beyond the branch; an omitted scope means the branch. */
export function isWideScope(scope: SearchScope | undefined): scope is WideScope {
  return scope !== undefined && scope !== "branch";
}

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
 * A folder's repository: its main worktree folder, null when the folder is in no repository, or
 * undefined when that is unknown.
 */
type Repository = string | null | undefined;

/** The repository a session recorded for `cwd`, or undefined when it recorded none. */
function recordedRepository(entries: readonly FileEntry[], cwd: string): Repository {
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

/** Bounds the wait for git, which runs once when a session starts. */
const GIT_TIMEOUT_MS = 2_000;

/**
 * The main worktree folder of the git repository holding `cwd`, which every linked worktree
 * shares; null when git says `cwd` is in no repository; undefined when git could not answer, for
 * example because it is missing, timed out, or the folder is gone.
 */
function repositoryOf(cwd: string, signal?: AbortSignal): Promise<Repository> {
  // Git hooks export GIT_DIR and friends, which would override `-C`.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const options: ExecFileOptionsWithStringEncoding = {
    env,
    timeout: GIT_TIMEOUT_MS,
    encoding: "utf8",
  };
  if (signal) options.signal = signal;
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      options,
      (error, stdout, stderr) => {
        if (error) return resolve(stderr.includes("not a git repository") ? null : undefined);
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
 * finds the session after a worktree's folder is removed. Nothing is recorded when git cannot
 * answer, so a later start tries again. `isCurrent` reports whether the session is still the
 * runtime's current one once git answers; a replaced session is left untouched.
 */
export async function recordRepository(
  pi: { appendEntry(customType: string, data: RepositoryRecord): void },
  manager: ReadonlySessionManager,
  isCurrent: () => boolean,
): Promise<void> {
  const cwd = manager.getCwd();
  if (recordedRepository(manager.getBranch(), cwd) !== undefined) return;
  const repository = await repositoryOf(cwd);
  if (repository === undefined || !isCurrent()) return;
  if (recordedRepository(manager.getBranch(), cwd) !== undefined) return;
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

interface SessionFile {
  readonly sessionId: string;
  readonly branch: readonly SessionEntry[];
}

/** Records a session file needs to be placed in a scope sit near its start, before its conversation. */
const HEAD_BYTES = 16 * 1024;

/** The header and the first entries of a session file, or none if it is gone or unreadable. */
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
 * A session file's latest branch, parsed without SessionManager.open, which can migrate and
 * rewrite the file; undefined if it is gone, unreadable, or not a session.
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
  // The last entry is the leaf, so the branch is the session's latest.
  const manager = SessionManager.inMemory(header.cwd, undefined, entries);
  return { sessionId: header.id, branch: manager.getBranch() };
}

function headerOf(entries: readonly FileEntry[]) {
  const header = entries[0];
  return header?.type === "session" ? header : undefined;
}

/** The top-level session files of `dirs`, newest first: Pi names each after its creation time. */
async function sessionFiles(dirs: Iterable<string>, signal?: AbortSignal): Promise<string[]> {
  const files = new Set<string>();
  for (const dir of dirs) {
    signal?.throwIfAborted();
    try {
      for (const name of await readdir(dir))
        if (name.endsWith(".jsonl")) files.add(join(dir, name));
    } catch {
      // Gone, or not a directory.
    }
  }
  return [...files].sort((a, b) => basename(b).localeCompare(basename(a)));
}

/**
 * Every session file Pi keeps, newest first: the top level of each per-folder directory in Pi's
 * sessions folder, which leaves out nested stores such as advisor sessions, and this session's
 * directory when it is a custom one outside that folder.
 */
async function allSessionFiles(
  manager: ReadonlySessionManager,
  signal?: AbortSignal,
): Promise<string[]> {
  const root = join(getAgentDir(), "sessions");
  const dirs: string[] = [];
  try {
    for (const entry of await readdir(root, { withFileTypes: true }))
      if (entry.isDirectory()) dirs.push(join(root, entry.name));
  } catch {
    // No sessions folder yet.
  }
  const own = manager.getSessionDir();
  if (own && relative(root, own).startsWith("..")) dirs.push(own);
  return sessionFiles(dirs, signal);
}

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function scoped(session: SessionFile): ScopedSession {
  return {
    ...session,
    agent: readAgentLineage(session.sessionId, session.branch)?.agentId ?? "root",
    current: false,
  };
}

function currentSession(manager: ReadonlySessionManager): ScopedSession {
  const sessionId = manager.getSessionId();
  const branch = manager.getBranch();
  return {
    sessionId,
    agent: readAgentLineage(sessionId, branch)?.agentId ?? "root",
    current: true,
    branch,
  };
}

/**
 * The calling session, then every other session Pi keeps, newest first: for `repository`, only
 * those whose working folder belongs to the same git repository, through any worktree. A session
 * matches by the repository it recorded, or else by asking git about its folder; a session whose
 * folder is gone and that recorded nothing is covered only by `all`. Files are read one at a time,
 * as the caller consumes them.
 */
async function* repositoryOrAllSessions(
  manager: ReadonlySessionManager,
  scope: "repository" | "all",
  signal?: AbortSignal,
): AsyncGenerator<ScopedSession> {
  const current = currentSession(manager);
  yield current;
  const repositories = new Map<string, Promise<Repository>>();
  const repositoryAt = (cwd: string) => {
    let repository = repositories.get(cwd);
    if (!repository) {
      repository = repositoryOf(cwd, signal);
      repositories.set(cwd, repository);
    }
    return repository;
  };
  const ownCwd = manager.getCwd();
  let ownRepository: Repository;
  if (scope === "repository") {
    ownRepository = recordedRepository(current.branch, ownCwd);
    if (ownRepository === undefined) ownRepository = await repositoryAt(ownCwd);
    // Outside a repository, or when git cannot say, only this session belongs.
    if (ownRepository === undefined || ownRepository === null) return;
  }
  const seen = new Set([current.sessionId]);
  for (const path of await allSessionFiles(manager, signal)) {
    signal?.throwIfAborted();
    const head = await readHeadEntries(path);
    const header = headerOf(head);
    if (!header || seen.has(header.id)) continue;
    seen.add(header.id);
    let session: SessionFile | undefined;
    if (scope === "repository") {
      let repository = recordedRepository(head, header.cwd);
      if (repository === undefined && (await exists(header.cwd)))
        repository = await repositoryAt(header.cwd);
      else if (repository === undefined) {
        // The folder is gone; a record written after the session's first entries still counts.
        session = await readSessionFile(path);
        repository = session && recordedRepository(session.branch, header.cwd);
      }
      signal?.throwIfAborted();
      if (repository !== ownRepository) continue;
    }
    session ??= await readSessionFile(path);
    if (session) yield scoped(session);
  }
}

/**
 * The calling session, then its ancestors nearest first, then its descendants newest first.
 * Every agent in one tree keeps its session in the root agent's session folder.
 */
async function lineageSessions(
  manager: ReadonlySessionManager,
  signal?: AbortSignal,
): Promise<ScopedSession[]> {
  const current = currentSession(manager);
  const own = readAgentLineage(current.sessionId, current.branch);
  const rootSessionId = own?.rootSessionId ?? current.sessionId;
  const dir = manager.getSessionDir();
  if (!dir) return [current];

  let root: SessionFile | undefined;
  const agents = new Map<string, { lineage: AgentLineage; session: SessionFile }>();
  for (const path of await sessionFiles([dir], signal)) {
    signal?.throwIfAborted();
    const head = await readHeadEntries(path);
    const id = headerOf(head)?.id;
    if (id === undefined || id === current.sessionId) continue;
    if (id === rootSessionId) root = await readSessionFile(path);
    // A lineage record, even one a fork clone inherited, marks a session worth reading in full.
    else if (
      head.some((entry) => entry.type === "custom" && entry.customType === AGENT_LINEAGE_ENTRY_TYPE)
    ) {
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

  const ancestors: ScopedSession[] = [];
  if (own) {
    for (const agentId of chainOf(own.parentAgentId)) {
      const ancestor = agents.get(agentId);
      if (ancestor) ancestors.push({ ...ancestor.session, agent: agentId, current: false });
    }
    if (root) ancestors.push({ ...root, agent: "root", current: false });
  }
  const descendants = [...agents.values()]
    .filter(({ lineage }) => !own || chainOf(lineage.parentAgentId).includes(own.agentId))
    .map(({ lineage, session }) => ({ ...session, agent: lineage.agentId, current: false }));
  return [current, ...ancestors, ...descendants];
}

/** The sessions a scope beyond this branch covers, this session first. */
export function sessionsInScope(
  manager: ReadonlySessionManager,
  scope: WideScope,
  signal?: AbortSignal,
): AsyncIterable<ScopedSession> {
  if (scope !== "lineage") return repositoryOrAllSessions(manager, scope, signal);
  return (async function* () {
    yield* await lineageSessions(manager, signal);
  })();
}

/** Another session Pi keeps, found by its ID and read as its latest branch. */
export async function sessionById(
  manager: ReadonlySessionManager,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ScopedSession | undefined> {
  const files = await allSessionFiles(manager, signal);
  // Lineage sessions share this session's directory, which may sit outside Pi's sessions folder.
  const ownDir = manager.getSessionDir();
  if (ownDir) files.unshift(...(await sessionFiles([ownDir], signal)));
  // Pi names a session file after its ID, so try those files first.
  const named = (path: string) => basename(path).includes(sessionId);
  for (const path of [...files.filter(named), ...files.filter((path) => !named(path))]) {
    signal?.throwIfAborted();
    if (headerOf(await readHeadEntries(path))?.id !== sessionId) continue;
    const session = await readSessionFile(path);
    return session && scoped(session);
  }
  return undefined;
}
