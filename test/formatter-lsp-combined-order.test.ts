/**
 * Combined-mode test: Pi Formatter and Pi LSP loaded together as the Git collection loads them.
 *
 * Why this lives at the repository root: a package-level test's Turborepo cache key cannot see the
 * other package's source, so a change in one package would replay a stale pass. The root
 * `//#test:root` task lists both packages (and pi-utils) as inputs. Neither package may depend on
 * the other at runtime, and a `workspace:*` devDependency would put one in the other's published
 * manifest and the lockfile for the sake of a test. A root test needs no manifest change, loads both
 * packages the way the collection does (by the entrypoint paths in the root `package.json`
 * `pi.extensions`), and runs through `pnpm verify` with the shared `vitest.config.ts`.
 *
 * What it pins: Pi chains `tool_result` handlers in extension load order, and the collection loads
 * pi-formatter before pi-lsp. A mutation result therefore carries, in order, the original tool
 * result, the `Formatted by <id>: …` line, and Post-edit Diagnostics computed on the formatted
 * file. The fake formatter prepends a header line, so a diagnostic's line and message show which
 * content the language server saw. The swapped order is asserted too, to document what changes if
 * the collection order is reversed. Parallel edits to one file in one tool batch pin that formatting
 * waits in Pi's file mutation queue without deadlocking Pi's own tool execution, and keeps the order.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
  type Context,
  type JsonObject,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import rootManifest from "../package.json" with { type: "json" };

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fakeServerPath = fileURLToPath(new URL("fixtures/fake-lsp-server.mjs", import.meta.url));
const fakeFormatterPath = fileURLToPath(new URL("fixtures/fake-formatter.mjs", import.meta.url));

const FORMATTER_ENTRYPOINT = "./packages/pi-formatter/src/index.ts";
const LSP_ENTRYPOINT = "./packages/pi-lsp/src/index.ts";

/** The two extensions in the order the root `package.json` lists them, which Pi loads in. */
const collectionOrder = rootManifest.pi.extensions.filter(
  (entrypoint) => entrypoint === FORMATTER_ENTRYPOINT || entrypoint === LSP_ENTRYPOINT,
);
const swappedOrder = collectionOrder.toReversed();

const SOURCE = "const   oldName   =   1;\n// TODO later\n";

const directories: string[] = [];
const sessions: AgentSession[] = [];

/**
 * Pi compiles an extension's TypeScript with jiti when it loads it, and jiti caches the output on
 * disk under the OS temporary directory. A fresh CI runner starts with an empty cache, so the first
 * load of pi-formatter and pi-lsp compiles every source file of both: about 2 s on an idle machine,
 * and past the 20 s test timeout under a cold `pnpm verify`. Every other step of a test, including the fake
 * language server's start, takes well under a second. Loading both once here keeps that one-time
 * cost out of the first test; each test still loads them afresh, from the cache. The hook timeout
 * only guards against a hang.
 */
