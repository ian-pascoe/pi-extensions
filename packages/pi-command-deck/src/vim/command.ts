import { SIMPLE_MOTION_KEYS, type FindKey } from "./motions.js";
import { isOperator, type Operator } from "./operators.js";
import { isTextObjectKey } from "./text-objects.js";
import type { VimKey } from "./types.js";

/** Counts above this are clamped, as in Vim's practical limits for prompts. */
export const MAX_COUNT = 9999;

/** A motion as typed, before it is resolved against the buffer. */
export type MotionSpec =
  | { kind: "simple"; key: string }
  | { kind: "find"; key: FindKey; char: string }
  | { kind: "repeat-find"; reverse: boolean }
  | { kind: "search-next"; reverse: boolean }
  | { kind: "word-search"; backward: boolean }
  | { kind: "search"; backward: boolean };

/** What an operator applies to. */
export type OperatorTarget =
  | { kind: "motion"; motion: MotionSpec }
  | { kind: "object"; around: boolean; object: string }
  | { kind: "line" }
  /** The live visual selection. */
  | { kind: "selection" };

/** A complete normal- or visual-mode command. */
export type Command =
  | { kind: "motion"; count: number | undefined; motion: MotionSpec }
  | { kind: "operator"; count: number | undefined; operator: Operator; target: OperatorTarget }
  | { kind: "action"; count: number | undefined; action: string; char?: string }
  /** A text object typed in visual mode, which selects instead of operating. */
  | { kind: "select"; count: number | undefined; around: boolean; object: string };

export type ParseResult =
  | { status: "incomplete" }
  | { status: "invalid" }
  /** `keys` are the typed keys without count digits, ready for dot-repeat. */
  | { status: "complete"; command: Command; keys: VimKey[] };

const G_COMMANDS = new Set(["gg", "ge", "gE", "gJ", "gu", "gU", "g~", "gv", "gi"]);
const FIND_KEYS = new Set(["f", "F", "t", "T"]);
const NORMAL_ACTIONS = new Set([
  "x",
  "X",
  "<Del>",
  "s",
  "S",
  "D",
  "C",
  "Y",
  "p",
  "P",
  "J",
  "gJ",
  "~",
  "u",
  "<Undo>",
  "<C-r>",
  ".",
  "i",
  "a",
  "I",
  "A",
  "o",
  "O",
  "gi",
  "R",
  "v",
  "V",
  "gv",
  ":",
]);
const VISUAL_ACTIONS = new Set([
  "o",
  "O",
  "x",
  "<Del>",
  "X",
  "s",
  "S",
  "D",
  "C",
  "Y",
  "p",
  "P",
  "J",
  "gJ",
  "~",
  "u",
  "U",
  "v",
  "V",
]);
const CHAR_ACTIONS = new Set(["r"]);

/** True for named keys such as `<Esc>`; a lone `<` is printable. */
export function isNamedKey(key: VimKey): boolean {
  return key.length > 1 && key.startsWith("<") && key.endsWith(">");
}

class KeyReader {
  index = 0;
  readonly stripped: VimKey[] = [];

  constructor(private readonly keys: readonly VimKey[]) {}

  get done(): boolean {
    return this.index >= this.keys.length;
  }

  /** Read a count; a leading `0` is the line-start motion, not a count. */
  count(): number | undefined {
    let digits = "";
    for (;;) {
      const key = this.keys[this.index];
      if (key === undefined || !/^[0-9]$/u.test(key) || (digits === "" && key === "0")) break;
      digits += key;
      this.index += 1;
    }
    return digits === "" ? undefined : Math.min(MAX_COUNT, Number(digits));
  }

  /** Read one command token, combining `g` with its follower. Undefined means more keys are needed. */
  token(): string | undefined {
    const key = this.keys[this.index];
    if (key === undefined) return undefined;
    if (key !== "g") {
      this.index += 1;
      this.stripped.push(key);
      return key;
    }
    const next = this.keys[this.index + 1];
    if (next === undefined) return undefined;
    this.index += 2;
    this.stripped.push(key, next);
    return `g${next}`;
  }

