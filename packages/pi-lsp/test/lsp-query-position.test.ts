import { describe, expect, test } from "vitest";
import {
  describeLspQueryPosition,
  lspEmptyPositionReadMessage,
  lspQueryPosition,
} from "../src/lsp-query-position.js";

const PATH = "/workspace/src/todo-context.ts";
const TEXT = [
  "export class TodoContext {",
  "  constructor(",
  "    private readonly tasks: Task[] = [],",
  "  ) {}",
  "",
  "  emoji = '😀' => value;",
].join("\n");

describe("lspQueryPosition", () => {
  test("resolves the identifier around the position", () => {
    expect(lspQueryPosition(PATH, TEXT, { line: 3, character: 18 })).toEqual({
      path: PATH,
      line: 3,
      character: 18,
      token: "readonly",
      line_text: "private readonly tasks: Task[] = [],",
    });
    // First and last characters of a word resolve the same token.
    expect(lspQueryPosition(PATH, TEXT, { line: 1, character: 14 }).token).toBe("TodoContext");
    expect(lspQueryPosition(PATH, TEXT, { line: 1, character: 24 }).token).toBe("TodoContext");
  });

  test("resolves a run of punctuation and counts Unicode code points", () => {
    expect(lspQueryPosition(PATH, TEXT, { line: 6, character: 15 }).token).toBe("=>");
    expect(lspQueryPosition(PATH, TEXT, { line: 6, character: 18 }).token).toBe("value");
    expect(lspQueryPosition(PATH, TEXT, { line: 6, character: 3 }).token).toBe("emoji");
  });

  test("has no token on whitespace or past the line end, keeping the trimmed line", () => {
    expect(lspQueryPosition(PATH, TEXT, { line: 3, character: 2 })).toEqual({
      path: PATH,
      line: 3,
      character: 2,
      line_text: "private readonly tasks: Task[] = [],",
    });
    expect(lspQueryPosition(PATH, TEXT, { line: 4, character: 7 })).toEqual({
      path: PATH,
      line: 4,
      character: 7,
      line_text: ") {}",
    });
    expect(lspQueryPosition(PATH, TEXT, { line: 5, character: 1 })).toEqual({
      path: PATH,
      line: 5,
      character: 1,
      line_text: "",
    });
    expect(lspQueryPosition(PATH, TEXT, { line: 99, character: 1 })).toEqual({
      path: PATH,
      line: 99,
      character: 1,
      line_text: "",
    });
  });

  test("keeps a very long token and line whole", () => {
    const long = "x".repeat(300);
    const query = lspQueryPosition(PATH, `  ${long} = 1;`, { line: 1, character: 5 });
    expect(query.token).toBe(long);
    expect(query.line_text).toBe(`${long} = 1;`);
  });
});

describe("describeLspQueryPosition", () => {
  test("names the relative position and its token, trimmed line, or empty line", () => {
    const cwd = "/workspace";
    expect(
      describeLspQueryPosition(cwd, lspQueryPosition(PATH, TEXT, { line: 3, character: 18 })),
    ).toBe('src/todo-context.ts:3:18 ("readonly")');
    expect(
      describeLspQueryPosition(cwd, lspQueryPosition(PATH, TEXT, { line: 3, character: 1 })),
    ).toBe('src/todo-context.ts:3:1 (no token; line: "private readonly tasks: Task[] = [],")');
    expect(
      describeLspQueryPosition(cwd, lspQueryPosition(PATH, TEXT, { line: 5, character: 1 })),
    ).toBe("src/todo-context.ts:5:1 (no token; empty line)");
  });

  test("shortens a very long token or line", () => {
    const long = "x".repeat(300);
    const text = `${long} =   1;`;
    expect(
      describeLspQueryPosition(
        "/workspace",
        lspQueryPosition(PATH, text, { line: 1, character: 1 }),
      ),
    ).toBe(`src/todo-context.ts:1:1 ("${"x".repeat(200)}…")`);
    expect(
      describeLspQueryPosition(
        "/workspace",
        lspQueryPosition(PATH, text, { line: 1, character: 304 }),
      ),
    ).toBe(`src/todo-context.ts:1:304 (no token; line: "${"x".repeat(200)}…")`);
  });
});

describe("lspEmptyPositionReadMessage", () => {
  test("says that nothing was found at the described position", () => {
    const position = 'todo-context.ts:61:18 ("readonly")';
    expect(lspEmptyPositionReadMessage("incoming_calls", position, true)).toBe(
      'No call hierarchy item at todo-context.ts:61:18 ("readonly").',
    );
    expect(lspEmptyPositionReadMessage("incoming_calls", position, false)).toBe(
      'No incoming calls found at todo-context.ts:61:18 ("readonly").',
    );
    expect(lspEmptyPositionReadMessage("subtypes", position, true)).toBe(
      'No type hierarchy item at todo-context.ts:61:18 ("readonly").',
    );
    expect(lspEmptyPositionReadMessage("find_references", position, false)).toBe(
      'No references found at todo-context.ts:61:18 ("readonly").',
    );
    expect(lspEmptyPositionReadMessage("hover", position, false)).toBe(
      'The server has no hover information at todo-context.ts:61:18 ("readonly").',
    );
  });
});
