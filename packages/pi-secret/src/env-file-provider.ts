import { execFile } from "node:child_process";
import { constants, readdirSync } from "node:fs";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import type {
  AvailableEntry,
  LocatorDescription,
  ProviderListing,
  ProviderSearch,
  SaveRequest,
  SecretProvider,
} from "./secret-provider.js";

/** An extra Env File listed in settings, with the settings scope that listed it. */
export interface ListedEnvFile {
  /** Absolute, or relative to the home directory with `~/`. */
  readonly path: string;
  /** Only a file listed in global settings may be outside the project. */
  readonly scope: "global" | "project";
}

/** The Env File Secret Provider's settings, as read at session start. */
export interface EnvFileSettings {
  readonly files: readonly ListedEnvFile[];
}

/**
 * Whether git ignores a path: `true` or `false`, or undefined outside a git repository or when
 * git cannot tell.
 */
export type GitIgnoreCheck = (path: string, signal?: AbortSignal) => Promise<boolean | undefined>;

const GIT_TIMEOUT_MS = 10_000;

/** Ask `git check-ignore` from the path's directory, so the repository holding it answers. */
export const gitIgnores: GitIgnoreCheck = (path, signal) =>
  new Promise((done) => {
    execFile(
      "git",
      ["check-ignore", "--quiet", "--", path],
      { cwd: dirname(path), signal, timeout: GIT_TIMEOUT_MS },
      (error) => {
        if (error === null) done(true);
        // Exit 1: not ignored. Anything else, such as 128 outside a repository: unknown.
        else done(error.code === 1 ? false : undefined);
      },
    );
  });

/** `.env` or `.env.*`, such as `.env.local`; not `.envrc`. */
export function isEnvFileName(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

/** Directories never searched for Env Files, nor read from without being listed. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

/** Whether a directory has an Env File at its top level, checked once at load. */
export function hasTopLevelEnvFile(directory: string): boolean {
  try {
    return readdirSync(directory, { withFileTypes: true }).some(
      (entry) => (entry.isFile() || entry.isSymbolicLink()) && isEnvFileName(entry.name),
    );
  } catch {
    return false;
  }
}

/** `~` and `~/…` → the full path under the home directory; other paths are unchanged. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith(`~${sep}`)) return join(homedir(), path.slice(2));
  return path;
}

/** `path` relative to `directory` when strictly inside it, else undefined; both absolute. */
function inside(directory: string, path: string): string | undefined {
  const relation = relative(directory, path);
  if (relation === "" || isAbsolute(relation)) return undefined;
  if (relation === ".." || relation.startsWith(`..${sep}`)) return undefined;
  return relation;
}

/** Whether a path, absolute or with `~/`, is inside the project directory, without following links. */
export function isInsideProject(projectDirectory: string, path: string): boolean {
  return inside(resolve(projectDirectory), resolve(expandHome(path))) !== undefined;
}

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

const SCHEME = "dotenv://";
const LOCATOR_HELP = "use dotenv://<path>#<KEY>, such as dotenv://.env#API_KEY";
/** Keys secret_save writes: environment-variable style, which every Env File reader accepts. */
const SAVE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Values written without quotes; anything else is quoted. */
const PLAIN_VALUE = /^[\w.\-/+=:@%,~]+$/;

/** The parts of an Env File locator: `dotenv://<path>#<KEY>`. */
interface ParsedLocator {
  readonly path: string;
  readonly key: string;
}

function formatLocator(path: string, key: string): string {
  return `${SCHEME}${path}#${key}`;
}

function parseLocator(locator: string): ParsedLocator {
  if (!locator.startsWith(SCHEME))
    throw new Error(`${JSON.stringify(locator)} is not an Env File locator: ${LOCATOR_HELP}`);
  const rest = locator.slice(SCHEME.length);
  const hash = rest.lastIndexOf("#");
  const path = rest.slice(0, Math.max(0, hash));
  const key = rest.slice(hash + 1);
  if (hash < 0 || path.trim() === "" || key.trim() === "")
    throw new Error(`${JSON.stringify(locator)} is not an Env File locator: ${LOCATOR_HELP}`);
  return { path, key };
}

/** An Env File path, resolved against the project directory. */
interface EnvFilePath {
  /** Absolute, as named: links are not followed. */
  readonly absolute: string;
  /** Relative to the project when inside it, else absolute: how a locator names it. */
  readonly shown: string;
  /** Relative to the project, when the named path is inside it. */
  readonly inProject: string | undefined;
}

/** An Env File the provider may read or save into. */
interface PermittedFile extends EnvFilePath {
  /** Where the file really is, links followed: the only path read or written. */
  readonly real: string;
  /** Whether the real path is in the project, so a link out of it counts as outside. */
  readonly inRealProject: boolean;
  readonly exists: boolean;
}

/** A checked save: where it goes, and the file's text before it. */
interface PlannedSave {
  readonly file: PermittedFile;
  readonly key: string;
  readonly existing: string;
}

/** Append, never truncate, and never through a link swapped in after the check. */
const APPEND = constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);

