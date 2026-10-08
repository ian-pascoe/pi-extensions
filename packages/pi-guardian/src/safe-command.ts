/**
 * Safe Command recognition and Command Rules for `bash`. Deliberately conservative: anything this
 * module cannot read as simple commands of literal words joined by `|`, `&&`, `||`, or `;` is not
 * a Safe Command and goes to the Guardian.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve, win32 } from "node:path";
import type { PolicyEntries, ToolPolicy } from "./guardian-settings.js";
import {
  commandStarts,
  commandWords,
  looseCommands,
  safeRedirect,
  splitSegments,
  type Segments,
} from "./shell-syntax.js";
import {
  resolveToolPath,
  sensitivePathReason,
  type SensitivePathContext,
} from "./sensitive-paths.js";

/**
 * Characters that make a command more than one simple command of literal words when unquoted:
 * pipes, redirection, chaining, background jobs, subshells, grouping, command/process
 * substitution, variable/arithmetic/brace/history expansion, globbing, comments, and escapes.
 */
const shellSyntax = /[|&;<>()$`\\*?[\]{}!#^]/;
/**
 * Characters the shell still interprets inside double quotes: expansions, command substitution,
 * escapes, and history expansion. Inside single quotes nothing is special.
 */
const doubleQuoteSyntax = /[$`\\!]/;
/** Where an unquoted `~` is tilde expansion: starting a word or following `=` or `:`. */
const tildePrefix = /[\s=:]/;
/** Tilde expansion anywhere, quoted or not: `~` starting a word or following `=` or `:`. */
const tildeExpansion = /(?:^|[\s=:])~/;
// oxlint-disable-next-line no-control-regex -- Control characters (including newlines) are exactly what this rejects.
const controlCharacters = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Split a command into literal words, reading quotes as bash and `sh` do: no unquoted shell
 * syntax, and no `$`, backtick, `\`, or `!` inside double quotes; `undefined` when it is not one
 * simple command. With `redirects`, the two stderr redirections {@link safeRedirect} names, which
 * sit as words of their own, are dropped; any other redirection, or one glued to a word or
 * quoted, is not literal words. Without `posixQuotes` the shell is not known to quote like bash
 * (fish and PowerShell end a quote early on some characters), so shell syntax is rejected even
 * inside quotes, and no redirect is accepted.
 */
function lexWords(command: string, redirects: boolean, posixQuotes = true): string[] | undefined {
  if (controlCharacters.test(command)) return undefined;
  if (!posixQuotes && (shellSyntax.test(command) || tildeExpansion.test(command))) return undefined;
  const words: string[] = [];
  let word: string | undefined;
  let quote: "'" | '"' | undefined;
  // Every structural character is ASCII, so UTF-16 indexes are safe here.
  for (let index = 0; index < command.length; index++) {
    const character = command[index] ?? "";
    if (quote) {
      if (character === quote) quote = undefined;
      else if (quote === '"' && doubleQuoteSyntax.test(character)) return undefined;
      else word = (word ?? "") + character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      word ??= "";
      continue;
    }
    if (character === " " || character === "\t") {
      if (word !== undefined) words.push(word);
      word = undefined;
      continue;
    }
    if (redirects && word === undefined) {
      const redirect = safeRedirect.exec(command.slice(index));
      if (redirect) {
        index += redirect[0].length - 1;
        continue;
      }
    }
    if (shellSyntax.test(character)) return undefined;
    if (character === "~" && (index === 0 || tildePrefix.test(command[index - 1] ?? "")))
      return undefined;
    word = (word ?? "") + character;
  }
  if (quote) return undefined;
  if (word !== undefined) words.push(word);
  return words.length ? words : undefined;
}

/** Split a command into literal words; `undefined` when it is not one simple command. */
export function literalWords(command: string): string[] | undefined {
  return lexWords(command, false);
}

/**
 * A Safe Command segment's words: {@link literalWords}, with `2>/dev/null` and `2>&1` dropped
 * wherever they stand as words of their own, when the shell quotes like bash (see
 * {@link posixQuoting}); else words without any shell syntax, quoted or not.
 */
function segmentWords(segment: string, environment: ShellEnvironment): string[] | undefined {
  const posix = posixQuoting(environment);
  return lexWords(segment, posix, posix);
}

/** Validates a built-in safe program's arguments; `true` when they cannot cause side effects. */
type ArgumentCheck = (args: readonly string[]) => boolean;

const anyArguments: ArgumentCheck = () => true;
const rejectOptions =
  (...forbidden: string[]): ArgumentCheck =>
  (args) =>
    !args.some((arg) => forbidden.some((option) => arg === option || arg.startsWith(`${option}=`)));

/** `find` actions that execute programs, delete files, or write output files. */
const findActions = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

/** `git log`, `diff` and `show` options that write files or run configured external programs. */
const gitOutputOptions = rejectOptions("--output", "--ext-diff", "--textconv");
/** `git branch` options that only list branches; any other word could create or delete one. */
const gitBranchListing = new Set([
  "-a",
  "-r",
  "-v",
  "-vv",
  "-l",
  "--list",
  "--all",
  "--remotes",
  "--verbose",
  "--show-current",
  "--no-color",
  "--color",
]);
const gitSubcommands = new Map<string, ArgumentCheck>([
  ["status", anyArguments],
  ["log", gitOutputOptions],
  ["diff", gitOutputOptions],
  ["show", gitOutputOptions],
  ["branch", (args) => args.every((arg) => gitBranchListing.has(arg))],
  ["rev-parse", anyArguments],
]);

/** A `sed` line address: a line number, the last line, or a regular expression without escapes. */
const sedAddress = String.raw`(?:\d+|\$|/[^/\\\n\r]+/)`;
/** A `sed` script that only prints: an address or range, then `p`, and nothing else. */
const sedPrintScript = new RegExp(String.raw`^${sedAddress}(?:,${sedAddress})?p$`);

/**
 * `sed -n '<address>p' file…` only prints lines. Any other option, even after the files (`-i`,
 * `-f`, `-s`), script (`w`, `e`, `r`, `s///e`, a second command), or `-e` is not accepted.
 */
