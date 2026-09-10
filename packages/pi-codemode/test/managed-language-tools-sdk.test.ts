import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  type AgentSession,
  type ExtensionFactory,
  type ExtensionAPI,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ToolInstaller as Installer } from "../../pi-tool-installer/dist/index.js";
import type { CodeModeJsonValue } from "../src/codemode-tool-contract.js";
import piCodeModeExtension from "../src/pi-codemode-extension.js";
import {
  serializeAnthropicContext,
  serializeAnthropicRequest,
} from "./fixtures/serialize-anthropic-request.js";

// Replace only the external acquisition executable, never the installer or extensions.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const directories: string[] = [];
const sessions: AgentSession[] = [];
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
type Mode = "lsp" | "formatter" | "dap" | "combined" | "codemode-only" | "direct-and-codemode";
type Payload = Awaited<ReturnType<typeof serializeAnthropicRequest>>;

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network in SDK proof")));
  const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawn).mockImplementation((command, args, options) =>
    ["mise", "mise.exe"].includes(basename(String(command)))
      ? original.spawn(
          process.execPath,
          [
            fileURLToPath(new URL("fixtures/managed-mise.cjs", import.meta.url)),
            ...(args ?? []).slice(2),
          ],
          options ?? {},
        )
      : original.spawn(command, args ?? [], options ?? {}),
  );
});

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }),
    ),
  );
});

async function createFixture(mode: Mode) {
  const directory = await mkdtemp(join(tmpdir(), "pi-managed SDK-é-"));
  directories.push(directory);
  const cwd = join(directory, "project");
  const agentDir = join(directory, "agent");
  const store = join(agentDir, "managed-tools");
  const combined = ["combined", "codemode-only", "direct-and-codemode"].includes(mode);
  const codeMode = mode === "codemode-only" || mode === "direct-and-codemode";
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(store, { recursive: true });
  await writeFile(join(cwd, ".pi/settings.json"), "{}");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify(codeMode ? { codemode: { tools: [{ pattern: "*", exposure: mode }] } } : {}),
  );
  await writeFile(join(store, process.platform === "win32" ? "mise.exe" : "mise"), "fixture");
  await writeFile(
    join(store, "fixture.json"),
    JSON.stringify({
      server: new URL("../../pi-lsp/test/fixtures/fake-lsp-server.mjs", import.meta.url).href,
      adapter: new URL("../../pi-dap/test/fixtures/fake-managed-js-adapter.mjs", import.meta.url)
        .href,
      dapFixture: fileURLToPath(
        new URL("../../pi-dap/test/fixtures/fake-dap-session-adapter.mjs", import.meta.url),
      ),
    }),
  );
  const factories: ExtensionFactory[] = [];
  // Dynamic sibling imports preserve the package's source-TS rootDir boundary.
  if (mode === "formatter" || combined) {
    const {
      createPiFormatterExtension,
    }: {
      createPiFormatterExtension: (getAgentDirectory: () => string) => ExtensionFactory;
    } = await import(
      new URL("../../pi-formatter/src/pi-formatter-extension.js", import.meta.url).href
    );
    factories.push(createPiFormatterExtension(() => agentDir));
  }
  if (mode === "lsp" || combined) {
    const {
      createPiLspExtension,
    }: {
      createPiLspExtension: (options: { getAgentDirectory: () => string }) => ExtensionFactory;
    } = await import(new URL("../../pi-lsp/src/pi-lsp-extension.js", import.meta.url).href);
    factories.push(createPiLspExtension({ getAgentDirectory: () => agentDir }));
  }
  if (mode === "dap" || combined) {
    const {
      createPiDapExtension,
    }: {
      createPiDapExtension: (getAgentDirectory: () => string) => ExtensionFactory;
    } = await import(new URL("../../pi-dap/src/pi-dap-extension.js", import.meta.url).href);
    factories.push(createPiDapExtension(() => agentDir));
  }
  if (combined) {
    const {
      createMinimalSubagentsExtension,
    }: {
      createMinimalSubagentsExtension: () => ExtensionFactory;
    } = await import(
      new URL("../../pi-minimal-subagents/src/minimal-subagents-extension.js", import.meta.url).href
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    factories.push(createMinimalSubagentsExtension());
  }
  if (codeMode) factories.push(piCodeModeExtension);
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: factories,
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey("anthropic", "offline-sdk-fixture");
  const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Inspect this project without changing prior context." }],
    timestamp: 0,
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager,
    modelRuntime,
    model: getModel("anthropic", "claude-sonnet-4-5"),
  });
  sessions.push(session);
  const progress: string[] = [];
  const errors: string[] = [];
  session.extensionRunner.onError((error) => errors.push(error.error));
  await session.bindExtensions({
    mode: "rpc",
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify: (message) => progress.push(message),
      setStatus: (_key, message) => {
        if (message) progress.push(message);
      },
    },
  });
  expect(errors).toEqual([]);
  const { ToolInstaller }: { ToolInstaller: typeof Installer } = await import(
    new URL("../../pi-tool-installer/dist/index.js", import.meta.url).href
  );
  return { cwd, agentDir, session, progress, installer: new ToolInstaller(store) };
}