function notFound(file: EnvFilePath, cause: unknown): Error {
  if (isMissing(cause)) return new Error(`${file.shown} does not exist`, { cause });
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(`cannot read ${file.shown}: ${message}`, { cause });
}

/** The text of a key's new line, quoted so `util.parseEnv` reads back exactly `value`. */
function appendedLine(existing: string, key: string, value: string): string {
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  const before = parseEnv(existing);
  const candidates = PLAIN_VALUE.test(value) ? [value] : [];
  candidates.push(`'${value}'`, `"${value}"`, `\`${value}\``);
  for (const quoted of candidates) {
    const line = `${prefix}${key}=${quoted}\n`;
    const after = parseEnv(existing + line);
    const unchanged = Object.entries(before).every(([name, old]) => after[name] === old);
    const added = Object.keys(after).length === Object.keys(before).length + 1;
    if (after[key] === value && unchanged && added) return line;
  }
  throw new Error(
    "Pi Secret cannot write this value so that the Env File reads it back exactly; save it to another Secret Provider",
  );
}

export interface EnvFileProviderOptions {
  /** The session's project directory, which relative locators resolve against. */
  readonly projectDirectory: () => string;
  readonly settings: () => EnvFileSettings;
  readonly gitIgnores?: GitIgnoreCheck;
}

/**
 * The Env File Secret Provider: `.env*` files in the project, and files listed in settings,
 * read again at each use. Saving only ever adds a key (ADR-0003).
 */
export class EnvFileProvider implements SecretProvider {
  readonly id = "dotenv";
  readonly label = "Env files";
  readonly scheme = "dotenv";
  readonly locatorExample = "the Env File locator dotenv://.env#API_KEY";
  readonly saveExample = "dotenv://.env.local#NEW_KEY, for a key the file does not define yet";
  private readonly checkIgnored: GitIgnoreCheck;

  constructor(private readonly options: EnvFileProviderOptions) {
    this.checkIgnored = options.gitIgnores ?? gitIgnores;
  }

  private project(): string {
    return resolve(this.options.projectDirectory());
  }

  private path(path: string): EnvFilePath {
    const project = this.project();
    const absolute = resolve(project, expandHome(path));
    const inProject = inside(project, absolute);
    return { absolute, shown: inProject ?? absolute, inProject };
  }

  /** The vault an Env File is shown in: the project directory's name, or `outside project`. */
  private vault(file: PermittedFile): string {
    return file.inRealProject ? basename(this.project()) : "outside project";
  }