const sedPrintOnly: ArgumentCheck = ([flag, script, ...files]) =>
  flag === "-n" &&
  script !== undefined &&
  sedPrintScript.test(script) &&
  !files.some((file) => file.startsWith("-"));

/** Built-in safe programs and their argument checks. */
const builtInPrograms = new Map<string, ArgumentCheck>([
  ["ls", anyArguments],
  ["pwd", anyArguments],
  ["cat", anyArguments],
  ["head", anyArguments],
  ["tail", anyArguments],
  ["wc", anyArguments],
  ["echo", anyArguments],
  ["stat", anyArguments],
  ["du", anyArguments],
  ["df", anyArguments],
  ["basename", anyArguments],
  ["dirname", anyArguments],
  ["realpath", anyArguments],
  ["which", anyArguments],
  ["whoami", anyArguments],
  ["uname", anyArguments],
  ["grep", anyArguments],
  ["sed", sedPrintOnly],
  // `--pre` and `--hostname-bin` run arbitrary programs.
  ["rg", rejectOptions("--pre", "--pre-glob", "--hostname-bin")],
  ["find", (args) => !args.some((arg) => findActions.has(arg))],
  // Global options such as `-c core.pager=…` or `-C dir` must not precede the subcommand.
  [
    "git",
    ([subcommand, ...args]) => {
      const check = subcommand === undefined ? undefined : gitSubcommands.get(subcommand);
      return check ? check(args) : false;
    },
  ],
]);

/** The built-in safe program names, for documentation and status. */
export const builtInSafePrograms: readonly string[] = [...builtInPrograms.keys()];

/** Operators that may join the segments of a Safe Command. */
const safeOperators = new Set(["|", "&&", "||", ";"]);

/** A Command Rule that matched a segment. */
export interface MatchedCommandRule {
  /** The rule's prefix as configured. */
  prefix: string;
  policy: ToolPolicy;
}

/**
 * The Command Rule with the longest prefix that `words` start with. With `foldCase`, the program
 * name matches in any case, as on case-insensitive file systems.
 */
