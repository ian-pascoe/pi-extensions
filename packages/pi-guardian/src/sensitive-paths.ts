import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Where Sensitive Paths are judged from. */
export interface SensitivePathContext {
  /** Workspace root: the Guarded Agent's working directory. */
  cwd: string;
  /** Pi configuration and session locations, sensitive wherever they are. */
  piDirectories: readonly string[];
}

// Pi's own path normalization replaces these with ordinary spaces before resolving.
const unicodeSpaces = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Resolve a tool path argument the way Pi's file tools do, without touching the file system. */
export function resolveToolPath(input: string, cwd: string): string {
  let normalized = input.replace(unicodeSpaces, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  else if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

/**
 * Resolve symlinks in the longest existing ancestor; the missing remainder stays lexical. A
 * dangling symlink is followed to its target, so a link to a missing `.git` still counts.
 */
function realPath(path: string, depth = 0): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.toReversed());
    } catch {
      // Not resolvable as a whole; try a dangling link, then the parent.
    }
    try {
      if (depth < 32 && lstatSync(current).isSymbolicLink()) {
        const target = resolve(dirname(current), readlinkSync(current));
        return realPath(join(target, ...missing.toReversed()), depth + 1);
      }
    } catch {
      // Missing component: keep walking up.
    }
    const parent = dirname(current);
    if (parent === current) return path;
    missing.push(basename(current));
    current = parent;
  }
}

/** `path`'s components below `root`, or `undefined` when it lies outside it. */
function within(path: string, root: string): string[] | undefined {
  const relation = relative(root, path);
  if (relation === "") return [];
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation))
    return undefined;
  return relation.split(sep);
}

/** Version-control, secret, and Pi configuration components inside the workspace. */
function sensitiveComponent(components: readonly string[]): string | undefined {
  for (const component of components) {
    const name = component.toLowerCase();
    if (name === ".git") return "version-control metadata (.git)";
    if (name === ".pi") return "Pi configuration (.pi)";
    if (name.startsWith(".env")) return `a secret or environment file (${component})`;
  }
  return undefined;
}

/** Why `path` is sensitive; the workspace root and Pi directories are given in every spelling. */
function judge(
  path: string,
  roots: readonly string[],
  piDirectories: readonly string[],
): string | undefined {
  if (piDirectories.some((directory) => within(path, directory)))
    return "Pi's agent configuration or session files";
  const components = roots.map((root) => within(path, root)).find((found) => found !== undefined);
  if (!components) return "outside the workspace root";
  return sensitiveComponent(components);
}

/**
 * Why modifying `input` is sensitive, or `undefined` for an ordinary workspace path. Judged on
 * both the lexical path and the path with symlinks resolved; either being sensitive is enough.
 */
export function sensitivePathReason(
  input: string,
  context: SensitivePathContext,
): string | undefined {
  const lexical = resolveToolPath(input, context.cwd);
  const spellings = (path: string) => [...new Set([resolve(path), realPath(resolve(path))])];
  const roots = spellings(context.cwd);
  const piDirectories = context.piDirectories.flatMap(spellings);
  return spellings(lexical)
    .map((path) => judge(path, roots, piDirectories))
    .find((reason) => reason !== undefined);
}