function call(name: string, args: Record<string, CodeModeJsonValue>): ToolCall {
  return { type: "toolCall", id: `managed-${name}`, name, arguments: args };
}

function assistantResponse(calls?: ToolCall[]): AssistantMessage {
  return {
    role: "assistant",
    content: calls ?? [{ type: "text", text: "Finished." }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage,
    stopReason: calls ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

async function perform(session: AgentSession, calls: ToolCall[], nextCalls?: ToolCall[]) {
  const payloads: Payload[] = [];
  // Fake only model responses. Pi owns the complete tool loop, middleware and durable history.
  session.agent.streamFunction = async (_model, context) => {
    payloads.push(await serializeAnthropicRequest(session, context.messages));
    const batch = payloads.length === 1 ? calls : payloads.length === 2 ? nextCalls : undefined;
    const message = assistantResponse(batch);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: batch ? "toolUse" : "stop", message });
    stream.end();
    return stream;
  };
  await session.prompt("Perform the requested operation.");
  expect(payloads).toHaveLength(nextCalls ? 3 : 2);
  expectStablePrefix(payloads[0]!, payloads.at(-1)!);
  const results = session.messages.filter((message) => message.role === "toolResult");
  expect(results).toHaveLength(calls.length + (nextCalls?.length ?? 0));
  for (const result of results) expect(result.isError, JSON.stringify(result.content)).toBe(false);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  return results;
}

function expectStablePrefix(before: Payload, after: Payload) {
  expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
  expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
  expect(before.messages.length).toBeGreaterThan(0);
  expect(after.messages.length).toBeGreaterThan(before.messages.length);
  const withoutCacheMarkers = (messages: typeof before.messages) =>
    messages.map(({ role, content }) => ({
      role,
      content: content.map(({ cache_control: _cache, ...block }) => block),
    }));
  expect(JSON.stringify(withoutCacheMarkers(after.messages.slice(0, before.messages.length)))).toBe(
    JSON.stringify(withoutCacheMarkers(before.messages)),
  );
}

test.each(["combined", "codemode-only", "direct-and-codemode"] as const)(
  "%s preserves the serialized prefix while concurrent tools acquire, format before diagnostics and coexist with Subagents",
  async (mode) => {
    vi.stubEnv("PATH", "");
    vi.stubEnv("FAKE_DIAGNOSTICS", "document");
    const fixture = await createFixture(mode);
    await writeFile(join(fixture.cwd, ".prettierrc"), "{}");
    await writeFile(join(fixture.cwd, "app.mjs"), "console.log('debuggee');\n");
    const ids = ["formatter-prettier", "lsp-typescript", "dap-javascript"];
    for (const id of ids) expect(await fixture.installer.installed(id)).toBeUndefined();
    for (const name of ["write", "lsp", "dap", "subagent_status"])
      expect(fixture.session.getActiveToolNames().includes(name)).toBe(mode !== "codemode-only");
    const write = { path: "source.ts", content: "export const answer = 42;\n" };
    const debug = { operation: "launch", program: "app.mjs" };
    const nested = `return await Promise.all([tools.write(${JSON.stringify(write)}), tools.dap(${JSON.stringify(debug)}), tools.subagent_status({})]);`;
    const calls =
      mode === "combined"
        ? [call("write", write), call("dap", debug), call("subagent_status", {})]
        : mode === "codemode-only"
          ? [call("codemode_execute", { script: nested, wait: true })]
          : [
              call("write", write),
              call("codemode_execute", {
                script: `return await Promise.all([tools.dap(${JSON.stringify(debug)}), tools.subagent_status({})]);`,
                wait: true,
              }),
            ];
    const results = await perform(fixture.session, calls);
    const formatted = "export const answer = 42;\n// formatted-by-managed-prettier\n";
    expect(await readFile(join(fixture.cwd, "source.ts"), "utf8")).toBe(formatted);
    // This diagnostic is the actual text seen by the external LSP, not a middleware-order spy.
    expect(JSON.stringify(results)).toContain("formatted-by-managed-prettier");
    for (const id of ids) expect(await fixture.installer.installed(id)).toBeDefined();
    if (mode === "combined") {
      expect(results[1]?.details).toMatchObject({ state: "stopped", profile_id: "javascript" });
      expect(results[2]?.details).toMatchObject({ agents: [] });
    } else {
      expect(results.at(-1)?.details).toMatchObject({ result: "success" });
      expect(JSON.stringify(results.at(-1)?.details)).toContain('"state":"stopped"');
      expect(JSON.stringify(results.at(-1)?.details)).toContain('"agents":[]');
    }
  },
  30_000,
);

test("a real Child Agent acquires an LSP within its Launch Contract and shares it with the root", async () => {
  vi.stubEnv("PATH", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "offline-child-fixture");
  vi.stubEnv("FAKE_DIAGNOSTICS", "document");
  const fixture = await createFixture("combined");
  await writeFile(join(fixture.cwd, "child.ts"), "export const childAnswer = 42;\n");
  await writeFile(join(fixture.cwd, "root.ts"), "export const rootAnswer = 7;\n");
  const childPayloads: Payload[] = [];
  const childToolNames: string[][] = [];
  const rootStarted = Promise.withResolvers<void>();
  let rootLspActive = false;
  let overlappingCalls = false;
  fixture.session.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName === "lsp") {
      rootLspActive = true;
      rootStarted.resolve();
    }
    if (event.type === "tool_execution_end" && event.toolName === "lsp") rootLspActive = false;
  });
  const {
    createPiLspExtension,
  }: {
    createPiLspExtension: (options: { getAgentDirectory: () => string }) => ExtensionFactory;
  } = await import(new URL("../../pi-lsp/src/pi-lsp-extension.js", import.meta.url).href);
  // A configured extension is discovered by the real child resource loader. The
  // closure keeps the existing external-process fixture shared with the parent.
  vi.stubGlobal("managedChildExtension", async (pi: ExtensionAPI) => {
    await createPiLspExtension({ getAgentDirectory: () => fixture.agentDir })(pi);
    pi.on("tool_execution_start", (event) => {
      if (event.toolName === "lsp") overlappingCalls = rootLspActive;
    });
    pi.registerProvider("anthropic", {
      api: "anthropic-messages",
      apiKey: "offline-child-fixture",
      streamSimple: (_model, context) => {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          childToolNames.push((context.tools ?? []).map(({ name }) => name));
          childPayloads.push(await serializeAnthropicContext(context));
          const first = childPayloads.length === 1;
          // Hold only the fake LLM response: root and child tool lifetimes overlap.
          if (first) await rootStarted.promise;
          const message = assistantResponse(
            first
              ? [
                  call("lsp", {
                    operation: "diagnostics",
                    file_path: "child.ts",
                  }),
                ]
              : undefined,
          );
          stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
          stream.end();
        })().catch((error) => {
          stream.push({
            type: "error",
            reason: "error",
            error: {
              ...assistantResponse(),
              stopReason: "error",
              errorMessage: String(error),
            },
          });
          stream.end();
        });
        return stream;
      },
    });
  });
  const childExtension = join(fixture.agentDir, "child-extension.mjs");
  await writeFile(childExtension, "export default (pi) => globalThis.managedChildExtension(pi);\n");
  await writeFile(
    join(fixture.agentDir, "settings.json"),
    JSON.stringify({ extensions: [childExtension] }),
  );
  expect(await fixture.installer.installed("lsp-typescript")).toBeUndefined();
  const results = await perform(
    fixture.session,
    [
      call("subagent", {
        agent_id: "language-child",
        task: "Read diagnostics for child.ts with the LSP tool.",
        tools: ["lsp"],
        session_context: "omit",
        project_context: "omit",
        delegation: "none",
      }),
    ],
    [
      call("lsp", { operation: "diagnostics", file_path: "root.ts" }),
      call("subagent_wait", { agent_id: "language-child", timeout_ms: 10_000 }),
    ],
  );
  expect(results[0]?.details).toMatchObject({ status: "running" });
  expect(results[1]?.details).toMatchObject({ server_outcomes: [{ outcome: "success" }] });
  expect(results[2]?.details).toMatchObject({ event: "turn", status: "completed" });
  expect(overlappingCalls).toBe(true);
  expect(childPayloads).toHaveLength(2);
  expectStablePrefix(childPayloads[0]!, childPayloads[1]!);
  expect(childToolNames[0]).toContain("lsp");
  for (const ungranted of ["write", "dap", "subagent", "codemode_execute"])
    expect(childToolNames[0]).not.toContain(ungranted);
  // Both real sessions share one first-use acquisition, not independent stores.
  const resolutions = vi
    .mocked(spawn)
    .mock.calls.filter(
      ([command, args]) =>
        ["mise", "mise.exe"].includes(basename(String(command))) && args?.[2] === "latest",
    )
    .map(([, args]) => args?.[3]);
  expect(resolutions).toEqual(["core:node", "npm:typescript"]);
  const child = (await SessionManager.list(fixture.cwd, join(fixture.agentDir, "sessions"))).find(
    (session) => session.id !== fixture.session.sessionId,
  );
  if (!child) throw new Error("Missing persisted Child Session");
  const messages = SessionManager.open(child.path).buildSessionContext().messages;
  const result = messages.find(
    (message) => message.role === "toolResult" && message.toolName === "lsp",
  );
  expect(result).toMatchObject({
    isError: false,
    details: { server_outcomes: [{ outcome: "success" }] },
  });
  expect(JSON.stringify(result)).toContain("childAnswer");
  expect(JSON.stringify(results[1])).toContain("rootAnswer");
  expect(await fixture.installer.installed("lsp-typescript")).toBeDefined();
}, 30_000);

