/**
 * Largest UTF-8 size of re-indented JSON: four times the largest Web Fetch body. Indentation grows
 * with nesting depth, so pathologically deep JSON would otherwise grow quadratically; a document
 * that would exceed this is returned unchanged instead.
 */
export const JSON_REINDENT_MAX_BYTES = 20 * 1024 * 1024;

const INDENT = "  ";
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERALS = ["true", "false", "null"] as const;
const SIMPLE_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const HEX_DIGIT = /^[0-9A-Fa-f]$/;

type OpeningBracket = "{" | "[";

/** The token the grammar allows next. `…OrClose` states follow an opening bracket. */
type ExpectedToken =
  | "value"
  | "valueOrClose"
  | "key"
  | "keyOrClose"
  | "colon"
  | "commaOrClose"
  | "end";

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
}

/** Index after the string token starting at `start`, or undefined when it is not valid JSON. */
function stringEnd(source: string, start: number): number | undefined {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '"') return index + 1;
    if (char === "\\") {
      const escape = source[index + 1];
      if (escape === "u") {
        for (let digit = index + 2; digit < index + 6; digit++) {
          if (!HEX_DIGIT.test(source[digit] ?? "")) return undefined;
        }
        index += 6;
      } else if (escape !== undefined && SIMPLE_ESCAPES.has(escape)) {
        index += 2;
      } else {
        return undefined;
      }
    } else if (source.charCodeAt(index) < 0x20) {
      return undefined;
    } else {
      index++;
    }
  }
  return undefined;
}

/** Index after the number or literal token starting at `start`, or undefined when there is none. */
function scalarEnd(source: string, start: number): number | undefined {
  NUMBER.lastIndex = start;
  if (NUMBER.test(source)) return NUMBER.lastIndex;
  const literal = LITERALS.find((candidate) => source.startsWith(candidate, start));
  return literal === undefined ? undefined : start + literal.length;
}

/**
 * Re-indent JSON with 2-space indentation in `JSON.stringify(value, null, 2)` layout, changing only
 * the whitespace between tokens: strings and numbers keep their exact source text, and key order
 * and duplicate keys are kept. Runs in one pass without recursion. Returns undefined when `source`
 * is not a single valid JSON value, or when the result would exceed
 * {@link JSON_REINDENT_MAX_BYTES} of UTF-8.
 */
export function reindentJson(source: string): string | undefined {
  const parts: string[] = [];
  // Opening brackets of the containers the scan is inside.
  const stack: OpeningBracket[] = [];
  const lineBreaks: string[] = [];
  let outputBytes = 0;
  let expected: ExpectedToken = "value";
  let index = 0;

  const emit = (text: string, bytes = text.length): boolean => {
    parts.push(text);
    outputBytes += bytes;
    return outputBytes <= JSON_REINDENT_MAX_BYTES;
  };
  /** Copy the string token at `index` unchanged; false when it is invalid or over the limit. */
  const emitString = (): boolean => {
    const end = source[index] === '"' ? stringEnd(source, index) : undefined;
    if (end === undefined) return false;
    const token = source.slice(index, end);
    index = end;
    return emit(token, Buffer.byteLength(token, "utf8"));
  };
  const lineBreak = (): string => {
    const depth = stack.length;
    lineBreaks[depth] ??= `\n${INDENT.repeat(depth)}`;
    return lineBreaks[depth];
  };
  const afterValue = (): ExpectedToken => (stack.length === 0 ? "end" : "commaOrClose");

  while (true) {
    while (index < source.length && isJsonWhitespace(source.charCodeAt(index))) index++;
    if (index >= source.length) break;
    const char = source[index] ?? "";

    if (expected === "end") return undefined;
    if (expected === "colon") {
      if (char !== ":" || !emit(": ")) return undefined;
      index++;
      expected = "value";
      continue;
    }

    const top = stack.at(-1);
    const closes =
      (char === "]" &&
        top === "[" &&
        (expected === "valueOrClose" || expected === "commaOrClose")) ||
      (char === "}" && top === "{" && (expected === "keyOrClose" || expected === "commaOrClose"));
    if (closes) {
      stack.pop();
      // An empty container closes on the same line it opened.
      if (expected === "commaOrClose" && !emit(lineBreak())) return undefined;
      if (!emit(char)) return undefined;
      index++;
      expected = afterValue();
      continue;
    }
    if (expected === "commaOrClose") {
      if (char !== ",") return undefined;
      if (!emit(",") || !emit(lineBreak())) return undefined;
      index++;
      expected = top === "{" ? "key" : "value";
      continue;
    }

    // The first member of a container starts its first indented line.
    if ((expected === "valueOrClose" || expected === "keyOrClose") && !emit(lineBreak())) {
      return undefined;
    }

    if (expected === "key" || expected === "keyOrClose") {
      if (!emitString()) return undefined;
      expected = "colon";
      continue;
    }

    if (char === "{" || char === "[") {
      if (!emit(char)) return undefined;
      stack.push(char);
      index++;
      expected = char === "{" ? "keyOrClose" : "valueOrClose";
      continue;
    }
    if (char === '"') {
      if (!emitString()) return undefined;
      expected = afterValue();
      continue;
    }
    const end = scalarEnd(source, index);
    if (end === undefined || !emit(source.slice(index, end))) return undefined;
    index = end;
    expected = afterValue();
  }

  return expected === "end" ? parts.join("") : undefined;
}