function matchRule(
  words: readonly string[],
  rules: Readonly<PolicyEntries>,
  foldCase = false,
): MatchedCommandRule | undefined {
  let best: { rule: MatchedCommandRule; length: number } | undefined;
  const same = (left: string, right: string, index: number) =>
    left === right || (foldCase && index === 0 && left.toLowerCase() === right.toLowerCase());
  for (const [prefix, policy] of Object.entries(rules)) {
    const prefixWords = literalWords(prefix);
    if (!prefixWords?.length || prefixWords.length > words.length) continue;
    if (!prefixWords.every((word, index) => same(words[index] ?? "", word, index))) continue;
    if (!best || prefixWords.length > best.length)
      best = { rule: { prefix, policy }, length: prefixWords.length };
  }
  return best?.rule;
}

/** What the shell running a `bash` command inherits, for judging Safe Commands. */
export interface ShellEnvironment {
  /** The environment variables the command runs with. */
  env: NodeJS.ProcessEnv;
  /** Pi's `shellPath` setting; unset, Pi runs bash, or `sh` where there is none. */
  shellPath?: string | undefined;
  /** Pi's `shellCommandPrefix` setting, run before every command. */
  commandPrefix?: string | undefined;
}

/** The environment of this process, which Pi's `bash` tool passes on, without Pi's settings. */
export function processShellEnvironment(): ShellEnvironment {
  return { env: process.env };
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/**
 * Git variables that point git at another repository, index, object store, configuration, or
 * helper programs, or inject configuration: while any is set, `git` is not a built-in Safe
 * Command, since what it reads and runs no longer follows from the workspace.
 */
const gitRedirections = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
];

/**
 * Whether `PATH` has an empty or relative entry, which the shell resolves against its working
 * directory: a bare program name could then run a file the agent wrote, unreviewed.
 */
function relativePath(env: NodeJS.ProcessEnv): boolean {
  const path = env["PATH"];
  return path !== undefined && path.split(delimiter).some((entry) => !isAbsolute(entry));
}

/** Whether bash would run an exported shell function (`BASH_FUNC_name%%`) for `program`. */
function exportedFunction(program: string, env: NodeJS.ProcessEnv): boolean {
  return isSet(env[`BASH_FUNC_${program}%%`]) || isSet(env[`BASH_FUNC_${program}()`]);
}

/** Shells whose `cd` and quoting Guardian models: bash, and `sh` where Pi finds no bash. */
const modeledShells = new Set(["bash", "sh"]);

/** Whether Pi runs bash or `sh` (`shellPath` unset, or one of them), whatever its options. */
function modeledShell({ shellPath }: ShellEnvironment): boolean {
  return (
    shellPath === undefined ||
    // `win32.basename` splits at both `/` and `\`, for a Windows `shellPath` too.
    modeledShells.has(
      win32
        .basename(shellPath)
        .replace(/\.exe$/i, "")
        .toLowerCase(),
    )
  );
}

/**
 * Whether `-c` commands are quoted as bash and `sh` quote them, so quoted shell syntax is text.
 * Other shells differ: PowerShell reads curly quotes as quotes, and fish allows `\'` inside
 * single quotes.
 */
function posixQuoting(environment: ShellEnvironment): boolean {
  return modeledShell(environment);
}

/**
 * Whether the shell's `cd` behaves as {@link cdTarget} models it: Pi runs bash or `sh` with no
 * command prefix; no startup file is sourced (`BASH_ENV`, `ENV`) and no exported function or
 * shell option (`BASH_FUNC_*`, `BASHOPTS`, `SHELLOPTS`) could redefine `cd` or `CDPATH`; and no
 * `GIT_*` variable holds anything but an absolute path, since a relative one such as
 * `GIT_DIR=.payload` is resolved against the directory `cd` enters. (Git sets an absolute
 * `GIT_EXEC_PATH` for its hooks, which changes nothing.)
 */
function cdModeled(environment: ShellEnvironment): boolean {
  const { env, commandPrefix } = environment;
  if (commandPrefix?.trim()) return false;
  if (!modeledShell(environment)) return false;
  if (["BASH_ENV", "ENV", "BASHOPTS", "SHELLOPTS"].some((name) => isSet(env[name]))) return false;
  return !Object.entries(env).some(
    ([name, value]) =>
      (name.startsWith("GIT_") && isSet(value) && !isAbsolute(value ?? "")) ||
      (name.startsWith("BASH_FUNC_") && isSet(value)),
  );
}