beforeAll(async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-formatter-lsp-warm-up-")));
  try {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: collectionOrder.map((entrypoint) =>
        resolve(repositoryRoot, entrypoint),
      ),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const session of sessions.splice(0)) {
    // `dispose` does not emit `session_shutdown`; without it Pi LSP leaks its session directory
    // and leaves the fake language server running.
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type ToolName = "edit" | "lsp_apply";
/** A mutation tool, or `parallel_edit`: three `edit` calls to one file in one tool batch. */
type Scenario = ToolName | "parallel_edit";
type ScriptedResponse = (context: Context) => AssistantMessage;

interface ContentBlockSummary {
  readonly type: string;
  readonly text: string;
}

interface MutationRun {
  /** The newest result of the scenario's tool; for `parallel_edit`, the first edit's result. */
  readonly blocks: readonly ContentBlockSummary[];
  /** Every result of the scenario's tool in the final model request, in tool-call order. */
  readonly results: readonly (readonly ContentBlockSummary[])[];
  readonly file: string;
  readonly filePath: string;
}

/** The content blocks of every tool result the model received for a tool; `text` is empty for non-text blocks. */
function resultBlocks(
  context: Context,
  toolName: string,
): readonly (readonly ContentBlockSummary[])[] {
  const results = context.messages.flatMap((message) =>
    message.role === "toolResult" && message.toolName === toolName
      ? [
          message.content.map((block) => ({
            type: block.type,
            text: block.type === "text" ? block.text : "",
          })),
        ]
      : [],
  );
  if (results.length === 0) throw new Error(`No ${toolName} tool result`);
  return results;
}

const PreviewDetailsSchema = Type.Object({ preview_id: Type.String() });

function previewIdOf(context: Context): string {
  const message = context.messages.findLast(
    (candidate) => candidate.role === "toolResult" && candidate.toolName === "lsp_rename",
  );
  if (message?.role !== "toolResult" || !Value.Check(PreviewDetailsSchema, message.details)) {
    throw new Error("lsp_rename result has no preview_id");
  }
  return message.details.preview_id;
}

/**
 * Run one model-driven mutation in a real Pi session that loads the packages' entrypoints in the
 * given order. The model stream is the only scripted collaborator; the formatter and the language
 * server are fake child processes configured through Pi settings.
 */
async function runMutation(scenario: Scenario, order: readonly string[]): Promise<MutationRun> {
  const toolName: ToolName = scenario === "parallel_edit" ? "edit" : scenario;
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-formatter-lsp-combined-")));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      formatter: {
        formatters: {
          fakefmt: {
            command: process.execPath,
            args: [fakeFormatterPath, "$FILE"],
            files: { extensions: [".ts"] },
          },
        },
      },
      lsp: {
        timeouts: { diagnosticsMs: 5_000, initializeMs: 10_000, shutdownMs: 1_000 },
        servers: {
          fakelsp: {
            command: process.execPath,
            args: [fakeServerPath],
            languages: [{ extensions: [".ts"], languageId: "typescript" }],
          },
        },
      },
    }),
  );
  // Both default exports read their settings from Pi's agent directory when the session starts.
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const filePath = join(cwd, "source.ts");
  await writeFile(filePath, SOURCE);

  const model = getModel("deepseek", "deepseek-flash");
  if (model === undefined) throw new Error("Missing pinned DeepSeek model");
  const settings = SettingsManager.inMemory({ retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    additionalExtensionPaths: order.map((entrypoint) => resolve(repositoryRoot, entrypoint)),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) =>
        pi.registerProvider("deepseek", {
          api: "openai-completions",
          models: [model],
          streamSimple() {
            throw new Error("Unexpected direct provider request");
          },
        }),
    ],
    systemPromptOverride: () => "Mutate the file.",
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  // Pi chains tool_result handlers in this load order, so assert it rather than mere presence.
  const expectedPaths = order.map((entrypoint) => resolve(repositoryRoot, entrypoint));
  expect(
    loader
      .getExtensions()
      .extensions.map(({ path }) => path)
      .filter((path) => expectedPaths.includes(path)),
  ).toEqual(expectedPaths);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: join(cwd, "models.json"),
    allowModelNetwork: false,
  });
  await modelRuntime.setRuntimeApiKey("deepseek", "TEST-NOT-A-REAL-KEY");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: settings,
  });
  sessions.push(session);

  const toolUse = (name: string, input: JsonObject): ScriptedResponse => {
    return () => fauxAssistantMessage(fauxToolCall(name, input), { stopReason: "toolUse" });
  };
  const done: ScriptedResponse = () => fauxAssistantMessage("Done.");
  const edit = (oldText: string, newText: string) =>
    fauxToolCall("edit", { path: filePath, edits: [{ oldText, newText }] });
  const scripts = {
    edit: () => [
      () => fauxAssistantMessage(edit("=   1;", "=   2;"), { stopReason: "toolUse" }),
      done,
    ],
    lsp_apply: () => [
      toolUse("lsp_rename", { file_path: filePath, line: 1, character: 9, new_name: "newName" }),
      (context) =>
        fauxAssistantMessage(fauxToolCall("lsp_apply", { preview_id: previewIdOf(context) }), {
          stopReason: "toolUse",
        }),
      done,
    ],
    parallel_edit: () => [
      () =>
        fauxAssistantMessage(
          [
            edit("const   oldName", "let   oldName"),
            edit("=   1;", "=   2;"),
            edit("TODO later", "TODO   sooner"),
          ],
          { stopReason: "toolUse" },
        ),
      done,
    ],
  } satisfies Record<Scenario, () => ScriptedResponse[]>;
  const responses = scripts[scenario]();
  let results: readonly (readonly ContentBlockSummary[])[] | undefined;
  session.agent.streamFunction = (currentModel, context) => {
    const scripted = responses.shift();
    if (scripted === undefined) throw new Error("Unexpected model request");
    if (responses.length === 0) results = resultBlocks(context, toolName);
    const next = scripted(context);
    const message: AssistantMessage = {
      ...next,
      api: currentModel.api,
      provider: currentModel.provider,
      model: currentModel.id,
    };
    const reason = message.stopReason;
    if (reason === "pending" || reason === "error" || reason === "aborted") {
      throw new Error("Scripted response must finish normally");
    }
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.push({ type: "done", reason, message }));
    return stream;
  };
  await session.bindExtensions({ mode: "rpc" });
  await session.prompt("Mutate it");
  const blocks = scenario === "parallel_edit" ? results?.[0] : results?.at(-1);
  if (results === undefined || blocks === undefined) {
    throw new Error("The session never reached its final model request");
  }
  return { blocks, results, file: await readFile(filePath, "utf8"), filePath };
}

const DIAGNOSTICS_HEADING = "\n\nLSP diagnostics\n";

