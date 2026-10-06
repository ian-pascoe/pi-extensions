import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createEditTool,
  createWriteTool,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type SessionStartEvent,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";
import { createPiFormatterExtension } from "../src/pi-formatter-extension.js";
import type { FormatterSettingsDocumentInput } from "../src/pi-formatter-settings.js";
import { TROUBLESHOOTING_HINT } from "../src/troubleshooting-skill.js";

const temporaryDirectories: string[] = [];

const ReadmeExampleSchema = Type.Object({
  formatter: Type.Object({
    formatters: Type.Record(Type.String(), Type.Object({ syntaxErrorPattern: Type.String() })),
  }),
});

/** The `syntaxErrorPattern` values from the README's JSON example, so the docs stay tested. */
async function readmeSyntaxErrorPatterns(): Promise<Readonly<Record<string, string>>> {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const example = /```json\n(\{\n {2}"formatter": \{\n {4}"formatters": [\s\S]*?)```/.exec(readme);
  if (example?.[1] === undefined) throw new Error("README syntaxErrorPattern example not found");
  const parsed: unknown = JSON.parse(example[1]);
  if (!Value.Check(ReadmeExampleSchema, parsed)) throw new Error("unexpected README example shape");
  return Object.fromEntries(
    Object.entries(parsed.formatter.formatters).map(([id, { syntaxErrorPattern }]) => [
      id,
      syntaxErrorPattern,
    ]),
  );
}

interface FormatterHarness {
  readonly cwd: string;
  readonly notifications: string[];
  readonly runner: ExtensionRunner;
}