/** Whether one segment is a Safe Command, given the Command Rule it matched, if any. */
function safeSegment(
  segment: string,
  rule: MatchedCommandRule | undefined,
  environment: ShellEnvironment,
  /** An earlier `cd` left the directory unknown: built-in `git` may read another repository. */
  directoryUnknown: boolean,
): boolean {
  const words = segmentWords(segment, environment);
  const program = words?.[0];
  if (!words || program === undefined) return false;
  // An environment assignment (`PAGER=x git log`) or a path (`./ls`) is not a known program.
  if (program.includes("=") || program.includes("/") || program === "") return false;
  if (exportedFunction(program, environment.env)) return false;
  // An `allow` Command Rule is the user's choice, even for `git` in an unknown directory.
  if (rule?.policy === "allow") return true;
  if (
    program === "git" &&
    (directoryUnknown || gitRedirections.some((name) => isSet(environment.env[name])))
  )
    return false;
  const check = builtInPrograms.get(program);
  return check ? check(words.slice(1)) : false;
}

/**
 * Whether a directory from `directory` up to, but not including, the workspace root holds a git
 * repository of its own: a `.git` entry, or a `HEAD` file that could make it a bare repository.
 * Git run there would read that repository's configuration, whose `core.fsmonitor` or
 * `core.pager` runs programs, and an ordinary workspace edit can write one outside any `.git`.
 */
