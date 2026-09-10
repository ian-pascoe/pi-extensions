import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonSchemaType } from "@modelcontextprotocol/client";
import type { StreamFunction, StreamOptions } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, expect, test, vi } from "vitest";
import {
  McpHost,
  type McpHostClientEvents,
  type McpHostServerTool,
  type McpOwnedHostClient,
} from "../src/mcp-host.js";
import { createMcpSessionFiles } from "../src/mcp-session-files.js";
import { McpToolCatalog } from "../src/mcp-tool-catalog.js";
import { createPiMcpExtension } from "../src/pi-mcp-extension.js";
import { resolveMcpSettings } from "../src/pi-mcp-settings.js";

const directories: string[] = [];
const sessions: AgentSession[] = [];
const guidance = "## MCP Server: fixture\nKeep the original guidance.";
const keptTool: McpHostServerTool = { name: "keep", inputSchema: { type: "object" } };
const removedTool: McpHostServerTool = { name: "remove", inputSchema: { type: "object" } };
const addedTool: McpHostServerTool = {
  name: "a_added",
  description: "A genuinely new callable capability.",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
};

async function createFixture(codeModeOnly: boolean) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-instruction-cache-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  const files = await createMcpSessionFiles(agentDir);
  const settings = {
    mcp: { servers: { fixture: { command: "unused-offline-client" } } },
    codemode: codeModeOnly ? { tools: [{ pattern: "*", exposure: "codemode-only" }] } : undefined,
  };
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  let tools = [keptTool, removedTool];
  let events: McpHostClientEvents | undefined;
  const client = {
    capabilities: { tools: true },
    instructions: "  Keep the original guidance.\n",
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "called" }] })),
    close: async () => undefined,
    completePromptArgument: async () => ({ values: [] }),
    getPrompt: async () => ({ messages: [] }),
    listPrompts: async () => [],
    listResources: async () => [],
    listResourceTemplates: async () => [],
    readResource: async () => ({ contents: [] }),
    subscribeResource: async () => undefined,
    unsubscribeResource: async () => undefined,
  } satisfies McpOwnedHostClient;
  const ready = Promise.withResolvers<McpHost>();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    systemPromptOverride: () => "Fixed base system prompt.",
    additionalExtensionPaths: codeModeOnly
      ? [fileURLToPath(new URL("../../pi-codemode/src/index.ts", import.meta.url))]
      : [],
    extensionFactories: [
      (pi) => {
        pi.on("before_agent_start", (event) => ({
          systemPrompt: `${event.systemPrompt}\nEarlier extension suffix.`,
        }));
      },
      createPiMcpExtension({
        async createSession(_context, pi) {
          const host = new McpHost({
            clientFactory: {
              async connect(options) {
                events = options.events;
                return client;
              },
            },
            piCwd: cwd,
            sessionFiles: files,
            settings: resolveMcpSettings(settingsManager),
            async onCatalogChanged(serverId) {
              if (host.getStatus(serverId)?.state !== "connected") {
                await catalog.setServerActive(serverId, false);
                return "inactive";
              }
              await catalog.replaceServerTools(
                serverId,
                (await host.listTools(serverId)).map(({ tool }) => ({
                  name: tool.name,
                  // SAFETY: Reconcile the SDK's exact-optional schema exports, as production catalogServerTool does.
                  inputSchema: tool.inputSchema as JsonSchemaType,
                  description: tool.description ?? "Fixture tool.",
                })),
              );
              return "active";
            },
          });
          const catalog = new McpToolCatalog(pi, {
            async callServerTool(serverId, name, input) {
              const result = await host.callTool(serverId, name, input);
              return {
                content: result.content.filter((block) => block.type === "text"),
                details: {},
              };
            },
            listResources: vi.fn(),
            listResourceTemplates: vi.fn(),
            readResource: vi.fn(),
          });
          ready.resolve(host);
          return {
            start: async () => host.start(),
            close: (reason) => host.shutdown(reason),
            executeCommand: async () => ({ level: "info", message: "unused" }),
            instructionSnapshot: () => host.instructionSnapshot().text,
            redactPresentationText: (text) => text,
            transformContext: (messages) => messages,
          };
        },
      }),
    ],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: getModel("anthropic", "claude-sonnet-4-5"),
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });
  sessions.push(session);
  await session.bindExtensions({ mode: "rpc" });
  const host = await ready.promise;
  host.start();
  await host.waitForInitialConnections();
  return {
    session,
    host,
    client,
    async refresh(nextTools = tools) {
      tools = nextTools;
      if (events === undefined) throw new Error("Fake MCP Client was not connected");
      await events.onCatalogChanged(
        "tools",
        tools.map(({ name }) => name),
      );
      expect((await host.listTools("fixture")).map(({ tool }) => tool)).toEqual(
        nextTools.toSorted((left, right) => left.name.localeCompare(right.name)),
      );
    },
  };
}

