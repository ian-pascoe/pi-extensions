import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LspSynchronizedDocument } from "./lsp-server-client.js";
import type {
  LspLoadedDocuments,
  LspManagedServerClient,
  LspServerManager,
  LspWorkspaceScope,
} from "./lsp-server-manager.js";

/**
 * Most unloaded packages one references or rename request opens a file in. A language server
 * loads a package's project when a file there is opened, so the cap bounds the memory and
 * start-up work one query can cause; packages beyond it are still named in the result's warning.
 */
const LSP_WARM_UP_PACKAGE_LIMIT = 20;

/**
 * Longest one request spends choosing files and sending their open notifications before it
 * queries. A server loads the opened files' projects during the request that follows, under its
 * own request timeout.
 */
const LSP_WARM_UP_TIMEOUT_MS = 10_000;

/** Most directories searched in one package for its warm-up file. */
const WARM_UP_DIRECTORY_LIMIT = 64;

/** Directories that hold generated or third-party files, never a package's own sources. */
const SKIPPED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
]);

/** A file other than a package's own source, which its project may not include. */
const NON_SOURCE_FILE = /\.(?:d|test|spec|bench|config|setup|stories)\.[^.]+$/u;

/** The bounds of one request's automatic warm-up. */
export interface LspWarmUpLimits {
  /** Most packages a file is opened in. */
  readonly packageLimit: number;
  /** Longest time spent before the request is sent, in milliseconds. */
  readonly timeoutMs: number;
}

/** Default warm-up bounds. */
export const LSP_WARM_UP_LIMITS: LspWarmUpLimits = {
  packageLimit: LSP_WARM_UP_PACKAGE_LIMIT,
  timeoutMs: LSP_WARM_UP_TIMEOUT_MS,
};

/** A file to open so a language server loads the package holding it. */
interface LspWarmUpFile {
  readonly filePath: string;
  readonly languageId: string;
}

/**
 * Choose the file to open for one package: the shallowest source file the Server Definition
 * handles, searching `src` first, then the package root, breadth first, and skipping hidden,
 * generated, and `node_modules` directories. Declaration, test, and configuration files are chosen
 * only when nothing else is found, because a package's project often excludes them. Returns
 * undefined when no handled file is found within the search limit.
 */
async function findLspWarmUpFile(
  packageRoot: string,
  languageIdForFile: (filePath: string) => string | undefined,
): Promise<LspWarmUpFile | undefined> {
  let fallback: LspWarmUpFile | undefined;
  const queue = [join(packageRoot, "src"), packageRoot];
  const seen = new Set(queue);
  for (let index = 0; index < queue.length && index < WARM_UP_DIRECTORY_LIMIT; index++) {
    const directory = queue[index];
    if (directory === undefined) break;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const skipped = entry.name.startsWith(".") || SKIPPED_DIRECTORY_NAMES.has(entry.name);
        if (!skipped && !seen.has(path)) {
          seen.add(path);
          queue.push(path);
        }
        continue;
      }
      const languageId = entry.isFile() ? languageIdForFile(path) : undefined;
      if (languageId === undefined) continue;
      if (!NON_SOURCE_FILE.test(entry.name)) return { filePath: path, languageId };
      fallback ??= { filePath: path, languageId };
    }
  }
  return fallback;
}

/** The part of a language-server client that warm-up uses. */
export interface LspWarmUpClient extends LspManagedServerClient {
  /** Open or update one UTF-8 document. */
  synchronizeDocument(filePath: string, languageId: string): Promise<LspSynchronizedDocument>;
  /** Absolute paths of the documents tracked as synchronized. */
  synchronizedDocumentPaths(): readonly string[];
}

/** Resolve with the promise's value, or undefined once the deadline passes. */
async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open one representative file in each package of a workspace root where the Server Instance has
 * synchronized no document, so a references or rename request that follows searches them. A
 * language server loads a package's project only when a file there is opened, and the packages are
 * the ones `findWorkspaceScope` reports unloaded. Warm-up opens at most `limits.packageLimit`
 * files and stops at `limits.timeoutMs`; packages it did not reach, or that hold no handled file,
 * stay unloaded and are still named in the request's warning. It never fails the request: a
 * package it cannot open is skipped, and a cancelled `signal` ends it quietly, because the request
 * that follows reports the cancellation. Work that outlives the deadline is not cancelled, but no
 * file is opened once the deadline has passed.
 */
export async function warmUpUnloadedPackages<TClient extends LspWarmUpClient>(input: {
  readonly manager: LspServerManager<TClient>;
  readonly client: TClient;
  readonly serverId: string;
  readonly rootPath: string;
  /** The documents that count as loaded, beginning with the file the request is for. */
  readonly loaded: LspLoadedDocuments<TClient>;
  readonly limits: LspWarmUpLimits;
  readonly signal: AbortSignal | undefined;
}): Promise<void> {
  const { manager, client, serverId, loaded, limits, signal } = input;
  const deadline = Date.now() + limits.timeoutMs;
  let scope: LspWorkspaceScope | undefined;
  try {
    // Only a workspace root has packages to load; skip the directory walk elsewhere.
    if (!(await manager.isWorkspaceRoot(serverId, input.rootPath))) return;
    scope = await beforeDeadline(
      manager.findWorkspaceScope(serverId, input.rootPath, loaded),
      deadline,
    );
  } catch {
    return;
  }
  const packageRoots = scope?.unloadedPackages?.packageRoots ?? [];
  for (const packageRoot of packageRoots.slice(0, limits.packageLimit)) {
    if (signal?.aborted === true || Date.now() >= deadline) return;
    try {
      const completed = await beforeDeadline(
        (async () => {
          const file = await findLspWarmUpFile(packageRoot, (filePath) =>
            manager.languageIdForFile(serverId, filePath),
          );
          if (file !== undefined && Date.now() < deadline) {
            await client.synchronizeDocument(file.filePath, file.languageId);
          }
          return true;
        })(),
        deadline,
      );
      if (completed === undefined) return;
    } catch {
      // A package that cannot be opened stays unloaded and is named in the request's warning.
    }
  }
}
