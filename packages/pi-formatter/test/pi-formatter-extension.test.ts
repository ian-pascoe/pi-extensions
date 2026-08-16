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
        factory: createPiFormatterExtension({ getAgentDirectory: () => agentDirectory }),
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

    expect(result).toBeUndefined();
    expect(await readFile(first, "utf8")).toBe("one:formatted");
    expect(await readFile(second, "utf8")).toBe("two:formatted");
    expect(await readFile(resolve(harness.cwd, "workspace-runs"), "utf8")).toBe("1");
  });

  test.each([
    ["edit", (path: string) => ({ input: { path }, details: undefined })],
    ["write", (path: string) => ({ input: { path }, details: undefined })],
    [
      "lsp apply",
      (path: string) => ({
        input: {
          operation: "apply",
          mutation_manifest: [{ operation: "modify", path }],
        },
        details: { kind: "workspace_edit_apply", state: "applied", changed_paths: [path] },
      }),
    ],
  ])("formats successful %s mutations", async (name, eventForPath) => {
    const script =
      "const fs=require('node:fs');const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,'utf8').toUpperCase())";
    const harness = await createFormatterHarness({
      formatter: { formatters: { uppercase: formatterDefinition(["-e", script, "$FILE"]) } },
    });
    const filePath = resolve(harness.cwd, `${basename(name)}.txt`);
    await writeFile(filePath, "format me");
    const event = eventForPath(filePath);

    await harness.runner.emitToolResult(
      toolResultEvent(name === "lsp apply" ? "lsp" : name, event),
    );

    expect(await readFile(filePath, "utf8")).toBe("FORMAT ME");
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
    expect(await readFile(filePath, "utf8")).toBe("original:continued");
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
  });
});