interface FormatterTestToolResult {
  readonly details: ToolResultEvent["details"];
  readonly input: ToolResultEvent["input"];
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFormatterHarness(
  globalSettings: FormatterSettingsDocumentInput,
): Promise<FormatterHarness> {
  const cwd = await makeTemporaryDirectory("pi-formatter-extension-cwd-");
  const agentDirectory = await makeTemporaryDirectory("pi-formatter-extension-agent-");
  const sessionDirectory = await makeTemporaryDirectory("pi-formatter-extension-session-");
  await writeFile(resolve(agentDirectory, "settings.json"), JSON.stringify(globalSettings));
  await mkdir(resolve(cwd, ".pi"));
  await writeFile(resolve(cwd, ".pi/settings.json"), "{}");

  const sessionManager = SessionManager.create(cwd, sessionDirectory);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: agentDirectory,
    extensionFactories: [
      {
        name: "pi-formatter-lifecycle-test",
        factory: createPiFormatterExtension(() => agentDirectory),
      },
    ],
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  const extensions = resourceLoader.getExtensions();
  expect(extensions.errors).toEqual([]);

  const modelRuntime = await ModelRuntime.create({
    authPath: resolve(agentDirectory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const runner = new ExtensionRunner(
    extensions.extensions,
    extensions.runtime,
    cwd,
    sessionManager,
    new ModelRegistry(modelRuntime),
  );
  runner.bindCore(
    {
      sendMessage: () => undefined,
      sendUserMessage: () => undefined,
      appendEntry: () => undefined,
      setSessionName: () => undefined,
      getSessionName: () => undefined,
      setLabel: () => undefined,
      getActiveTools: () => [],
      getAllTools: () => [],
      getSettings: () => ({}),
      setActiveTools: () => undefined,
      refreshTools: () => undefined,
      getCommands: () => [],
      setModel: async () => true,
      getThinkingLevel: () => "medium",
      setThinkingLevel: () => undefined,
    },
    {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => undefined,
      hasPendingMessages: () => false,
      shutdown: () => undefined,
      getContextUsage: () => undefined,
      compact: () => undefined,
      getSystemPrompt: () => "Pi Formatter lifecycle test",
    },
  );
  const notifications: string[] = [];
  runner.setUIContext(
    { ...runner.getUIContext(), notify: (message) => notifications.push(message) },
    "rpc",
  );
  await runner.emit({ type: "session_start", reason: "startup" } satisfies SessionStartEvent);
  return { cwd, notifications, runner };
}

function formatterDefinition(args: readonly string[]) {
  return {
    command: process.execPath,
    args,
    files: { extensions: [".txt"] },
  };
}

function toolResultEvent(toolName: string, result: FormatterTestToolResult): ToolResultEvent {
  return {
    type: "tool_result",
    toolName,
    toolCallId: "call-1",
    input: result.input,
    content: [{ type: "text", text: "changed" }],
    details: result.details,
    isError: false,
  };
}

/**
 * A File Formatter that strips trailing spaces. It reads the file, marks that it has read it, and
 * writes the result 300 ms later, so a change made to the file in between would be overwritten.
 */
const SLOW_TRIM_SCRIPT =
  "const fs=require('node:fs');const p=process.argv[1];const t=fs.readFileSync(p,'utf8');fs.writeFileSync('formatter-read','');setTimeout(()=>fs.writeFileSync(p,t.replace(/ +$/gm,'')),300)";

async function waitForPath(path: string): Promise<void> {
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      await delay(10);
    }
  }
}

/** The text blocks Pi Formatter appended to a mutation result whose tool reported one block. */
function formatterNotes(result: { content?: ToolResultEvent["content"] } | undefined): string[] {
  return (result?.content ?? [])
    .slice(1)
    .flatMap((block) => (block.type === "text" ? [block.text] : []));
}

function lastText(result: { content?: ToolResultEvent["content"] } | undefined): string {
  const block = result?.content?.at(-1);
  if (block?.type !== "text") throw new Error("expected the last content block to be text");
  return block.text;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Pi Formatter extension lifecycle", () => {
  test("formats every apply_patch destination and runs a workspace formatter once", async () => {
    const perFileScript =
      "const fs=require('node:fs');const p=process.argv[1];fs.appendFileSync(p,':'+process.env.PI_FORMATTER_TEST)";
    const workspaceScript =
      "const fs=require('node:fs');const p='workspace-runs';const n=fs.existsSync(p)?+fs.readFileSync(p,'utf8'):0;fs.writeFileSync(p,String(n+1))";
    const harness = await createFormatterHarness({
      formatter: {
        formatters: {
          perFile: {
            ...formatterDefinition(["-e", perFileScript, "$FILE"]),
            environment: { PI_FORMATTER_TEST: "formatted" },
          },
          workspace: formatterDefinition(["-e", workspaceScript]),
        },
      },
    });
    const first = resolve(harness.cwd, "first.txt");
    const second = resolve(harness.cwd, "second.txt");
    await Promise.all([writeFile(first, "one"), writeFile(second, "two")]);

    const result = await harness.runner.emitToolResult(
      toolResultEvent("apply_patch", {
        input: {},
        details: {
          status: "success",
          result: {
            changedFiles: [first],
            createdFiles: [second],
            deletedFiles: [],
            movedFiles: [],
          },
        },
      }),
    );

    expect(result?.content?.at(-1)).toMatchObject({
      text: [
        "Formatted by perFile: first.txt: line 1 changed",
        "@@ -1 +1 @@",
        "-one",
        "\\ No newline at end of file",
        "+one:formatted",
        "\\ No newline at end of file",
        "Formatted by perFile: second.txt: line 1 changed",
        "@@ -1 +1 @@",
        "-two",
        "\\ No newline at end of file",
        "+two:formatted",
        "\\ No newline at end of file",
      ].join("\n"),
    });
    expect(await readFile(first, "utf8")).toBe("one:formatted");
    expect(await readFile(second, "utf8")).toBe("two:formatted");
    expect(await readFile(resolve(harness.cwd, "workspace-runs"), "utf8")).toBe("1");
  });

  test("runs formatters from each changed file's nearest root marker", async () => {
    const script =
      "const fs=require('node:fs');const p=process.argv[1];fs.appendFileSync(p,':'+process.cwd())";
    const workspaceScript =
      "const fs=require('node:fs');fs.writeFileSync('workspace-root',process.cwd())";
    const harness = await createFormatterHarness({
      formatter: {
        formatters: {
          rooted: {
            ...formatterDefinition(["-e", script, "$FILE"]),
            rootMarkers: ["package.json"],
          },
          rootedWorkspace: {
            ...formatterDefinition(["-e", workspaceScript]),
            rootMarkers: ["package.json"],
          },
        },
      },
    });
    const packageRoot = resolve(harness.cwd, "packages/example");
    const filePath = resolve(packageRoot, "src/rooted.txt");
    await mkdir(resolve(packageRoot, "src"), { recursive: true });
    await Promise.all([
      writeFile(resolve(packageRoot, "package.json"), "{}"),
      writeFile(filePath, "root"),
    ]);

    await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(await readFile(filePath, "utf8")).toBe(`root:${packageRoot}`);
    expect(await readFile(resolve(packageRoot, "workspace-root"), "utf8")).toBe(packageRoot);
  });

  test("activates file and workspace formatters only while a required root marker exists", async () => {
    const fileScript =
      "const fs=require('node:fs');const p=process.argv[1];fs.appendFileSync(p,':formatted')";
    const workspaceScript =
      "const fs=require('node:fs');fs.writeFileSync('workspace-formatted','yes')";
    const harness = await createFormatterHarness({
      formatter: {
        formatters: {
          gatedFile: {
            ...formatterDefinition(["-e", fileScript, "$FILE"]),
            requireRootMarker: true,
            rootMarkers: ["formatter.config.json"],
          },
          gatedWorkspace: {
            ...formatterDefinition(["-e", workspaceScript]),
            requireRootMarker: true,
            rootMarkers: ["formatter.config.json"],
          },
        },
      },
    });
    const filePath = resolve(harness.cwd, "src/gated.txt");
    await mkdir(resolve(harness.cwd, "src"));
    await writeFile(filePath, "original");

    await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(await readFile(filePath, "utf8")).toBe("original");
    await expect(readFile(resolve(harness.cwd, "workspace-formatted"))).rejects.toThrow();

    await writeFile(resolve(harness.cwd, "formatter.config.json"), "{}");
    await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(await readFile(filePath, "utf8")).toBe("original:formatted");
    expect(await readFile(resolve(harness.cwd, "workspace-formatted"), "utf8")).toBe("yes");
  });

  test.each([
    ["edit", "edit", (path: string) => ({ input: { path }, details: undefined })],
    ["write", "write", (path: string) => ({ input: { path }, details: undefined })],
    [
      "lsp_apply",
      "lsp_apply",
      (path: string) => ({
        input: { preview_id: "preview-1", mutation_manifest: [{ operation: "modify", path }] },
        details: { kind: "workspace_edit_apply", state: "applied", changed_paths: [path] },
      }),
    ],
    [
      "legacy lsp apply",
      "lsp",
      (path: string) => ({
        input: {
          operation: "apply",
          mutation_manifest: [{ operation: "modify", path }],
        },
        details: { kind: "workspace_edit_apply", state: "applied", changed_paths: [path] },
      }),
    ],
  ])("formats successful %s mutations", async (name, toolName, eventForPath) => {
    const script =
      "const fs=require('node:fs');const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,'utf8').toUpperCase())";
    const harness = await createFormatterHarness({
      formatter: { formatters: { uppercase: formatterDefinition(["-e", script, "$FILE"]) } },
    });
    const filePath = resolve(harness.cwd, `${basename(name)}.txt`);
    await writeFile(filePath, "format me");
    const event = eventForPath(filePath);

    const result = await harness.runner.emitToolResult(toolResultEvent(toolName, event));

    expect(await readFile(filePath, "utf8")).toBe("FORMAT ME");
    expect(result?.content).toEqual([
      { type: "text", text: "changed" },
      {
        type: "text",
        text: [
          "Formatted by uppercase: line 1 changed",
          "@@ -1 +1 @@",
          "-format me",
          "\\ No newline at end of file",
          "+FORMAT ME",
          "\\ No newline at end of file",
        ].join("\n"),
      },
    ]);
  });

  test.each(["lsp_rename", "lsp_code_actions", "not_lsp"])(
    "ignores %s results even with a valid manifest and apply details",
    async (toolName) => {
      const script = "require('node:fs').writeFileSync(process.argv[1],'formatted')";
      const harness = await createFormatterHarness({
        formatter: { formatters: { overwrite: formatterDefinition(["-e", script, "$FILE"]) } },
      });
      const filePath = resolve(harness.cwd, "preview.txt");
      await writeFile(filePath, "original");

      // Only the tool name distinguishes this from a real lsp_apply result.
      await harness.runner.emitToolResult(
        toolResultEvent(toolName, {
          input: {
            preview_id: "preview-1",
            mutation_manifest: [{ operation: "modify", path: filePath }],
          },
          details: { kind: "workspace_edit_apply", state: "applied", changed_paths: [filePath] },
        }),
      );

      expect(await readFile(filePath, "utf8")).toBe("original");
    },
  );

  test("ignores an lsp_apply result without Workspace Edit application details", async () => {
    const script = "require('node:fs').writeFileSync(process.argv[1],'formatted')";
    const harness = await createFormatterHarness({
      formatter: { formatters: { overwrite: formatterDefinition(["-e", script, "$FILE"]) } },
    });
    const filePath = resolve(harness.cwd, "preview.txt");
    await writeFile(filePath, "original");

    await harness.runner.emitToolResult(
      toolResultEvent("lsp_apply", {
        input: {
          preview_id: "preview-1",
          mutation_manifest: [{ operation: "modify", path: filePath }],
        },
        details: { kind: "workspace_edit_preview", state: "available" },
      }),
    );

    expect(await readFile(filePath, "utf8")).toBe("original");
  });

  test("keeps the lsp_apply structured result when appending formatter warnings", async () => {
    const harness = await createFormatterHarness({
      formatter: {
        formatters: { broken: formatterDefinition(["-e", "process.exit(3)", "$FILE"]) },
      },
    });
    const filePath = resolve(harness.cwd, "structured.txt");
    await writeFile(filePath, "original");
    const structuredContent = { preview_id: "preview-1", state: "applied", truncated: false };

    const result = await harness.runner.emitToolResult({
      ...toolResultEvent("lsp_apply", {
        input: {
          preview_id: "preview-1",
          mutation_manifest: [{ operation: "modify", path: filePath }],
        },
        details: { kind: "workspace_edit_apply", state: "applied", changed_paths: [filePath] },
      }),
      structuredContent,
    });

    expect(result?.content?.at(-1)).toMatchObject({
      text: expect.stringContaining("Pi Formatter: broken failed"),
    });
    expect(result?.structuredContent).toEqual(structuredContent);
  });

  test("warns without changing mutation success and continues after a formatter fails", async () => {
    const successScript =
      "const fs=require('node:fs');const p=process.argv[1];fs.appendFileSync(p,':continued')";
    const harness = await createFormatterHarness({
      formatter: {
        formatters: {
          invalidSpawn: { ...formatterDefinition(["$FILE"]), command: "\0" },
          broken: formatterDefinition([
            "-e",
            "console.error('expected stderr');process.exit(7)",
            "$FILE",
          ]),
          later: formatterDefinition(["-e", successScript, "$FILE"]),
        },
      },
    });
    const filePath = resolve(harness.cwd, "failure.txt");
    await writeFile(filePath, "original");

    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(result).toMatchObject({ isError: false });
    expect(result?.content?.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringMatching(
        /Pi Formatter: invalidSpawn failed .*failure\.txt \(spawn error\)/,
      ),
    });
    expect(result?.content?.at(-1)).toMatchObject({
      text: expect.stringMatching(
        /Pi Formatter: broken failed .*failure\.txt \(exit code 7\): expected stderr/,
      ),
    });
    expect(result?.content?.at(-1)).toMatchObject({
      text: expect.stringContaining(TROUBLESHOOTING_HINT),
    });
    expect(await readFile(filePath, "utf8")).toBe("original:continued");
  });

  test("adds no line when a File Formatter leaves the content unchanged", async () => {
    const harness = await createFormatterHarness({
      formatter: { formatters: { noop: formatterDefinition(["-e", "", "$FILE"]) } },
    });
    const filePath = resolve(harness.cwd, "unchanged.txt");
    await writeFile(filePath, "stays\n");

    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(result).toBeUndefined();
  });

  test("reports one line per file naming every formatter, with the span measured against the original content", async () => {
    const rewrite =
      "const fs=require('node:fs');const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace(process.argv[2],process.argv[3]))";
    const harness = await createFormatterHarness({
      formatter: {
        formatters: {
          first: formatterDefinition(["-e", rewrite, "$FILE", "d\n", "D\n"]),
          second: formatterDefinition(["-e", rewrite, "$FILE", "a\n", "a\nnew1\nnew2\n"]),
          third: formatterDefinition(["-e", rewrite, "$FILE", "missing", "never"]),
        },
      },
    });
    const filePath = resolve(harness.cwd, "span.txt");
    await writeFile(filePath, "a\nb\nc\nd\ne\n");

    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(await readFile(filePath, "utf8")).toBe("a\nnew1\nnew2\nb\nc\nD\ne\n");
    // `first` changed line 4, then `second` inserted lines above it. Only the final span is valid.
    expect(result?.content?.at(-1)).toEqual({
      type: "text",
      text: [
        "Formatted by first, second: lines 2–6 changed",
        "@@ -1,5 +1,7 @@",
        " a",
        "+new1",
        "+new2",
        " b",
        " c",
        "-d",
        "+D",
        " e",
      ].join("\n"),
    });
  });

  test("lets the agent write an exact edit from the mutation result alone after a formatter rewrote the file", async () => {
    const script =
      "require('node:fs').writeFileSync(process.argv[1],'export function f(a: number) {\\n  return a + 1;\\n}\\n')";
    const harness = await createFormatterHarness({
      formatter: {
        formatters: {
          prettier: {
            command: process.execPath,
            args: ["-e", script, "$FILE"],
            files: { extensions: [".ts"] },
          },
        },
      },
    });
    const filePath = resolve(harness.cwd, "f.ts");
    const written = await createWriteTool(harness.cwd).execute("write-1", {
      path: filePath,
      content: "export function f( a:number ){return a+1}",
    });
    const formatted = await harness.runner.emitToolResult({
      ...toolResultEvent("write", {
        input: { path: filePath },
        details: undefined,
      }),
      content: written.content,
    });
    const resultText = (formatted?.content ?? [])
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");

    // Only the model-visible text is used: the formatted lines are its context and `+` lines.
    const formattedLines = resultText
      .split("\n")
      .filter((line) => line.startsWith(" ") || line.startsWith("+"))
      .map((line) => line.slice(1));
    const oldText = formattedLines.find((line) => line.includes("return a + 1"));
    expect(formattedLines).toEqual(["export function f(a: number) {", "  return a + 1;", "}"]);
    if (oldText === undefined) throw new Error("expected the formatted return line in the result");
    const edited = await createEditTool(harness.cwd).execute("edit-1", {
      path: filePath,
      edits: [{ oldText, newText: "  return a + 2;" }],
    });

    expect(edited.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Successfully"),
    });
    expect(await readFile(filePath, "utf8")).toBe(
      "export function f(a: number) {\n  return a + 2;\n}\n",
    );
  });

