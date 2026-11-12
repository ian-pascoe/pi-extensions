import { describe, expect, test } from "vite-plus/test";
import { JSON_REINDENT_MAX_BYTES, reindentJson } from "../src/json-reindent.js";

describe("reindentJson", () => {
  test("matches JSON.stringify's 2-space layout for ordinary values", () => {
    const value = {
      name: "requests",
      empty: {},
      none: [],
      list: [1, "two", true, false, null, { nested: [[]] }],
      deep: { a: { b: { c: [1, 2] } } },
    };
    expect(reindentJson(JSON.stringify(value))).toBe(JSON.stringify(value, null, 2));
  });

  test("normalises existing indentation and whitespace", () => {
    const source = '{\r\n\t"a" :[ 1 ,\n    2 ],\n\n  "b":{ }\t}\n';
    expect(reindentJson(source)).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": {}\n}');
  });

  test("keeps every string and number exactly as written", () => {
    const source =
      '{"id":12345678901234567890,"f":1.0,"e":1E+3,"n":-0,"s":"caf\\u00e9 \\"q\\" \\\\ \\/ \\n","u":"é 😀 { [ , : }"}';
    expect(reindentJson(source)).toBe(
      [
        "{",
        '  "id": 12345678901234567890,',
        '  "f": 1.0,',
        '  "e": 1E+3,',
        '  "n": -0,',
        '  "s": "caf\\u00e9 \\"q\\" \\\\ \\/ \\n",',
        '  "u": "é 😀 { [ , : }"',
        "}",
      ].join("\n"),
    );
  });

  test.each([" -1.5e-3 "])("accepts top-level scalar %j", (source) => {
    expect(reindentJson(source)).toBe(source.trim());
  });

  test.each([
    ["empty", ""],
    ["JSONP", 'callback({"a":1})'],
    ["trailing comma", "[1,2,]"],
    ["trailing data", '{"a":1} {"b":2}'],
    ["unquoted key", "{a:1}"],
    ["missing colon", '{"a" 1}'],
    ["leading zero", "[01]"],
    ["bare dot", "[1.]"],
    ["raw control character", '["a\tb"]'],
    ["bad escape", '["\\x41"]'],
    ["short unicode escape", '["\\u00e"]'],
    ["unterminated string", '["abc]'],
    ["mismatched close", "[1}"],
  ])("returns undefined for invalid JSON: %s", (_name, source) => {
    expect(reindentJson(source)).toBeUndefined();
  });

  test("returns undefined when the re-indented text would exceed the size limit", () => {
    // About 2 × depth² bytes of indentation.
    const depth = 5_000;
    const nested = `${"[".repeat(depth)}${"]".repeat(depth)}`;
    expect(reindentJson(nested)).toBeUndefined();
    // Size is measured in UTF-8 bytes: these characters fit the limit but their encoding does not.
    const characters = JSON_REINDENT_MAX_BYTES / 2 + 1;
    expect(reindentJson(`["${"é".repeat(characters)}"]`)).toBeUndefined();
  });

  test("gives up on pathologically deep nesting without overflowing the stack", () => {
    const depth = 200_000;
    const nested = `${"[".repeat(depth)}${"]".repeat(depth)}`;
    // Too large once indented, but the scan itself must not overflow the stack.
    expect(reindentJson(nested)).toBeUndefined();
  });
});
