/**
 * Just enough `bash` lexing to find where a command's simple commands start, for Safe Commands
 * and Command Rules. It is not a shell parser: it finds segment boundaries and leading words,
 * and its callers fail closed on anything it may misread.
 */

/** A command split at its unquoted control operators. */
export interface Segments {
  /**
   * Each segment's raw text, including any comment and here-document body, so a segment holding
   * either is never literal words.
   */
  segments: string[];
  /** The operators between segments, such as `|`, `&&`, or `(`, and newlines as `\n`. */
  operators: string[];
  /** The command ends inside a quote or a here-document. */
  unterminated: boolean;
}

/** A scanned piece of text: its value, and where the scan stopped. */
interface Scanned {
  value: string;
  end: number;
}

/** A here-document awaiting its body. */
interface Heredoc {
  delimiter: string;
  /** `<<-` strips leading tabs from the delimiter line. */
  tabs: boolean;
}

/** Characters that end an unquoted word: blanks, newlines, and operator characters. */
const wordEnd = /[\s;&|<>()`]/;

/** Whether `current`, a segment's text so far, ends where a new word starts. */
function atWordStart(current: string): boolean {
  return current === "" || /[\s<>]$/.test(current);
}

/** A here-document's delimiter word from `start`, quotes removed, and where it ends. */
function readDelimiter(text: string, start: number): Scanned {
  let word = "";
  let index = start;
  while (index < text.length) {
    const character = text[index] ?? "";
    if (character === "'" || character === '"') {
      const close = text.indexOf(character, index + 1);
      const stop = close < 0 ? text.length : close;
      word += text.slice(index + 1, stop);
      index = stop + 1;
    } else if (character === "\\" && index + 1 < text.length) {
      word += text[index + 1] ?? "";
      index += 2;
    } else if (wordEnd.test(character)) break;
    else {
      word += character;
      index++;
    }
  }
  return { value: word, end: index };
}

/**
 * The end of here-document bodies starting at `start`: after each delimiter line in turn, or
 * `undefined` when one is missing.
 */
function skipBodies(text: string, start: number, heredocs: readonly Heredoc[]): number | undefined {
  let index = start;
  for (const { delimiter, tabs } of heredocs) {
    for (;;) {
      if (index >= text.length) return undefined;
      const newline = text.indexOf("\n", index);
      const lineEnd = newline < 0 ? text.length : newline;
      const line = text.slice(index, lineEnd);
      index = newline < 0 ? text.length : newline + 1;
      if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
    }
  }
  return index;
}

/**
 * Split a command at unquoted control operators (`|`, `|&`, `||`, `&&`, `&`, `;`, `;;`,
 * newlines) and at subshell and substitution boundaries (`(`, `)`, and backticks). Quotes,
 * `$'…'` and `$"…"` strings, escapes, comments, and here-document bodies do not split; their
 * text stays in the segment. A segment holding a substitution or other syntax may be split
 * wrongly, but such a segment is never literal words, and every operator but `|`, `&&`, `||`,
 * and `;` keeps a command from being a Safe Command.
 */
export function splitSegments(command: string): Segments {
  const segments: string[] = [];
  const operators: string[] = [];
  let current = "";
  let quote: "'" | '"' | "$'" | undefined;
  let unterminated = false;
  /** Here-documents whose bodies start after the current line. */
  let heredocs: Heredoc[] = [];
  // Every structural character is ASCII, so UTF-16 indexes are safe here.
  const characters = command;
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index] ?? "";
    const next = characters[index + 1];
    if (quote) {
      current += character;
      if (quote !== "'" && character === "\\" && next !== undefined) {
        current += next;
        index++;
      } else if (character === (quote === '"' ? '"' : "'")) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "$" && (next === "'" || next === '"')) {
      quote = next === "'" ? "$'" : '"';
      current += character + next;
      index++;
      continue;
    }
    if (character === "\\" && next !== undefined) {
      current += character + next;
      index++;
      continue;
    }
    if (character === "#" && atWordStart(current)) {
      const newline = characters.indexOf("\n", index);
      const end = newline < 0 ? characters.length : newline;
      current += characters.slice(index, end);
      index = end - 1;
      continue;
    }
    if (character === "<" && next === "<") {
      if (characters[index + 2] === "<") {
        // A here-string, not a here-document.
        current += "<<<";
        index += 2;
        continue;
      }
      let cursor = index + 2;
      const tabs = characters[cursor] === "-";
      if (tabs) cursor++;
      while (characters[cursor] === " " || characters[cursor] === "\t") cursor++;
      const { value, end } = readDelimiter(characters, cursor);
      heredocs.push({ delimiter: value, tabs });
      current += characters.slice(index, end);
      index = end - 1;
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
    else if (character === "(" || character === ")" || character === "`") operator = character;
    if (operator === undefined) {
      current += character;
      continue;
    }
    if (character === "\n" && heredocs.length) {
      // The bodies follow the line that started them; they stay in that line's last segment.
      const end = skipBodies(characters, index + 1, heredocs) ?? characters.length;
      current += characters.slice(index, end);
      if (end === characters.length) unterminated = true;
      heredocs = [];
      index = end - 1;
      if (end >= characters.length) break;
      segments.push(current);
      operators.push("\n");
      current = "";
      continue;
    }
    segments.push(current);
    operators.push(operator);
    current = "";
    index += operator.length - 1;
  }
  segments.push(current);
  if (quote || heredocs.length) unterminated = true;
  return { segments, operators, unterminated };
}

