import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { createPiLspExtension } from "../src/pi-lsp-extension.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];
const shutdowns: Array<() => Promise<ToolResultEventResult | undefined>> = [];

/** The lifecycle events this harness delivers to the extension. */
type HarnessEvent =
  | ToolCallEvent
  | ToolResultEvent
  | { readonly type: "session_start"; readonly reason: "startup" }
  | { readonly type: "session_shutdown"; readonly reason: "quit" };
type Handler = (
  event: HarnessEvent,
  context: ExtensionContext,
) => Promise<ToolResultEventResult | undefined> | undefined;

interface RealTypeScriptSession {
  readonly cwd: string;
  /** Emit Pi's `tool_call` then, after `mutate` changes the file, its `tool_result`. */
  edit(options: {
    readonly toolCallId: string;
    readonly path: string;
    readonly oldText: string;
    readonly newText: string;
  }): Promise<string>;
}

/** Drive the extension factory exactly as Pi does, against the real `tsc --lsp` server. */
async function startRealTypeScriptSession(
  files: Readonly<Record<string, string>>,
): Promise<RealTypeScriptSession> {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-lsp-dependents-"));
  const agentDirectory = await mkdtemp(resolve(tmpdir(), "pi-lsp-dependents-agent-"));
  temporaryDirectories.push(cwd, agentDirectory);
  await writeFile(
    resolve(cwd, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "nodenext", noEmit: true, strict: true },
      include: ["src"],
    }),
  );
  for (const [name, text] of Object.entries(files)) {
    await mkdir(resolve(cwd, name, ".."), { recursive: true });
    await writeFile(resolve(cwd, name), text);
  }
  await writeFile(
    resolve(agentDirectory, "settings.json"),
    JSON.stringify({
      lsp: {
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
    }),
  );

  const handlers = new Map<string, Handler>();
  const pi = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerEntryRenderer: () => undefined,
    appendEntry: () => undefined,
    on: (name: string, handler: Handler) => void handlers.set(name, handler),
  };
  await createPiLspExtension({ getAgentDirectory: () => agentDirectory })(
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The extension registers only the members above on this test double.
    pi as unknown as ExtensionAPI,
  );
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The extension reads only these members from the context.
  const context = {
    cwd,
    signal: undefined,
    isProjectTrusted: () => false,
    ui: { notify: () => undefined },
    sessionManager: { getSessionDir: () => agentDirectory, getBranch: () => [] },
  } as unknown as ExtensionContext;
  const emit = async (event: HarnessEvent): Promise<ToolResultEventResult | undefined> =>
    await handlers.get(event.type)?.(event, context);
  await emit({ type: "session_start", reason: "startup" });
  shutdowns.push(async () => await emit({ type: "session_shutdown", reason: "quit" }));

  return {
    cwd,
    async edit({ toolCallId, path, oldText, newText }) {
      const filePath = resolve(cwd, path);
      const input = { path: filePath, edits: [{ oldText, newText }] };
      await emit({ type: "tool_call", toolCallId, toolName: "edit", input });
      await writeFile(filePath, (await readFile(filePath, "utf8")).replace(oldText, newText));
      const result = await emit({
        type: "tool_result",
        toolCallId,
        toolName: "edit",
        input,
        content: [{ type: "text", text: `Edited ${path}` }],
        details: undefined,
        isError: false,
      });
      return (result?.content ?? [])
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
    },
  };
}

afterEach(async () => {
  await Promise.all(shutdowns.splice(0).map((shutdown) => shutdown()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

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
    expect(dependents).toContain("src/pi-todo-extension.ts:1:10 error [typescript]");
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
});