  test("formats parallel edits to one file after every edit, reporting only the formatter's changes", async () => {
    const harness = await createFormatterHarness({
      formatter: { formatters: { trim: formatterDefinition(["-e", SLOW_TRIM_SCRIPT, "$FILE"]) } },
    });
    const filePath = resolve(harness.cwd, "values.txt");
    await writeFile(filePath, "a = 1\nb = 2\nc = 3\n");
    // Every write waits first, as on a slow disk, so the edits of one batch finish one by one.
    const editTool = createEditTool(harness.cwd, {
      operations: {
        access: (path) => access(path, constants.R_OK | constants.W_OK),
        readFile: (path) => readFile(path),
        writeFile: async (path, content) => {
          await delay(100);
          await writeFile(path, content);
        },
      },
    });
    const edits = [
      { oldText: "a = 1", newText: "a = 10  " },
      { oldText: "b = 2", newText: "b = 20  " },
      { oldText: "c = 3", newText: "c = 30  " },
    ];

    // As in Pi's parallel tool execution: every edit starts at once, and each result passes
    // through `tool_result` as soon as its own edit finishes.
    const results = await Promise.all(
      edits.map(async (edit, index) => {
        const edited = await editTool.execute(`edit-${index}`, {
          path: filePath,
          edits: [edit],
        });
        return harness.runner.emitToolResult({
          ...toolResultEvent("edit", { input: { path: filePath }, details: edited.details }),
          toolCallId: `edit-${index}`,
          content: edited.content,
        });
      }),
    );

    expect(await readFile(filePath, "utf8")).toBe("a = 10\nb = 20\nc = 30\n");
    expect(results.flatMap((result) => formatterNotes(result))).toEqual([
      [
        "Formatted by trim: lines 1–3 changed",
        "@@ -1,3 +1,3 @@",
        "-a = 10  ",
        "-b = 20  ",
        "-c = 30  ",
        "+a = 10",
        "+b = 20",
        "+c = 30",
      ].join("\n"),
    ]);
  });

