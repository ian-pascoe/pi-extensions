import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  closeExtensionSessions,
  startExtensionSession,
  type ExtensionSession,
} from "./extension-session.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

/** Start the extension against the real `tsrs --lsp` server in a temporary TypeScript project. */
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
          command: resolve(repositoryRoot, "node_modules/.bin/tsrs"),
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

describe("dependent-file Post-edit Diagnostics with the real tsrs --lsp server", () => {
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