  /**
   * Check that Pi Secret may use a file, following links: a `.env*` file whose real path is in
   * the project, or a listed file. A project-listed file must really be in the project too.
   */
  private async permit(file: EnvFilePath, creating = false): Promise<PermittedFile> {
    let real: string;
    let exists = true;
    try {
      real = await realpath(file.absolute);
    } catch (cause) {
      if (!isMissing(cause) || !creating) throw notFound(file, cause);
      // A dangling link would make the write land wherever it points.
      if (
        await lstat(file.absolute).then(
          () => true,
          () => false,
        )
      )
        throw new Error(`${file.shown} is a link to a file that does not exist`);
      try {
        real = join(await realpath(dirname(file.absolute)), basename(file.absolute));
      } catch (inner) {
        throw new Error(`the directory of ${file.shown} does not exist`, { cause: inner });
      }
      exists = false;
    }
    if (exists && !(await stat(real)).isFile()) throw new Error(`${file.shown} is not a file`);
    if (!exists && !isEnvFileName(basename(file.absolute)))
      throw new Error(
        `secret_save creates only files named .env or .env.*, not ${basename(file.absolute)}`,
      );
    const realProject = await realpath(this.project()).catch(() => this.project());
    const inRealProject = file.inProject !== undefined && inside(realProject, real) !== undefined;
    const permitted: PermittedFile = { ...file, real, inRealProject, exists };
    for (const listed of this.options.settings().files) {
      const path = resolve(expandHome(listed.path));
      const listedReal = await realpath(path).catch(() => path);
      if (path !== file.absolute && listedReal !== real) continue;
      if (listed.scope === "global") return permitted;
      if (inside(this.project(), path) !== undefined && inside(realProject, real) !== undefined)
        return permitted;
    }
    const segments = file.inProject?.split(sep) ?? [];
    if (
      inRealProject &&
      isEnvFileName(basename(file.absolute)) &&
      !segments.some((segment) => SKIPPED_DIRECTORIES.has(segment))
    )
      return permitted;
    throw new Error(
      `${file.shown} is not an Env File Pi Secret may use: use a .env or .env.* file in the project, outside .git and node_modules, or list the file in global secret.providers.dotenv.files`,
    );
  }

  private async keys(
    file: PermittedFile,
    signal?: AbortSignal,
  ): Promise<Record<string, string | undefined>> {
    if (!file.exists) return {};
    return parseEnv(await readFile(file.real, { encoding: "utf8", signal }));
  }

  /** "not ignored by git" for a project Env File git does not ignore; nothing otherwise. */
  private async gitWarning(
    file: PermittedFile,
    signal?: AbortSignal,
  ): Promise<{ warning?: string }> {
    if (!file.inRealProject) return {};
    return (await this.checkIgnored(file.absolute, signal)) === false
      ? { warning: "not ignored by git" }
      : {};
  }

  async describe(locator: string, signal?: AbortSignal): Promise<LocatorDescription> {
    const { path, key } = parseLocator(locator);
    const file = await this.permit(this.path(path));
    if (!Object.hasOwn(await this.keys(file, signal), key))
      throw new Error(`${file.shown} has no key ${JSON.stringify(key)}`);
    return {
      // The full path for `~`, and relative in the project, so a grant follows the project.
      locator: formatLocator(file.shown, key),
      vault: this.vault(file),
      item: file.shown,
      field: key,
      ...(await this.gitWarning(file, signal)),
    };
  }

  /** Check a save: a new key, in a permitted file that exists or may be created. */
  private async planSave(
    request: Omit<SaveRequest, "value">,
    signal?: AbortSignal,
  ): Promise<PlannedSave> {
    if (request.category !== undefined)
      throw new Error("Env Files have no item categories; call secret_save without category");
    const { path, key } = parseLocator(request.locator);
    if (!SAVE_KEY.test(key))
      throw new Error(
        `${JSON.stringify(key)} is not a key secret_save writes: use letters, digits, and underscores, not starting with a digit`,
      );
    const file = await this.permit(this.path(path), true);
    const existing = file.exists ? await readFile(file.real, { encoding: "utf8", signal }) : "";
    if (Object.hasOwn(parseEnv(existing), key))
      throw new Error(
        `${file.shown} already defines ${key}; secret_save only adds keys, so choose another key or file`,
      );
    return { file, key, existing };
  }