/** The original result of each tool for the scripted mutation, with the random preview id masked. */
function expectedOriginalResult(toolName: ToolName, filePath: string): string {
  return toolName === "edit"
    ? `Successfully replaced 1 block(s) in ${filePath}.`
    : "Applied Workspace Edit Preview <preview_id>:\nmodified source.ts";
}

/** Result text per content block, in order, with the `lsp_apply` preview id masked. */
function orderedTexts(run: MutationRun): string[] {
  return run.blocks.map(({ text }) =>
    text.replace(
      /^Applied Workspace Edit Preview [^:]+:/,
      "Applied Workspace Edit Preview <preview_id>:",
    ),
  );
}

/** Where the fake server's diagnostic lies: line 3 of the formatted file, line 2 before it. */
const formattedDiagnostic = `${DIAGNOSTICS_HEADING}source.ts:3:1 warning [fakelsp]: TODO left in formatted source`;
const unformattedDiagnostic = `${DIAGNOSTICS_HEADING}source.ts:2:1 warning [fakelsp]: TODO left in unformatted source`;

const formattedFiles = {
  edit: "// formatted\nconst oldName = 2;\n// TODO later\n",
  lsp_apply: "// formatted\nconst newName = 1;\n// TODO later\n",
} satisfies Record<ToolName, string>;

/** The formatter line with its unified diff, which lets the next `edit` match the formatted file. */
const formatterNotes = {
  edit: [
    "Formatted by fakefmt: lines 1–2 changed",
    "@@ -1,2 +1,3 @@",
    "-const   oldName   =   2;",
    "+// formatted",
    "+const oldName = 2;",
    " // TODO later",
  ].join("\n"),
  lsp_apply: [
    "Formatted by fakefmt: lines 1–2 changed",
    "@@ -1,2 +1,3 @@",
    "-const   newName   =   1;",
    "+// formatted",
    "+const newName = 1;",
    " // TODO later",
  ].join("\n"),
} satisfies Record<ToolName, string>;

describe("Pi Formatter and Pi LSP loaded as the Git collection loads them", () => {
  test("the collection loads pi-formatter before pi-lsp", () => {
    expect(collectionOrder).toEqual([FORMATTER_ENTRYPOINT, LSP_ENTRYPOINT]);
  });

  test.each<ToolName>(["edit", "lsp_apply"])(
    "%s: tool result, formatter line, then Post-edit Diagnostics of the formatted file",
    async (toolName) => {
      const run = await runMutation(toolName, collectionOrder);
      expect(run.file).toBe(formattedFiles[toolName]);
      expect(run.blocks.map(({ type }) => type)).toEqual(["text", "text", "text"]);
      expect(orderedTexts(run)).toEqual([
        expectedOriginalResult(toolName, run.filePath),
        formatterNotes[toolName],
        formattedDiagnostic,
      ]);
    },
  );

  // Pi runs the edits of one batch concurrently, and each result's `tool_result` handlers as soon as
  // its own edit finishes. Pi Formatter formats inside Pi's file mutation queue, so it formats once
  // every edit has landed and its diff shows only the formatter's changes.
  test("parallel edits to one file: one formatter line with only formatter changes, and Post-edit Diagnostics of the formatted file on every result", async () => {
    const run = await runMutation("parallel_edit", collectionOrder);
    expect(run.file).toBe("// formatted\nlet oldName = 2;\n// TODO sooner\n");
    const original = expectedOriginalResult("edit", run.filePath);
    const formatterNote = [
      "Formatted by fakefmt: lines 1–3 changed",
      "@@ -1,2 +1,3 @@",
      "-let   oldName   =   2;",
      "-// TODO   sooner",
      "+// formatted",
      "+let oldName = 2;",
      "+// TODO sooner",
    ].join("\n");
    const texts = run.results.map((blocks) => blocks.map(({ text }) => text));
    // Which result carries the formatter line depends on which handler takes the queue first.
    expect(texts.flat().filter((text) => text.startsWith("Formatted by"))).toEqual([formatterNote]);
    expect(texts).toContainEqual([original, formatterNote, formattedDiagnostic]);
    expect(texts.filter((blocks) => !blocks.includes(formatterNote))).toEqual([
      [original, formattedDiagnostic],
      [original, formattedDiagnostic],
    ]);
  });

  // Documents the failure mode the collection order prevents: with pi-lsp first, diagnostics come
  // from the pre-format file and precede the formatter line, so line numbers disagree with disk.
  test.each<ToolName>(["edit", "lsp_apply"])(
    "%s with the order swapped: tool result, Post-edit Diagnostics of the unformatted file, then formatter line",
    async (toolName) => {
      const run = await runMutation(toolName, swappedOrder);
      expect(run.file).toBe(formattedFiles[toolName]);
      expect(run.blocks.map(({ type }) => type)).toEqual(["text", "text", "text"]);
      expect(orderedTexts(run)).toEqual([
        expectedOriginalResult(toolName, run.filePath),
        unformattedDiagnostic,
        formatterNotes[toolName],
      ]);
    },
  );
});