/** Single-character escapes of a `$'…'` string. */
const ansiEscapes = new Map([
  ["a", "\u0007"],
  ["b", "\b"],
  ["e", "\u001b"],
  ["E", "\u001b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["\\", "\\"],
  ["'", "'"],
  ['"', '"'],
  ["?", "?"],
]);

/** Hexadecimal escapes of a `$'…'` string and the digits they take. */
const numericEscapes = new Map([
  ["x", /^[0-9A-Fa-f]{1,2}/],
  ["u", /^[0-9A-Fa-f]{1,4}/],
  ["U", /^[0-9A-Fa-f]{1,8}/],
]);

/** A `$'…'` string's value from `start` (after `$'`), and the index of its closing quote. */
function ansiString(text: string, start: number): Scanned {
  let value = "";
  let index = start;
  while (index < text.length && text[index] !== "'") {
    const character = text[index] ?? "";
    if (character !== "\\" || index + 1 >= text.length) {
      value += character;
      index++;
      continue;
    }
    const escape = text[index + 1] ?? "";
    const rest = text.slice(index + 2);
    const octal = /^[0-7]{1,3}/.exec(text.slice(index + 1));
    const digits = numericEscapes.get(escape)?.exec(rest)?.[0];
    if (digits) {
      const code = Number.parseInt(digits, 16);
      value += code <= 0x10ffff ? String.fromCodePoint(code) : "";
      index += 2 + digits.length;
    } else if (octal) {
      value += String.fromCodePoint(Number.parseInt(octal[0], 8) & 0xff);
      index += 1 + octal[0].length;
    } else if (escape === "c" && index + 2 < text.length) {
      value += String.fromCodePoint((text.codePointAt(index + 2) ?? 0) & 0x1f);
      index += 3;
    } else {
      value += ansiEscapes.get(escape) ?? `\\${escape}`;
      index += 2;
    }
  }
  return { value, end: index };
}

/** A double-quoted string's value from `start` (after `"`), and the index of its closing quote. */
function doubleQuoted(text: string, start: number): Scanned {
  let value = "";
  let index = start;
  while (index < text.length && text[index] !== '"') {
    const character = text[index] ?? "";
    const next = text[index + 1];
    if (character === "\\" && next !== undefined && '$`"\\\n'.includes(next)) {
      if (next !== "\n") value += next;
      index += 2;
    } else {
      value += character;
      index++;
    }
  }
  return { value, end: index };
}

/** `NAME=value` words that set the environment of the command after them. */
export const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * A segment's words as the shell reads them: quotes, `$'…'` escapes, and backslashes removed,
 * line continuations joined, and a comment ending the words; then any leading environment
 * assignments are dropped. Unlike {@link literalWords} it tolerates expansions, so
 * `rm -rf "$HOME"` still starts with `rm`; a word holding unquoted shell syntax keeps it and so
 * never equals a rule's literal word.
 */
export function commandWords(segment: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  // Every structural character is ASCII, so UTF-16 indexes are safe here.
  const characters = segment;
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index] ?? "";
    const next = characters[index + 1];
    if (character === "\\" && next !== undefined) {
      if (next !== "\n") word = (word ?? "") + next;
      index++;
    } else if (character === "'") {
      const close = characters.indexOf("'", index + 1);
      const end = close < 0 ? characters.length : close;
      word = (word ?? "") + characters.slice(index + 1, end);
      index = end;
    } else if (character === "$" && next === "'") {
      const { value, end } = ansiString(characters, index + 2);
      word = (word ?? "") + value;
      index = end;
    } else if (character === '"' || (character === "$" && next === '"')) {
      const { value, end } = doubleQuoted(characters, index + (character === "$" ? 2 : 1));
      word = (word ?? "") + value;
      index = end;
    } else if (character === "#" && word === undefined) break;
    else if (/\s/.test(character)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? "") + character;
  }
  if (word !== undefined) words.push(word);
  const first = words.findIndex((candidate) => !assignment.test(candidate));
  return first < 0 ? [] : words.slice(first);
}