test("standalone DAP preserves serialized prefix across successful first acquisition and launch", async () => {
  vi.stubEnv("PATH", "");
  const fixture = await createFixture("dap");
  await writeFile(join(fixture.cwd, "app.mjs"), "console.log('debuggee');\n");
  expect(await fixture.installer.installed("dap-javascript")).toBeUndefined();
  const results = await perform(fixture.session, [
    call("dap", { operation: "launch", program: "app.mjs" }),
  ]);
  expect(results[0]?.details).toMatchObject({ state: "stopped", profile_id: "javascript" });
  expect(await fixture.installer.installed("dap-javascript")).toBeDefined();
}, 20_000);

test("standalone LSP preserves serialized prefix across successful first acquisition", async () => {
  vi.stubEnv("PATH", "");
  const fixture = await createFixture("lsp");
  await writeFile(join(fixture.cwd, "source.ts"), "export const answer = 42;\n");
  expect(await fixture.installer.installed("lsp-typescript")).toBeUndefined();
  const results = await perform(fixture.session, [
    call("lsp", { operation: "diagnostics", file_path: "source.ts" }),
  ]);
  expect(results[0]?.details).toMatchObject({
    server_outcomes: [{ server_id: "typescript", outcome: "success" }],
  });
  expect(await fixture.installer.installed("lsp-typescript")).toBeDefined();
}, 20_000);

test("standalone Formatter preserves serialized prefix while the first mutation acquires and formats", async () => {
  vi.stubEnv("PATH", "");
  const fixture = await createFixture("formatter");
  await writeFile(join(fixture.cwd, ".prettierrc"), "{}");
  expect(await fixture.installer.installed("formatter-prettier")).toBeUndefined();
  await perform(fixture.session, [
    call("write", { path: "source.ts", content: "export const answer = 42;\n" }),
  ]);
  expect(await readFile(join(fixture.cwd, "source.ts"), "utf8")).toBe(
    "export const answer = 42;\n// formatted-by-managed-prettier\n",
  );
  expect(await fixture.installer.installed("formatter-prettier")).toBeDefined();
  expect(fixture.progress.some((message) => message.includes("Installing"))).toBe(true);
}, 20_000);
