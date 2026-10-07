/**
 * Safe Command recognition and Command Rules for `bash`. Deliberately conservative: anything this
 * module cannot read as simple commands of literal words joined by `|`, `&&`, `||`, or `;` is not
 * a Safe Command and goes to the Guardian.
 */
import type { PolicyEntries, ToolPolicy } from "./guardian-settings.js";

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

/** Operators that may join the segments of a Safe Command. */
const safeOperators = new Set(["|", "&&", "||", ";"]);

/** A command split at its unquoted control operators. */
interface Segments {
  segments: string[];
  /** The operators between segments, such as `|` or `&&`, and newlines as `\n`. */
  operators: string[];
}

/**
 * Split a command at unquoted control operators (`|`, `|&`, `||`, `&&`, `&`, `;`, `;;`, and
 * newlines). This only finds segment boundaries: a segment holding a substitution, subshell, or
 * other syntax may be split wrongly, but such a segment is never literal words, so it is neither
 * a Safe Command nor matched as one.
 */
function splitSegments(command: string): Segments {
  const segments: string[] = [];
  const operators: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  // Every structural character is ASCII, so UTF-16 indexes are safe here.
  const characters = command;
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index] ?? "";
    const next = characters[index + 1];
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      else if (quote === '"' && character === "\\" && next !== undefined) {
        current += next;
        index++;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "\\" && next !== undefined) {
      current += character + next;
      index++;
      continue;
    }
    let operator: string | undefined;
    if (character === "|") operator = next === "|" || next === "&" ? `|${next}` : "|";
    else if (character === "&") {
      // `>&`, `<&`, and `&>` are redirections, which keep the segment non-literal.
      const previous = characters[index - 1];
      if (next === "&") operator = "&&";
      else if (previous !== ">" && previous !== "<" && next !== ">") operator = "&";
    } else if (character === ";") operator = next === ";" ? ";;" : ";";
    else if (character === "\n" || character === "\r") operator = "\n";
    if (operator === undefined) {
      current += character;
      continue;
    }
    segments.push(current);
    operators.push(operator);
    current = "";
    index += operator.length - 1;
  }
  segments.push(current);
  return { segments, operators };
}

/** `NAME=value` words that set the environment of the command after them. */
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * A segment's words with quotes and escapes removed, after any leading environment assignments,
 * for matching Command Rules. Unlike {@link literalWords} it tolerates expansions later in the
 * segment, so `rm -rf "$HOME"` still starts with `rm`; a word holding unquoted shell syntax keeps
 * it and so never equals a rule's literal word.
 */
function leadingWords(segment: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quote: "'" | '"' | undefined;
  // Every structural character is ASCII, so UTF-16 indexes are safe here.
  const characters = segment;
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index] ?? "";
    if (quote) {
      if (character === quote) quote = undefined;
      else if (quote === '"' && character === "\\" && index + 1 < characters.length)
        word = (word ?? "") + (characters[++index] ?? "");
      else word = (word ?? "") + character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      word ??= "";
    } else if (character === "\\" && index + 1 < characters.length)
      word = (word ?? "") + (characters[++index] ?? "");
    else if (character === " " || character === "\t") {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? "") + character;
  }
  if (word !== undefined) words.push(word);
  const first = words.findIndex((candidate) => !assignment.test(candidate));
  return first < 0 ? [] : words.slice(first);
}

/** A Command Rule that matched a segment. */
export interface MatchedCommandRule {
  /** The rule's prefix as configured. */
  prefix: string;
  policy: ToolPolicy;
}

/** The Command Rule with the longest prefix that `words` start with. */
function matchRule(
  words: readonly string[],
  rules: Readonly<PolicyEntries>,
): MatchedCommandRule | undefined {
  let best: { rule: MatchedCommandRule; length: number } | undefined;
  for (const [prefix, policy] of Object.entries(rules)) {
    const prefixWords = literalWords(prefix);
    if (!prefixWords?.length || prefixWords.length > words.length) continue;
    if (!prefixWords.every((word, index) => words[index] === word)) continue;
    if (!best || prefixWords.length > best.length)
      best = { rule: { prefix, policy }, length: prefixWords.length };
  }
  return best?.rule;
}

/** Whether one segment is a Safe Command, given the Command Rule it matched, if any. */
function safeSegment(segment: string, rule: MatchedCommandRule | undefined): boolean {
  const words = literalWords(segment);
  const program = words?.[0];
  if (!words || program === undefined) return false;
  // An environment assignment (`PAGER=x git log`) or a path (`./ls`) is not a known program.
  if (program.includes("=") || program.includes("/") || program === "") return false;
  if (rule?.policy === "allow") return true;
  const check = builtInPrograms.get(program);
  return check ? check(words.slice(1)) : false;
}

/** How a `bash` command is treated: run, sent to the Guardian, or blocked by a Command Rule. */
export type CommandJudgment =
  | { verdict: "allow" }
  | { verdict: "review"; rule: MatchedCommandRule | undefined }
  | { verdict: "deny"; rule: MatchedCommandRule };

/**
 * Judge a `bash` command against the Command Rules. Every segment between control operators is
 * matched against the rules by its leading words, the longest matching prefix winning: any `deny`
 * segment denies the command, else any `review` segment reviews it. Otherwise the command is a
 * Safe Command, and runs, only when its segments are joined by `|`, `&&`, `||`, or `;` and each
 * is literal words whose program is a built-in safe program or matches an `allow` rule.
 */
export function judgeCommand(
  command: string,
  rules: Readonly<PolicyEntries> = {},
): CommandJudgment {
  const { segments, operators } = splitSegments(command);
  const matched = segments.map((segment) => matchRule(leadingWords(segment), rules));
  const denied = matched.find((rule) => rule?.policy === "deny");
  if (denied) return { verdict: "deny", rule: denied };
  const reviewed = matched.find((rule) => rule?.policy === "review");
  if (reviewed) return { verdict: "review", rule: reviewed };
  const safe =
    operators.every((operator) => safeOperators.has(operator)) &&
    segments.every((segment, index) => safeSegment(segment, matched[index]));
  return safe ? { verdict: "allow" } : { verdict: "review", rule: undefined };
}

/** Whether `command` is a Safe Command under the given Command Rules. */
export function isSafeCommand(command: string, rules: Readonly<PolicyEntries> = {}): boolean {
  return judgeCommand(command, rules).verdict === "allow";
}
