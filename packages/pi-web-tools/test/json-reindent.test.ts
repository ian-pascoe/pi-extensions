import { describe, expect, test } from "vitest";
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

  test("keeps key order, integer-like keys, and duplicate keys", () => {
    expect(reindentJson('{"10":1,"2":2,"a":3,"a":4}')).toBe(
      '{\n  "10": 1,\n  "2": 2,\n  "a": 3,\n  "a": 4\n}',
    );
  });

  test.each(["42", '"text"', "true", "null", " -1.5e-3 "])(
    "accepts top-level scalar %j",
    (source) => {
      expect(reindentJson(source)).toBe(source.trim());
    },
  );

  test.each([
    ["empty", ""],
    ["whitespace", "  \n"],
    ["JSONP", 'callback({"a":1})'],
    ["XSSI prefix", ')]}\'\n{"a":1}'],
    ["truncated", '{"a":[1,2'],
    ["trailing comma", "[1,2,]"],
    ["trailing data", '{"a":1} {"b":2}'],
    ["single quotes", "{'a':1}"],
    ["unquoted key", "{a:1}"],
    ["missing colon", '{"a" 1}'],
    ["missing comma", "[1 2]"],
    ["leading zero", "[01]"],
    ["bare dot", "[1.]"],
    ["plus sign", "[+1]"],
    ["NaN", "[NaN]"],
    ["bad literal", "[tru]"],
    ["raw control character", '["a\tb"]'],
    ["bad escape", '["\\x41"]'],
    ["short unicode escape", '["\\u00e"]'],
    ["unterminated string", '["abc]'],
    ["mismatched close", "[1}"],
    ["comment", "[1 /* c */]"],
    ["byte order mark", '\uFEFF{"a":1}'],
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

  test("re-indents small nested documents however much their layout grows", () => {
    expect(reindentJson("[[[1]]]")).toBe("[\n  [\n    [\n      1\n    ]\n  ]\n]");
    const coordinates = [
      [
        [0, 1],
        [2, 3],
      ],
      [[4, 5]],
    ];
    expect(reindentJson(JSON.stringify(coordinates))).toBe(JSON.stringify(coordinates, null, 2));
  });

  test("gives up on pathologically deep nesting without overflowing the stack", () => {
    const depth = 200_000;
    const nested = `${"[".repeat(depth)}${"]".repeat(depth)}`;
    // Too large once indented, but the scan itself must not overflow the stack.
    expect(reindentJson(nested)).toBeUndefined();
  });

  test("re-indents a multi-megabyte minified document", () => {
    const records = Array.from({ length: 20_000 }, (_, index) => ({
      id: index,
      name: `package-${index}`,
      tags: ["a", "b"],
      meta: { ok: index % 2 === 0, score: index / 7 },
    }));
    const source = JSON.stringify({ releases: records });
    expect(source.length).toBeGreaterThan(1024 * 1024);
    expect(reindentJson(source)).toBe(JSON.stringify({ releases: records }, null, 2));
  });
});
