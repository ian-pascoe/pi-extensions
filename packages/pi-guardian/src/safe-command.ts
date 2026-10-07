/**
 * Safe Command recognition for `bash`. Deliberately conservative: anything this module cannot
 * read as one simple command of literal words is not a Safe Command and goes to the Guardian.
 */

/**
 * Characters that make a command more than one simple command of literal words: pipes,
 * redirection, chaining, background jobs, subshells, grouping, command/process substitution,
 * variable/arithmetic/brace/history expansion, globbing, comments, and escapes.
 */
const shellSyntax = /[|&;<>()$`\\*?[\]{}!#^]/;
/** Tilde expansion: `~` starting a word or following `=` or `:` (`HEAD~1` stays literal). */
const tildeExpansion = /(?:^|[\s=:])~/;
// oxlint-disable-next-line no-control-regex -- Control characters (including newlines) are exactly what this rejects.
const controlCharacters = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/;

/** Split a command into literal words; `undefined` when it is not one simple command. */
export function literalWords(command: string): string[] | undefined {
  if (controlCharacters.test(command) || shellSyntax.test(command) || tildeExpansion.test(command))
    return undefined;
  const words: string[] = [];
  let word: string | undefined;
  let quote: "'" | '"' | undefined;
  for (const character of command) {
    if (quote) {
      if (character === quote) quote = undefined;
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
    word = (word ?? "") + character;
  }
  if (quote) return undefined;
  if (word !== undefined) words.push(word);
  return words.length ? words : undefined;
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

/**
 * Whether `command` is a Safe Command: one simple command of literal words whose program is a
 * built-in safe program with side-effect-free arguments, or whose leading words match one of the
 * configured `safeCommands` prefixes (for example `npm test`).
 */
export function isSafeCommand(command: string, configured: readonly string[] = []): boolean {
  const words = literalWords(command);
  const program = words?.[0];
  if (!words || program === undefined) return false;
  // An environment assignment (`PAGER=x git log`) or a path (`./ls`) is not a known program.
  if (program.includes("=") || program.includes("/") || program === "") return false;
  for (const entry of configured) {
    const prefix = literalWords(entry);
    if (prefix?.length && prefix.every((word, index) => words[index] === word)) return true;
  }
  const check = builtInPrograms.get(program);
  return check ? check(words.slice(1)) : false;
}
