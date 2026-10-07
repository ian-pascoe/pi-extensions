import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Where Sensitive Paths are judged from. */
export interface SensitivePathContext {
  /** Workspace root: the Guarded Agent's working directory. */
  cwd: string;
  /** Pi configuration and session locations, sensitive wherever they are. */
  piDirectories: readonly string[];
  /**
   * Files and directories of resources Pi loaded into the Guarded Agent (context files, Skills,
   * prompt templates, extensions), sensitive wherever they are: they are trusted instructions
   * or code.
   */
  loadedResources?: readonly string[];
  /** The user's home directory; defaults to `os.homedir()`. */
  home?: string;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
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

/** Context files Pi loads from the working directory and its ancestors, in any case. */
const contextFileNames = new Set(["agents.md", "agents.override.md", "claude.md"]);

/**
 * Locations under the home directory where a change persists beyond the session: shell startup
 * files, credentials, user configuration, and programs on `PATH`. Judged wherever the workspace is.
 */
const homePersistence = new Set([
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config",
  ".gitconfig",
  ".git-credentials",
  ".npmrc",
  ".yarnrc",
  ".pypirc",
  ".netrc",
  ".docker",
  ".kube",
]);

/** Why a path below the home directory is a persistence or credential location. */
function homeLocation(components: readonly string[]): string | undefined {
  const [first = "", second = ""] = components.map((component) => component.toLowerCase());
  const persistent =
    homePersistence.has(first) ||
    (first === ".local" && second === "bin") ||
    (first === "library" && second === "launchagents");
  return persistent
    ? `a shell startup, credential, or persistence location in the home directory (${components.slice(0, first === ".local" || first === "library" ? 2 : 1).join("/")})`
    : undefined;
}

/**
 * Components inside the workspace whose change can weaken Guardian, expose secrets, alter
 * trusted instructions, or run code later: version control, secrets, Pi and agent
 * configuration, context files, git hooks, CI workflows, and editor tasks.
 */
function sensitiveComponent(components: readonly string[]): string | undefined {
  for (const [index, component] of components.entries()) {
    const name = component.toLowerCase();
    if (name === ".git") return "version-control metadata (.git)";
    if (name === ".pi") return "Pi configuration (.pi)";
    if (name === ".agents") return "agent Skills and configuration (.agents)";
    if (name.startsWith(".env")) return `a secret or environment file (${component})`;
    if (name === ".husky") return "git hooks (.husky)";
    if (name === ".vscode") return "editor tasks and settings (.vscode)";
    if (name === ".github" && components[index + 1]?.toLowerCase() === "workflows")
      return "CI workflows (.github/workflows)";
  }
  const last = components.at(-1)?.toLowerCase();
  if (last && contextFileNames.has(last))
    return `a context file Pi loads as instructions (${components.at(-1)})`;
  return undefined;
}

/** A path in every spelling: as given and with symlinks resolved. */
interface Spelled {
  roots: readonly string[];
  piDirectories: readonly string[];
  resources: readonly string[];
  homes: readonly string[];
}

/** Why `path` is sensitive. */
function judge(path: string, where: Spelled): string | undefined {
  if (where.piDirectories.some((directory) => within(path, directory)))
    return "Pi's agent configuration or session files";
  if (where.resources.some((resource) => within(path, resource)))
    return "a context file, Skill, prompt template, or extension Pi loaded";
  if (where.homes.some((home) => where.roots.some((root) => within(home, root))))
    return "the workspace root contains the home directory, so every file is reviewed";
  for (const home of where.homes) {
    const below = within(path, home);
    const reason = below && homeLocation(below);
    if (reason) return reason;
  }
  const components = where.roots
    .map((root) => within(path, root))
    .find((found) => found !== undefined);
  if (!components) return "outside the workspace root";
  return sensitiveComponent(components);
}

/** A file reachable through more than one hard link: editing it in place changes the others. */
function hardLinked(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.nlink > 1;
  } catch {
    return false;
  }
}

/** Windows path forms (backslashes, drive letters, UNC) that Guardian does not judge. */
const windowsPathForm = /\\|^[A-Za-z]:/;

/**
 * Why modifying `input` is sensitive, or `undefined` for an ordinary workspace path. Judged on
 * both the lexical path and the path with symlinks resolved; either being sensitive is enough.
 */
export function sensitivePathReason(
  input: string,
  context: SensitivePathContext,
): string | undefined {
  if ((context.platform ?? process.platform) === "win32" && windowsPathForm.test(input))
    return "a Windows path form Guardian does not judge";
  const lexical = resolveToolPath(input, context.cwd);
  const spellings = (path: string) => [...new Set([resolve(path), realPath(resolve(path))])];
  const where: Spelled = {
    roots: spellings(context.cwd),
    piDirectories: context.piDirectories.flatMap(spellings),
    resources: (context.loadedResources ?? []).flatMap(spellings),
    homes: spellings(context.home ?? homedir()),
  };
  const targets = spellings(lexical);
  if (targets.some(hardLinked))
    return "a file with more than one hard link, so editing it changes another path too";
  return targets.map((path) => judge(path, where)).find((reason) => reason !== undefined);
}
