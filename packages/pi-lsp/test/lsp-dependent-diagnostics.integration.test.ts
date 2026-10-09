import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  closeExtensionSessions,
  startExtensionSession,
  type ExtensionSession,
} from "./extension-session.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

/** Start the extension against the real `tsc --lsp` server in a temporary TypeScript project. */
function startRealTypeScriptSession(
  files: Readonly<Record<string, string>>,
): Promise<ExtensionSession> {
  return startExtensionSession({
    files: {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { module: "nodenext", noEmit: true, strict: true },
        include: ["src"],
      }),
      ...files,
    },
    lspSettings: {
      timeouts: { initializeMs: 45_000, requestMs: 8_000, diagnosticsMs: 15_000 },
      servers: {
        typescript: {
          command: resolve(repositoryRoot, "node_modules/.bin/tsc"),
          args: ["--lsp", "--stdio"],
          rootMarkers: ["tsconfig.json"],
          languages: [{ extensions: [".ts"], languageId: "typescript" }],
        },
      },
    },
  });
}

afterEach(closeExtensionSessions);

const todoListSource = [
  "export function createEmptyTodoState(): number[] {",
  "  return [];",
  "}",
  "",
  "export function other(): string {",
  '  return "other";',
  "}",
  "",
  "export const used = createEmptyTodoState();",
  "",
].join("\n");
const extensionSource = [
  'import { createEmptyTodoState, other } from "./todo-list.js";',
  "",
  "export const initial = createEmptyTodoState();",
  "export const again = createEmptyTodoState();",
  "export const text: string = other();",
  "",
].join("\n");

describe("dependent-file Post-edit Diagnostics with the real tsc --lsp server", () => {
  test("reports the new errors an edit causes in a file that was never opened", async () => {
    const session = await startRealTypeScriptSession({
      "src/todo-list.ts": todoListSource,
      "src/pi-todo-extension.ts": extensionSource,
      // A file that imports nothing the edit touches is never reported.
      "src/unrelated.ts": 'export const unrelated: number = "pre-existing";\n',
    });
    const text = await session.edit({
      toolCallId: "rename",
      path: "src/todo-list.ts",
      oldText: "export function createEmptyTodoState()",
      newText: "export function createEmptyTodoStateX()",
    });

    // The in-file use still comes first, under the original heading.
    expect(text).toContain("LSP diagnostics\nsrc/todo-list.ts:9:");
    const dependents = text.split("LSP diagnostics in dependent files")[1];
    if (dependents === undefined) throw new Error(`Expected a dependent-files section:\n${text}`);
    expect(dependents).toContain("src/pi-todo-extension.ts:1:10-30 error [typescript] ts(2724): ");
    expect(dependents).toContain("createEmptyTodoStateX");
    expect(dependents).not.toContain("unrelated.ts");
    expect(dependents).not.toContain("not checked");
  }, 90_000);

  test("reports each broken call site after a signature change", async () => {
    const session = await startRealTypeScriptSession({
      "src/todo-list.ts": todoListSource,
      "src/pi-todo-extension.ts": extensionSource,
    });
    const text = await session.edit({
      toolCallId: "signature",
      path: "src/todo-list.ts",
      oldText: "export function createEmptyTodoState()",
      newText: "export function createEmptyTodoState(seed: number)",
    });

    const dependents = text.split("LSP diagnostics in dependent files")[1];
    if (dependents === undefined) throw new Error(`Expected a dependent-files section:\n${text}`);
    expect(dependents).toContain("src/pi-todo-extension.ts:3:");
    expect(dependents).toContain("src/pi-todo-extension.ts:4:");
    expect(dependents).not.toContain("src/pi-todo-extension.ts:1:");
  }, 90_000);

  test("stays silent about a dependent's errors that existed before the edit", async () => {
    const session = await startRealTypeScriptSession({
      "src/todo-list.ts": todoListSource,
      // `text` is already a type error; renaming an unrelated export must not surface it.
      "src/pi-todo-extension.ts": [
        'import { other } from "./todo-list.js";',
        "export const text: number = other();",
        "",
      ].join("\n"),
    });
    const text = await session.edit({
      toolCallId: "body-edit",
      path: "src/todo-list.ts",
      oldText: 'return "other";',
      newText: 'return "changed";',
    });

    expect(text).toBe("Edited src/todo-list.ts\n\nLSP diagnostics: no diagnostics");
  }, 90_000);

  test("adds no output when the edited declaration has no dependents", async () => {
    const session = await startRealTypeScriptSession({
      "src/todo-list.ts": todoListSource,
      "src/pi-todo-extension.ts": extensionSource,
    });
    const text = await session.edit({
      toolCallId: "no-dependents",
      path: "src/pi-todo-extension.ts",
      oldText: "export const again = createEmptyTodoState();",
      newText: "export const again = createEmptyTodoState().length;",
    });

    expect(text).toBe("Edited src/pi-todo-extension.ts\n\nLSP diagnostics: no diagnostics");
  }, 90_000);

  test("checks at most 20 dependent files and reports how many it left unchecked", async () => {
    const dependents = Object.fromEntries(
      Array.from({ length: 23 }, (_, index) => [
        `src/dependent-${String(index).padStart(2, "0")}.ts`,
        'import { other } from "./todo-list.js";\nexport const value: string = other();\n',
      ]),
    );
    const session = await startRealTypeScriptSession({
      "src/todo-list.ts": todoListSource,
      ...dependents,
    });
    const text = await session.edit({
      toolCallId: "many-dependents",
      path: "src/todo-list.ts",
      oldText: "export function other(): string",
      newText: "export function other(): number",
    });

    const section = text.split("LSP diagnostics in dependent files")[1];
    if (section === undefined) throw new Error(`Expected a dependent-files section:\n${text}`);
    const reportedFiles = new Set(section.match(/src\/dependent-\d+\.ts/gu));
    expect(reportedFiles.size).toBe(20);
    // The cap keeps the first 20 by path; the other three are counted, not named.
    expect(reportedFiles).not.toContain("src/dependent-22.ts");
    expect(section).toContain("3 dependent files not checked");
  }, 120_000);

  test("does not report a dependent's existing error as new when a sibling edit in the same batch shifts it", async () => {
    const session = await startRealTypeScriptSession({
      "src/x.ts": "export function x(): number {\n  return 1;\n}\n",
      "src/y.ts": ['import { x } from "./x.js";', "export const broken: string = x();", ""].join(
        "\n",
      ),
    });
    // Pi 1.1.0 runs a batch's `tool_call`s first, then executes the calls in parallel.
    const bodyEdit = await session.beginEdit({
      toolCallId: "body",
      path: "src/x.ts",
      oldText: "return 1;",
      newText: "return 2;",
    });
    const shiftEdit = await session.beginEdit({
      toolCallId: "shift",
      path: "src/y.ts",
      oldText: 'import { x } from "./x.js";',
      newText: '// a new first line\nimport { x } from "./x.js";',
    });
    await shiftEdit.finish();
    const text = await bodyEdit.finish();

    expect(text).toBe("Edited src/x.ts\n\nLSP diagnostics: no diagnostics");
  }, 90_000);
});