  async describeSave(
    request: Omit<SaveRequest, "value">,
    signal?: AbortSignal,
  ): Promise<LocatorDescription> {
    const { file, key } = await this.planSave(request, signal);
    return {
      locator: formatLocator(file.shown, key),
      vault: this.vault(file),
      item: file.shown,
      field: key,
      fieldType: file.exists ? "new key" : "new key, new file",
      ...(await this.gitWarning(file, signal)),
    };
  }

  async read(locator: string, signal?: AbortSignal): Promise<string> {
    // Checked at every read, so a file no longer permitted stops grants already held or restored.
    const { path, key } = parseLocator(locator);
    const file = await this.permit(this.path(path));
    const keys = await this.keys(file, signal);
    const value = Object.hasOwn(keys, key) ? keys[key] : undefined;
    if (value === undefined) throw new Error(`${file.shown} has no key ${JSON.stringify(key)}`);
    if (value === "") throw new Error(`${key} in ${file.shown} is empty`);
    return value;
  }

  async save(request: SaveRequest, signal?: AbortSignal): Promise<string> {
    const { file, key, existing } = await this.planSave(request, signal);
    const line = appendedLine(existing, key, request.value);
    // Appended, never rewritten; a new file is created exclusively, readable by its owner only.
    const flags = file.exists ? APPEND : APPEND | constants.O_CREAT | constants.O_EXCL;
    const handle = await open(file.real, flags, 0o600);
    try {
      await handle.appendFile(line, "utf8");
    } finally {
      await handle.close();
    }
    return formatLocator(file.shown, key);
  }

  /** Every Env File in the project, outside skipped directories, without following links. */
  private async projectFiles(signal?: AbortSignal): Promise<string[]> {
    const found: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      signal?.throwIfAborted();
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(path);
        } else if ((entry.isFile() || entry.isSymbolicLink()) && isEnvFileName(entry.name))
          found.push(path);
      }
    };
    await visit(this.project());
    return found;
  }

  /** Every Env File Pi Secret may use: the project's, then listed ones, each once. */
  private async files(signal?: AbortSignal): Promise<PermittedFile[]> {
    const candidates = [
      ...(await this.projectFiles(signal)),
      ...this.options.settings().files.map((listed) => listed.path),
    ];
    // By real path, so a project link to a listed file is listed once, under the link.
    const files = new Map<string, PermittedFile>();
    for (const candidate of candidates) {
      let file: PermittedFile;
      try {
        file = await this.permit(this.path(candidate));
      } catch {
        // Missing, or not permitted: not listed.
        continue;
      }
      if (!files.has(file.real)) files.set(file.real, file);
    }
    return [...files.values()];
  }

  async search(search: ProviderSearch, signal?: AbortSignal): Promise<ProviderListing> {
    const query = search.query?.toLowerCase();
    const matches = (text: string) => query === undefined || text.toLowerCase().includes(query);
    const inVault = (file: PermittedFile) =>
      search.vault === undefined || this.vault(file).toLowerCase() === search.vault.toLowerCase();
    const entries: AvailableEntry[] = [];
    if (search.item !== undefined) {
      const file = await this.permit(this.path(search.item));
      if (inVault(file))
        // Values are dropped here: only key names and locators leave this method.
        for (const key of Object.keys(await this.keys(file, signal)).toSorted())
          if (matches(key))
            entries.push({
              kind: "field",
              provider: this.id,
              item: file.shown,
              vault: this.vault(file),
              label: key,
              type: "key",
              locator: formatLocator(file.shown, key),
            });
    } else {
      for (const file of await this.files(signal)) {
        if (!inVault(file)) continue;
        if (!matches(file.shown)) {
          const keys = await this.keys(file, signal).catch(() => ({}));
          if (!Object.keys(keys).some(matches)) continue;
        }
        entries.push({
          kind: "item",
          provider: this.id,
          id: file.shown,
          title: file.shown,
          vault: this.vault(file),
          category: "env file",
        });
      }
    }
    return { entries: entries.slice(0, search.limit), truncated: entries.length > search.limit };
  }
}