  test("applies an edit that arrives while a formatter rewrites the same file after the formatter", async () => {
    const harness = await createFormatterHarness({
      formatter: { formatters: { trim: formatterDefinition(["-e", SLOW_TRIM_SCRIPT, "$FILE"]) } },
    });
    const filePath = resolve(harness.cwd, "values.txt");
    const marker = resolve(harness.cwd, "formatter-read");
    await writeFile(filePath, "a = 1  \nb = 2\n");

    const written = harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );
    // The formatter has read the file and is about to overwrite it.
    await waitForPath(marker);
    const edited = await createEditTool(harness.cwd).execute("edit-1", {
      path: filePath,
      edits: [{ oldText: "b = 2", newText: "b = 20" }],
    });

    expect(formatterNotes(await written)).toEqual([
      ["Formatted by trim: line 1 changed", "@@ -1,2 +1,2 @@", "-a = 1  ", "+a = 1", " b = 2"].join(
        "\n",
      ),
    ]);
    // Checked before the edit's own result is formatted, which could otherwise repair a lost edit.
    expect(await readFile(filePath, "utf8")).toBe("a = 1\nb = 20\n");
    const editResult = await harness.runner.emitToolResult({
      ...toolResultEvent("edit", { input: { path: filePath }, details: edited.details }),
      content: edited.content,
    });
    expect(editResult).toBeUndefined();
  });

  test("falls back to the changed-line summary when the diff exceeds the line limit", async () => {
    const script =
      "const fs=require('node:fs');const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,'utf8').replaceAll('x','y'))";
    const harness = await createFormatterHarness({
      formatter: {
        formatters: { rewrite: formatterDefinition(["-e", script, "$FILE"]) },
      },
    });
    const filePath = resolve(harness.cwd, "large.txt");
    await writeFile(filePath, "x\n".repeat(40));

    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", {
        input: { path: filePath },
        details: undefined,
      }),
    );

    expect(lastText(result)).toBe("Formatted by rewrite: lines 1–40 changed");
  });

  test("falls back to the changed-line summary when the diff exceeds the byte limit", async () => {
    const script =
      "const fs=require('node:fs');const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,'utf8').toUpperCase())";
    const harness = await createFormatterHarness({
      formatter: {
        formatters: { upper: formatterDefinition(["-e", script, "$FILE"]) },
      },
    });
    const filePath = resolve(harness.cwd, "wide.txt");
    await writeFile(filePath, `${"a".repeat(4_000)}\n`);

    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", {
        input: { path: filePath },
        details: undefined,
      }),
    );

    expect(lastText(result)).toBe("Formatted by upper: line 1 changed");
  });

  test("shares the diff limits across the files of one mutation result", async () => {
    const script =
      "const fs=require('node:fs');const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,'utf8').replaceAll('x','y'))";
    const harness = await createFormatterHarness({
      formatter: {
        formatters: { rewrite: formatterDefinition(["-e", script, "$FILE"]) },
      },
    });
    const files = ["a.txt", "b.txt", "c.txt"].map((name) => resolve(harness.cwd, name));
    await Promise.all(files.map((file) => writeFile(file, "x\n".repeat(10))));

    const result = await harness.runner.emitToolResult(
      toolResultEvent("apply_patch", {
        input: {},
        details: {
          status: "success",
          result: {
            changedFiles: files,
            createdFiles: [],
            deletedFiles: [],
            movedFiles: [],
          },
        },
      }),
    );

    const text = lastText(result);
    expect(text.split("\n").length).toBeLessThanOrEqual(60 + 3);
    expect(text).toContain("Formatted by rewrite: a.txt: lines 1–10 changed\n@@ -1,10 +1,10 @@");
    expect(text).toContain("Formatted by rewrite: c.txt: lines 1–10 changed");
    expect(text).not.toContain("Formatted by rewrite: c.txt: lines 1–10 changed\n@@");
  });

  test("reports a Workspace Formatter that changed a file, and fixes by a formatter that exits non-zero", async () => {
    const harness = await createFormatterHarness({
      formatter: {
        formatters: {
          workspace: formatterDefinition([
            "-e",
            "require('node:fs').writeFileSync('quiet.txt','changed\\nmore\\n')",
          ]),
          failing: formatterDefinition([
            "-e",
            "const fs=require('node:fs');fs.appendFileSync(process.argv[1],'fixed\\n');process.exit(5)",
            "$FILE",
          ]),
        },
      },
    });
    const filePath = resolve(harness.cwd, "quiet.txt");
    await writeFile(filePath, "original\n");

    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(await readFile(filePath, "utf8")).toBe("changed\nmore\nfixed\n");
    const text = lastText(result);
    expect(text).toContain("Pi Formatter: failing failed");
    expect(text).toContain("\nFormatted by workspace, failing: lines 1–3 changed");
  });

  test.each([
    {
      name: "a syntax error naming the formatted file",
      stderr: (file: string) => `  x Unexpected token\n   ,-[${file}:1:11]`,
      hint: false,
    },
    {
      name: "a syntax error that does not name the formatted file",
      stderr: () => "SyntaxError: Unexpected token (1:11)",
      hint: true,
    },
    {
      name: "ruff's bad configuration error",
      stderr: () =>
        "ruff failed\n  Cause: Failed to parse /x/pyproject.toml\n  Cause: TOML parse error at line 1, column 1",
      hint: true,
    },
    {
      name: "stylua's bad configuration error that names the formatted file",
      stderr: (file: string) =>
        `error: could not format ${file}: Config file not in correct format: TOML parse error`,
      hint: true,
    },
    {
      name: "an unknown option",
      stderr: () => "`--bogus` is not expected in this context",
      hint: true,
    },
  ])("handles the troubleshooting hint for $name", async ({ stderr, hint }) => {
    const harness = await createFormatterHarness({
      formatter: {
        formatters: {
          oxfmt: formatterDefinition([
            "-e",
            "console.error(process.argv[2]);process.exit(2)",
            "$FILE",
            stderr("input.txt"),
          ]),
        },
      },
    });
    const filePath = resolve(harness.cwd, "input.txt");
    await writeFile(filePath, "original");

    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(lastText(result)).toContain("Pi Formatter: oxfmt failed");
    expect(lastText(result).includes(TROUBLESHOOTING_HINT)).toBe(hint);
  });

  test.each([
    {
      name: "a declared signal that the heuristic would not accept",
      stderr: () => "error: Failed to format input",
      pattern: "^error: Failed to format",
      hint: false,
    },
    {
      name: "a declared signal that matches stderr mentioning configuration",
      stderr: (file: string) => `${file}: invalid config near token`,
      pattern: "invalid config near token",
      hint: false,
    },
    {
      name: "a syntax error the declared signal does not match",
      stderr: (file: string) => `  x Unexpected token\n   ,-[${file}:1:11]`,
      pattern: "^error: Failed to parse",
      hint: true,
    },
  ])(
    "replaces the heuristic with a configured syntax-error pattern for $name",
    async ({ stderr, pattern, hint }) => {
      const harness = await createFormatterHarness({
        formatter: {
          formatters: {
            ruff: {
              ...formatterDefinition([
                "-e",
                "console.error(process.argv[2]);process.exit(2)",
                "$FILE",
                stderr("input.txt"),
              ]),
              syntaxErrorPattern: pattern,
            },
          },
        },
      });
      const filePath = resolve(harness.cwd, "input.txt");
      await writeFile(filePath, "original");

      const result = await harness.runner.emitToolResult(
        toolResultEvent("write", { input: { path: filePath }, details: undefined }),
      );

      expect(lastText(result)).toContain("Pi Formatter: ruff failed");
      expect(lastText(result).includes(TROUBLESHOOTING_HINT)).toBe(hint);
    },
  );

  test.each([
    {
      name: "oxfmt syntax error in a file whose source mentions configuration",
      formatter: "oxfmt",
      stderr:
        "  x Unexpected token\n   ,-[vite.config.ts:1:34]\n 1 | export default defineConfig({ a: ,\n   :                                  ^\n   `----\nError occurred when checking code style in the above files.",
      hint: false,
    },
    {
      name: "oxfmt bad configuration file",
      formatter: "oxfmt",
      stderr: "Failed to load configuration file.\nkey must be a string at line 1 column 3",
      hint: true,
    },
    {
      name: "oxfmt with no target file",
      formatter: "oxfmt",
      stderr:
        "Expected at least one target file. All matched files may have been excluded by ignore rules.",
      hint: true,
    },
    {
      name: "ruff syntax error",
      formatter: "ruff-format",
      stderr:
        "error: Failed to parse bad.py:1:7: Expected a parameter or the end of the parameter list",
      hint: false,
    },
    {
      name: "ruff syntax error after warnings",
      formatter: "ruff-format",
      stderr:
        "warning: `incorrect-blank-line-before-class` (D203) and `blank-line-before-class` (D211) are incompatible. Ignoring `incorrect-blank-line-before-class`.\nwarning: The following rule may cause conflicts when used with the formatter: `missing-trailing-comma` (`COM812`).\nerror: Failed to parse bad.py:1:7: Expected a parameter or the end of the parameter list",
      hint: false,
    },
    {
      name: "ruff bad configuration file",
      formatter: "ruff-format",
      stderr:
        "ruff failed\n  Cause: Failed to parse /x/pyproject.toml\n  Cause: TOML parse error at line 1, column 11\n  |\n1 | [tool.ruff\n  |           ^\nunclosed table, expected `]`",
      hint: true,
    },
  ])(
    "applies the README's syntaxErrorPattern to recorded stderr for $name",
    async ({ formatter, stderr, hint }) => {
      const syntaxErrorPattern = (await readmeSyntaxErrorPatterns())[formatter];
      if (syntaxErrorPattern === undefined) throw new Error(`README has no ${formatter} example`);
      const harness = await createFormatterHarness({
        formatter: {
          formatters: {
            [formatter]: {
              ...formatterDefinition([
                "-e",
                "console.error(process.argv[2]);process.exit(2)",
                "$FILE",
                stderr,
              ]),
              syntaxErrorPattern,
            },
          },
        },
      });
      const filePath = resolve(harness.cwd, "input.txt");
      await writeFile(filePath, "original");

      const result = await harness.runner.emitToolResult(
        toolResultEvent("write", { input: { path: filePath }, details: undefined }),
      );

      expect(lastText(result)).toContain(`Pi Formatter: ${formatter} failed`);
      expect(lastText(result).includes(TROUBLESHOOTING_HINT)).toBe(hint);
    },
  );

  test.each([
    {
      name: "a timeout",
      settings: {
        timeoutMs: 25,
        formatters: {
          hanging: {
            ...formatterDefinition([
              "-e",
              "console.error('hang');setInterval(() => {}, 1000)",
              "$FILE",
            ]),
            syntaxErrorPattern: ".*",
          },
        },
      },
    },
    {
      name: "a spawn error",
      settings: {
        formatters: {
          missing: { ...formatterDefinition(["$FILE"]), command: "\0", syntaxErrorPattern: ".*" },
        },
      },
    },
  ])(
    "keeps the troubleshooting hint on $name despite a configured syntax-error pattern",
    async ({ settings }) => {
      const harness = await createFormatterHarness({ formatter: settings });
      const filePath = resolve(harness.cwd, "input.txt");
      await writeFile(filePath, "original");

      const result = await harness.runner.emitToolResult(
        toolResultEvent("write", { input: { path: filePath }, details: undefined }),
      );

      expect(lastText(result)).toContain(TROUBLESHOOTING_HINT);
    },
  );

  test.each([
    {
      name: "a timeout",
      settings: {
        timeoutMs: 25,
        formatters: {
          hanging: formatterDefinition(["-e", "setInterval(() => {}, 1000)", "$FILE"]),
        },
      },
    },
    {
      name: "a spawn error",
      settings: { formatters: { missing: { ...formatterDefinition(["$FILE"]), command: "\0" } } },
    },
  ])("keeps the troubleshooting hint on $name", async ({ settings }) => {
    const harness = await createFormatterHarness({ formatter: settings });
    const filePath = resolve(harness.cwd, "input.txt");
    await writeFile(filePath, "original");

    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(lastText(result)).toContain(TROUBLESHOOTING_HINT);
  });

  test("keeps the hint when a syntax error and another failure are reported together", async () => {
    const syntaxFormatter = formatterDefinition([
      "-e",
      "console.error('SyntaxError: bad in '+require('node:path').basename(process.argv[1]));process.exit(2)",
      "$FILE",
    ]);
    const alone = await createFormatterHarness({
      formatter: { formatters: { syntax: syntaxFormatter } },
    });
    const together = await createFormatterHarness({
      formatter: {
        formatters: {
          syntax: syntaxFormatter,
          broken: formatterDefinition(["-e", "process.exit(3)", "$FILE"]),
        },
      },
    });
    const results = [];
    for (const harness of [alone, together]) {
      const filePath = resolve(harness.cwd, "mixed.txt");
      await writeFile(filePath, "original");
      results.push(
        await harness.runner.emitToolResult(
          toolResultEvent("write", { input: { path: filePath }, details: undefined }),
        ),
      );
    }

    expect(lastText(results[0])).toContain("SyntaxError: bad in mixed.txt");
    expect(lastText(results[0])).not.toContain(TROUBLESHOOTING_HINT);
    expect(lastText(results[1])).toContain("Pi Formatter: broken failed");
    expect(lastText(results[1])).toContain(TROUBLESHOOTING_HINT);
  });

  test("drops the hint for a syntax error in a file whose path mentions configuration", async () => {
    const harness = await createFormatterHarness({
      formatter: {
        formatters: {
          oxfmt: formatterDefinition([
            "-e",
            "console.error(process.argv[2]);process.exit(2)",
            "$FILE",
            "  x Unexpected token\n   ,-[src/config/vite.config.txt:1:11]",
          ]),
        },
      },
    });
    const filePath = resolve(harness.cwd, "src/config/vite.config.txt");
    await mkdir(resolve(harness.cwd, "src/config"), { recursive: true });
    await writeFile(filePath, "original");

    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(lastText(result)).toContain("Unexpected token");
    expect(lastText(result)).not.toContain(TROUBLESHOOTING_HINT);
  });

  test("reports every edited file that a Workspace Formatter rewrites, in mutation order", async () => {
    const harness = await createFormatterHarness({
      formatter: {
        formatters: {
          workspace: {
            command: process.execPath,
            args: [
              "-e",
              "const fs=require('node:fs');fs.writeFileSync('b.txt','B\\n');fs.writeFileSync('a.md','A\\n')",
            ],
            files: { extensions: [".md"] },
          },
        },
      },
    });
    const markdown = resolve(harness.cwd, "a.md");
    const text = resolve(harness.cwd, "b.txt");
    await Promise.all([writeFile(markdown, "a\n"), writeFile(text, "b\n")]);

    const result = await harness.runner.emitToolResult(
      toolResultEvent("apply_patch", {
        input: {},
        details: {
          status: "success",
          result: {
            changedFiles: [text, markdown],
            createdFiles: [],
            deletedFiles: [],
            movedFiles: [],
          },
        },
      }),
    );

    expect(lastText(result)).toBe(
      [
        "Formatted by workspace: a.md: line 1 changed",
        "@@ -1 +1 @@",
        "-a",
        "+A",
        "Formatted by workspace: b.txt: line 1 changed",
        "@@ -1 +1 @@",
        "-b",
        "+B",
      ].join("\n"),
    );
  });

  test("bounds a hanging formatter with the configured timeout", async () => {
    const harness = await createFormatterHarness({
      formatter: {
        timeoutMs: 25,
        formatters: {
          hanging: formatterDefinition(["-e", "setInterval(() => {}, 1000)", "$FILE"]),
        },
      },
    });
    const filePath = resolve(harness.cwd, "timeout.txt");
    await writeFile(filePath, "original");

    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(result?.content?.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringMatching(
        /Pi Formatter: hanging failed .*timeout\.txt \(timeout after 25ms\)/,
      ),
    });
  });

  test("reports quarantined settings and skips vanished files", async () => {
    const harness = await createFormatterHarness({
      formatter: {
        unknownField: true,
        formatters: { valid: formatterDefinition(["-e", "process.exit(9)", "$FILE"]) },
      },
    });
    const vanished = resolve(harness.cwd, "vanished.txt");

    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: vanished }, details: undefined }),
    );

    expect(result).toBeUndefined();
    expect(harness.notifications).toEqual([
      expect.stringContaining("global formatter.unknownField"),
    ]);
    expect(harness.notifications[0]).toContain("Run /skill:pi-formatter to diagnose.");
  });
});