/**
 * Syntax that a quote-tracking lexer can misread, or that hides a command inside another:
 * here-documents, `$'…'` and `$"…"` strings, line continuations, substitutions, and comments.
 */
const misreadable = /<<|\$['"(]|\\\r?\n|`|(?:^|[\s;&|()<>])#/;

/**
 * The words of every command a quote-agnostic reading could find, when the command holds
 * syntax {@link splitSegments} may misread; else none. It splits at every newline, operator, and
 * substitution boundary, ignoring quotes, and drops quote characters and backslashes, so it may
 * find commands the shell never runs: use it only to deny, never to allow.
 */
export function looseCommands(command: string, segments: Segments): string[][] {
  if (!segments.unterminated && !misreadable.test(command)) return [];
  return command
    .replaceAll(/\\\r?\n/g, "")
    .split(/[\n\r;&|()`]/)
    .flatMap((piece) => {
      const words = piece
        .replaceAll(/\$(?=['"])/g, "")
        .replaceAll(/['"\\]/g, "")
        .split(/\s+/)
        .filter(Boolean);
      const first = words.findIndex((word) => !assignment.test(word));
      return first < 0 ? [] : [words.slice(first)];
    });
}

/**
 * Words that run the command after them (with their options), or start a command in a compound
 * command: a Command Rule may match after them.
 */
const commandWrappers = new Set([
  "!",
  "{",
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
  "exec",
  "command",
  "builtin",
  "time",
  "nohup",
  "env",
  "nice",
  "sudo",
  "doas",
  "xargs",
]);

/**
 * Where a command may start in a segment's words: at the first word, and after each leading
 * wrapper such as `time`, `env`, or `then`, skipping the wrapper's options and assignments. Any
 * option may take the next word as its argument, so both are tried. Used to deny and review,
 * never to allow, so a wrong guess only finds a rule the command may not run.
 */
export function commandStarts(words: readonly string[], foldCase: boolean): number[] {
  const starts = [0];
  let wrapped = false;
  let optionArgument = false;
  for (const [index, word] of words.entries()) {
    if (commandWrappers.has(foldCase ? word.toLowerCase() : word)) {
      wrapped = true;
      optionArgument = false;
    } else if (wrapped && (word.startsWith("-") || assignment.test(word)))
      optionArgument = word.startsWith("-") && !word.includes("=");
    else if (wrapped && optionArgument) optionArgument = false;
    else break;
    starts.push(index + 1);
  }
  return starts;
}