async function serialize(session: AgentSession) {
  const entry = import.meta.resolve("@earendil-works/pi-ai");
  const api: { stream: StreamFunction<"anthropic-messages", StreamOptions & { client: object }> } =
    await import(new URL("./api/anthropic-messages.js", entry).href);
  const prepared = await session.extensionRunner.emitBeforeAgentStart(
    "Continue",
    undefined,
    session.systemPrompt,
    { cwd: session.sessionManager.getCwd() },
  );
  expect(prepared?.systemPrompt).toBe(
    `${session.systemPrompt}\nEarlier extension suffix.\n\n${guidance}`,
  );
  expect(prepared?.messages).toBeUndefined();
  const sentinel = "STOP BEFORE ANTHROPIC TRANSPORT";
  let captured: unknown;
  const transport = vi.fn(() => {
    throw new Error("Unexpected transport");
  });
  const response = await api
    .stream(
      getModel("anthropic", "claude-sonnet-4-5"),
      {
        systemPrompt: prepared?.systemPrompt ?? session.systemPrompt,
        tools: session.agent.state.tools,
        messages: [{ role: "user", content: "Fixed synthetic history.", timestamp: 0 }],
      },
      {
        client: { beta: { messages: { create: transport } } },
        sessionId: "plan-005-fixed-routing-key",
        cacheRetention: "short",
        onPayload(payload) {
          captured = structuredClone(payload);
          throw new Error(sentinel);
        },
      },
    )
    .result();
  expect(response.stopReason).toBe("error");
  expect(response.errorMessage).toContain(sentinel);
  expect(transport).not.toHaveBeenCalled();
  const schema = Type.Object({
    system: Type.Array(Type.Unknown(), { minItems: 1 }),
    tools: Type.Array(Type.Object({ name: Type.String() }), { minItems: 1 }),
    messages: Type.Array(Type.Unknown(), { minItems: 1 }),
  });
  if (!Value.Check(schema, captured)) throw new Error("Unexpected installed Anthropic payload");
  return captured;
}

function tool(session: AgentSession, name: string) {
  const found = session.agent.state.tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing active tool: ${name}`);
  return found;
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
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

test("keeps serialized system and surviving immediate tools stable while direct MCP capabilities change", async () => {
  const fixture = await createFixture(false);
  const { session, host } = fixture;
  expect(host.instructionSnapshot().text).toBe(guidance);
  const before = await serialize(session);
  await fixture.refresh();
  expect(await serialize(session)).toEqual(before);
  await tool(session, "mcp__fixture__remove").execute(
    "before-removal",
    {},
    new AbortController().signal,
  );
  expect(fixture.client.callTool).toHaveBeenCalledOnce();

  await fixture.refresh([addedTool, keptTool]);
  // Revocation is live, before another agent-start snapshot is captured.
  expect(session.getActiveToolNames()).not.toContain("mcp__fixture__remove");
  expect(session.agent.state.tools.some(({ name }) => name === "mcp__fixture__remove")).toBe(false);
  expect(host.instructionSnapshot().text).toBe(guidance);
  const after = await serialize(session);
  expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
  expect(after.messages).toEqual(before.messages);
  expect(after.tools).not.toEqual(before.tools);
  expect(after.tools.map(({ name }) => name).slice(-2)).toEqual([
    "mcp__fixture__keep",
    "mcp__fixture__a_added",
  ]);
  expect(after.tools.filter(({ name }) => name !== "mcp__fixture__a_added")).toEqual(
    before.tools.filter(({ name }) => name !== "mcp__fixture__remove"),
  );
  await fixture.refresh([keptTool, addedTool]);
  expect(await serialize(session)).toEqual(after);
});

test("keeps serialized system and real CodeMode outer tools identical through roster and equal refreshes", async () => {
  const fixture = await createFixture(true);
  const { session } = fixture;
  const before = await serialize(session);
  expect(before.tools.map(({ name }) => name)).toContain("codemode_execute");
  expect(before.tools.some(({ name }) => name.startsWith("mcp__"))).toBe(false);
  const search = tool(session, "codemode_search");
  const discover = (query: string) =>
    search.execute("discover", { query }, new AbortController().signal);
  expect((await discover("mcp__fixture__remove")).details).toMatchObject({
    items: [{ name: "mcp__fixture__remove" }],
  });
  await fixture.refresh();
  expect(await serialize(session)).toEqual(before);
  await fixture.refresh([addedTool, keptTool]);
  expect((await discover("mcp__fixture__a_added")).details).toMatchObject({
    items: [
      { name: "mcp__fixture__a_added", declaration: expect.stringContaining('["query"]?: string') },
    ],
  });
  expect((await discover("mcp__fixture__remove")).details).toEqual(
    expect.objectContaining({
      items: expect.not.arrayContaining([
        expect.objectContaining({ name: "mcp__fixture__remove" }),
      ]),
    }),
  );
  const after = await serialize(session);
  expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
  expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
  expect(after.messages).toEqual(before.messages);
  await fixture.refresh([keptTool, addedTool]);
  expect(await serialize(session)).toEqual(after);
});