function nestedRepository(directory: string, root: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
  } catch {
    return true;
  }
  for (let current = directory; current !== realRoot; current = dirname(current)) {
    if (dirname(current) === current) return true;
    try {
      const names = readdirSync(current).map((name) => name.toLowerCase());
      if (names.includes(".git") || names.includes("head")) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Where `cd` with `args` goes from `from`, when that is provably harmless, else `undefined`: one
 * literal operand (no options, `-`, or empty name), not looked up through `CDPATH`, naming an
 * existing directory that the shell reaches alike by its logical path (`..` removed lexically,
 * bash's default) and its physical one (`..` after symlinks, `cd -P` or bash's fallback), which
 * lies inside the workspace, is no Sensitive Path, and holds no nested git repository.
 */
function cdTarget(
  args: readonly string[],
  from: string,
  where: SensitivePathContext,
  environment: ShellEnvironment,
): string | undefined {
  const [target] = args;
  if (args.length !== 1 || !target || target.startsWith("-")) return undefined;
  if ((where.platform ?? process.platform) === "win32") return undefined;
  if (!cdModeled(environment)) return undefined;
  if (isSet(environment.env["CDPATH"]) && !isAbsolute(target)) return undefined;
  const logical = resolve(from, target);
  // Sensitive Paths are judged as Pi's file tools resolve paths, which rewrites some spellings.
  if (resolveToolPath(logical, where.cwd) !== logical) return undefined;
  let physical: string;
  try {
    physical = realpathSync.native(isAbsolute(target) ? target : `${from}/${target}`);
    if (realpathSync.native(logical) !== physical || !statSync(physical).isDirectory())
      return undefined;
  } catch {
    return undefined;
  }
  if (sensitivePathReason(logical, where) || nestedRepository(physical, where.cwd))
    return undefined;
  return logical;
}

/**
 * Whether every segment is a Safe Command. A `cd` segment is one when {@link cdTarget} proves its
 * target harmless from every directory the shell may be in: the working directory at first, then
 * also each earlier `cd` target, since a `cd` may fail and leave the directory as it was, whatever
 * the operator. A `cd` in a pipeline runs in a subshell in bash but changes the directory in zsh,
 * so it is not a Safe Command segment. A directory change only an `allow` Command Rule permits
 * (`cd`, `pushd`, `popd`, or a builtin that runs shell code) leaves the directory unknown: no
 * later `cd` is then a Safe Command segment, and neither is a built-in `git`, which could read
 * another repository's configuration there. Without `where`, no `cd` is a Safe Command segment.
 * While `PATH` has a relative entry, no segment is.
 */
function safeSegments(
  { segments, operators }: Segments,
  matched: readonly (MatchedCommandRule | undefined)[],
  where: SensitivePathContext | undefined,
  environment: ShellEnvironment,
): boolean {
  if (relativePath(environment.env)) return false;
  let directories = where ? [where.cwd] : [];
  let directoryUnknown = false;
  for (const [index, segment] of segments.entries()) {
    const words = segmentWords(segment, environment);
    if (words?.[0] === "cd") {
      const piped = operators[index - 1] === "|" || operators[index] === "|";
      const targets =
        where && !piped && !directoryUnknown
          ? directories.map((from) => cdTarget(words.slice(1), from, where, environment))
          : [];
      if (targets.length && targets.every((target) => target !== undefined)) {
        directories = [...new Set([...directories, ...targets])];
        continue;
      }
    }
    if (!safeSegment(segment, matched[index], environment, directoryUnknown)) return false;
    if (directoryChanges.has(words?.[0] ?? "")) {
      directories = [];
      directoryUnknown = true;
    }
  }
  return true;
}

/** Builtins that change the directory, or run shell code that may; see {@link safeSegments}. */
const directoryChanges = new Set(["cd", "pushd", "popd", "source", ".", "eval"]);

/** How a `bash` command is treated: run, sent to the Guardian, or blocked by a Command Rule. */
export type CommandJudgment =
  | { verdict: "allow" }
  | { verdict: "review"; rule: MatchedCommandRule | undefined }
  | { verdict: "deny"; rule: MatchedCommandRule };

/** Platforms whose usual file systems find a program in any case, so `RM` runs `rm`. */
const caseInsensitivePlatforms: readonly NodeJS.Platform[] = ["darwin", "win32"];

/**
 * Judge a `bash` command against the Command Rules. Every segment between control operators is
 * matched against the rules by its words, the longest matching prefix winning: any `deny`
 * segment denies the command, else any `review` segment reviews it. For `deny` and `review`, a
 * rule may also match after leading wrappers such as `time`, `env`, `sudo`, or `then`, and the
 * program name matches in any case on macOS and Windows; and when the command holds syntax the
 * splitter may misread, such as a here-document, comment, or `$'…'` string, `deny` rules are
 * also matched against a quote-agnostic split, which may deny commands the shell never runs.
 * Otherwise the command is a Safe Command, and runs, only when its segments are joined by `|`,
 * `&&`, `||`, or `;` and each is literal words whose program is a built-in safe program or
 * matches an `allow` rule, or is a `cd` into the workspace judged from `where`, whose `cwd` the
 * command starts in. `environment` is what the shell inherits: some variables and settings keep
 * `cd`, `git`, or every program from being safe.
 */
export function judgeCommand(
  command: string,
  rules: Readonly<PolicyEntries> = {},
  where?: SensitivePathContext,
  environment: ShellEnvironment = processShellEnvironment(),
): CommandJudgment {
  const split = splitSegments(command);
  const { segments, operators } = split;
  const foldCase = caseInsensitivePlatforms.includes(where?.platform ?? process.platform);
  const words = segments.map(commandWords);
  // Every place a command may start, for `deny` and `review`; `allow` matches only the first word.
  const candidates = [...words, ...looseCommands(command, split)].flatMap((candidate, index) =>
    commandStarts(candidate, foldCase).flatMap((start) => {
      const rule = matchRule(candidate.slice(start), rules, foldCase);
      // A quote-agnostic reading only ever denies.
      return rule && (index < words.length || rule.policy === "deny") ? [rule] : [];
    }),
  );
  const denied = candidates.find((rule) => rule.policy === "deny");
  if (denied) return { verdict: "deny", rule: denied };
  const reviewed = candidates.find((rule) => rule.policy === "review");
  if (reviewed) return { verdict: "review", rule: reviewed };
  const matched = words.map((segmentWords) => matchRule(segmentWords, rules));
  const safe =
    operators.every((operator) => safeOperators.has(operator)) &&
    safeSegments(split, matched, where, environment);
  return safe ? { verdict: "allow" } : { verdict: "review", rule: undefined };
}

/** Whether `command` is a Safe Command under the given Command Rules, judging `cd` from `where`. */
export function isSafeCommand(
  command: string,
  rules: Readonly<PolicyEntries> = {},
  where?: SensitivePathContext,
  environment: ShellEnvironment = processShellEnvironment(),
): boolean {
  return judgeCommand(command, rules, where, environment).verdict === "allow";
}
