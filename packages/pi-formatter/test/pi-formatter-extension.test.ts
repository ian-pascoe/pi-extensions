import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type SessionStartEvent,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { createPiFormatterExtension } from "../src/pi-formatter-extension.js";
import type { FormatterSettingsDocumentInput } from "../src/pi-formatter-settings.js";
import { TROUBLESHOOTING_HINT } from "../src/troubleshooting-skill.js";

const temporaryDirectories: string[] = [];

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
      text: expect.stringContaining(
        "Formatted by perFile: first.txt: line 1 changed\nFormatted by perFile: second.txt: line 1 changed",
      ),
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
      { type: "text", text: "Formatted by uppercase: line 1 changed" },
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
      text: "Formatted by first, second: lines 2–6 changed",
    });
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

  test("reports changes made by a formatter that timed out", async () => {
    const harness = await createFormatterHarness({
      formatter: {
        timeoutMs: 200,
        formatters: {
          slow: formatterDefinition([
            "-e",
            "require('node:fs').writeFileSync(process.argv[1],'partial');setInterval(() => {}, 1000)",
            "$FILE",
          ]),
        },
      },
    });
    const filePath = resolve(harness.cwd, "slow.txt");
    await writeFile(filePath, "original");

    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(lastText(result)).toContain("timeout after 200ms");
    expect(lastText(result)).toContain("Formatted by slow: line 1 changed");
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
    const harness = await createFormatterHarness({
      formatter: {
        formatters: {
          syntax: formatterDefinition([
            "-e",
            "console.error('SyntaxError: bad');process.exit(2)",
            "$FILE",
          ]),
          broken: formatterDefinition(["-e", "process.exit(3)", "$FILE"]),
        },
      },
    });
    const filePath = resolve(harness.cwd, "mixed.txt");
    await writeFile(filePath, "original");

    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(lastText(result)).toContain(TROUBLESHOOTING_HINT);
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
