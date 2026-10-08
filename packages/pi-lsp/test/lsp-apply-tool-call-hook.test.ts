import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { createPiLspExtension } from "../src/pi-lsp-extension.js";
import { LspWorkspaceEditStore } from "../src/lsp-workspace-edit.js";

const directories: string[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface ApplyFixture {
  readonly filePath: string;
  readonly previewId: string;
  readonly session: AgentSession;
  readonly seen: ToolCallEvent[];
  /** Tool results as the model receives them, keyed by tool name. */
  readonly toolResults: { readonly toolName: string; readonly isError: boolean }[];
}

/**
 * A real Pi session whose history holds a `lsp_rename` Workspace Edit Preview, so `lsp_apply` is
 * executable offline. The only scripted collaborator is the model stream.
 */
async function createApplyFixture(
  onToolCall: (event: ToolCallEvent) => { block: true; reason: string } | undefined,
  extraArguments: Record<string, null> = {},
): Promise<ApplyFixture> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lsp-apply-hook-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  const filePath = join(cwd, "source.ts");
  await writeFile(filePath, "before\n");
  const previews = new LspWorkspaceEditStore({ createPreviewId: () => "hook-preview" });
  const preview = await previews.createPreview({
    edit: {
      changes: {
        [pathToFileURL(filePath).href]: [
          {
            newText: "after",
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
          },
        ],
      },
    },
    serverId: "typescript",
  });
  const sessionManager = SessionManager.create(cwd, cwd);
  sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "rename-call",
    toolName: "lsp_rename",
    content: [{ type: "text", text: `Workspace Edit Preview ${preview.preview_id}` }],
    details: {
      kind: "workspace_edit_preview",
      preview_id: preview.preview_id,
      operation: "rename",
      summary: preview.summary,
      mutation_manifest: [{ operation: "modify", path: filePath }],
      preview_record: preview,
      state: "available",
    },
    isError: false,
    timestamp: Date.now(),
  });

  const model = getModel("deepseek", "deepseek-flash");
  if (model === undefined) throw new Error("Missing pinned DeepSeek model");
  const seen: ToolCallEvent[] = [];
  const hook: ExtensionFactory = (pi) => {
    pi.on("tool_call", (event) => {
      seen.push(structuredClone(event));
      return onToolCall(event);
    });
  };
  const settings = SettingsManager.inMemory({ retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      createPiLspExtension({ getAgentDirectory: () => agentDir }),
      hook,
      (pi) =>
        pi.registerProvider("deepseek", {
          api: "openai-completions",
          models: [model],
          streamSimple() {
            throw new Error("Unexpected direct provider request");
          },
        }),
    ],
    systemPromptOverride: () => "Apply the preview.",
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
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
    sessionManager,
    settingsManager: settings,
    noTools: "builtin",
  });
  sessions.push(session);

  const responses: AssistantMessage[] = [
    fauxAssistantMessage(
      fauxToolCall("lsp_apply", { preview_id: preview.preview_id, ...extraArguments }),
      {
        stopReason: "toolUse",
      },
    ),
    fauxAssistantMessage("Done."),
  ];
  const toolResults: ApplyFixture["toolResults"][number][] = [];
  session.agent.streamFunction = (currentModel, context) => {
    for (const message of context.messages) {
      if (message.role === "toolResult" && message.toolName === "lsp_apply") {
        toolResults.push({ toolName: message.toolName, isError: message.isError });
      }
    }
    const next = responses.shift();
    if (next === undefined) throw new Error("Unexpected model request");
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
  return { filePath, previewId: preview.preview_id, session, seen, toolResults };
}

test("a tool_call hook observes the canonical Mutation Manifest of a model lsp_apply call", async () => {
  const fixture = await createApplyFixture(() => undefined);
  await fixture.session.prompt("Apply it");

  const applyCalls = fixture.seen.filter((event) => event.toolName === "lsp_apply");
  expect(applyCalls).toHaveLength(1);
  // The model supplied only preview_id; Pi ran prepareArguments before the hook.
  expect(applyCalls[0]?.input).toEqual({
    preview_id: fixture.previewId,
    mutation_manifest: [{ operation: "modify", path: fixture.filePath }],
  });
  expect(await readFile(fixture.filePath, "utf8")).toBe("after\n");
  expect(fixture.toolResults.at(-1)).toEqual({ toolName: "lsp_apply", isError: false });
});

test("a null mutation_manifest is treated as omitted, so the hook still sees the canonical one", async () => {
  const fixture = await createApplyFixture(() => undefined, { mutation_manifest: null });
  await fixture.session.prompt("Apply it");

  const applyCalls = fixture.seen.filter((event) => event.toolName === "lsp_apply");
  expect(applyCalls).toHaveLength(1);
  expect(applyCalls[0]?.input).toEqual({
    preview_id: fixture.previewId,
    mutation_manifest: [{ operation: "modify", path: fixture.filePath }],
  });
  expect(await readFile(fixture.filePath, "utf8")).toBe("after\n");
  expect(fixture.toolResults.at(-1)).toEqual({ toolName: "lsp_apply", isError: false });
});

test("a tool_call hook can block lsp_apply and leave the file unchanged", async () => {
  const fixture = await createApplyFixture((event) =>
    event.toolName === "lsp_apply" ? { block: true, reason: "Denied by policy" } : undefined,
  );
  await fixture.session.prompt("Apply it");

  expect(fixture.seen.filter((event) => event.toolName === "lsp_apply")).toHaveLength(1);
  expect(await readFile(fixture.filePath, "utf8")).toBe("before\n");
  expect(fixture.toolResults.at(-1)).toEqual({ toolName: "lsp_apply", isError: true });
});