  /** Read one literal argument key, e.g. the character after `f` or `r`. */
  argument(): string | undefined {
    const key = this.keys[this.index];
    if (key === undefined) return undefined;
    this.index += 1;
    this.stripped.push(key);
    return key;
  }
}

function multiply(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return Math.min(MAX_COUNT, first * second);
}

type MotionParse = MotionSpec | "incomplete" | "invalid";

function parseMotion(token: string, reader: KeyReader): MotionParse {
  if (SIMPLE_MOTION_KEYS.has(token)) return { kind: "simple", key: token };
  if (FIND_KEYS.has(token)) {
    const char = reader.argument();
    if (char === undefined) return "incomplete";
    if (isNamedKey(char)) return "invalid";
    // SAFETY: FIND_KEYS contains exactly the FindKey members.
    return { kind: "find", key: token as FindKey, char };
  }
  if (token === ";" || token === ",") return { kind: "repeat-find", reverse: token === "," };
  if (token === "n" || token === "N") return { kind: "search-next", reverse: token === "N" };
  if (token === "*" || token === "#") return { kind: "word-search", backward: token === "#" };
  if (token === "/" || token === "?") return { kind: "search", backward: token === "?" };
  return "invalid";
}

/** Parse pending keys into a command for normal (`visual: false`) or visual mode. */
export function parseCommand(keys: readonly VimKey[], visual: boolean): ParseResult {
  const reader = new KeyReader(keys);
  const count = reader.count();
  const token = reader.token();
  if (token === undefined) return { status: "incomplete" };
  if (token.startsWith("g") && token.length === 2 && !G_COMMANDS.has(token))
    return { status: "invalid" };
  const complete = (command: Command): ParseResult => ({
    status: "complete",
    command,
    keys: reader.stripped,
  });

  if (CHAR_ACTIONS.has(token)) {
    const char = reader.argument();
    if (char === undefined) return { status: "incomplete" };
    if (isNamedKey(char) && char !== "<CR>") return { status: "invalid" };
    return complete({ kind: "action", count, action: token, char });
  }
  if (visual && (token === "i" || token === "a")) {
    const object = reader.argument();
    if (object === undefined) return { status: "incomplete" };
    if (!isTextObjectKey(object)) return { status: "invalid" };
    return complete({ kind: "select", count, around: token === "a", object });
  }
  if (isOperator(token)) {
    if (visual)
      return complete({ kind: "operator", count, operator: token, target: { kind: "line" } });
    const motionCount = reader.count();
    const next = reader.token();
    if (next === undefined) return { status: "incomplete" };
    const total = multiply(count, motionCount);
    if (next === token || (token.length === 2 && next === token[1])) {
      return complete({
        kind: "operator",
        count: total,
        operator: token,
        target: { kind: "line" },
      });
    }
    if (next === "i" || next === "a") {
      const object = reader.argument();
      if (object === undefined) return { status: "incomplete" };
      if (!isTextObjectKey(object)) return { status: "invalid" };
      return complete({
        kind: "operator",
        count: total,
        operator: token,
        target: { kind: "object", around: next === "a", object },
      });
    }
    const motion = parseMotion(next, reader);
    if (motion === "incomplete" || motion === "invalid") return { status: motion };
    return complete({
      kind: "operator",
      count: total,
      operator: token,
      target: { kind: "motion", motion },
    });
  }
  if ((visual ? VISUAL_ACTIONS : NORMAL_ACTIONS).has(token)) {
    return complete({ kind: "action", count, action: token });
  }
  const motion = parseMotion(token, reader);
  if (motion === "incomplete" || motion === "invalid") return { status: motion };
  return complete({ kind: "motion", count, motion });
}
