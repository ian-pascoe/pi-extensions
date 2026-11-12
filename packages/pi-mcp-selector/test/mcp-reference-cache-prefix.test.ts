/**
 * Cache proof for MCP Server References, driving a real Pi session offline with Pi's own MCP
 * extension over a fake transport; only the model stream is scripted. Each captured turn holds the
 * ordered tool definitions (name, description, parameters) and the system prompt exactly as Pi hands
 * them to the provider, plus the full transcript. A turn that carries a reference must leave tools
 * and system prompt byte-equal to the turn before it, and its transcript must extend the previous
 * one: the reference is only text in the user message and changes no tool exposure.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
  type Message,
  type Tool,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type McpTransportFactory,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vite-plus/test";
import mcpSelectorExtension from "../src/index.js";

type Transport = ReturnType<McpTransportFactory>;
type WireMessage = Parameters<Transport["send"]>[0];

interface CapturedTurn {
  readonly systemPrompt: string;
  readonly tools: Tool[];
  readonly messages: Message[];
}

const directories: string[] = [];
const sessions: AgentSession[] = [];

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

/** An in-process MCP server with one `search` tool that answers initialize, tools/list, and calls. */
function createFakeTransport(): Transport {
  const onMessage = new Set<(message: WireMessage) => void>();
  const onClose = new Set<() => void>();
  return {
    async start() {},
    async send(message) {
      if (!("method" in message) || !("id" in message)) return;
      const { id } = message;
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "fake", version: "1.0.0" },
              instructions: "Search the fake code host.",
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "search",
                    description: "Search code",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }
            : { content: [{ type: "text", text: "ok" }] };
      queueMicrotask(() => {
        for (const listener of onMessage) listener({ jsonrpc: "2.0", id, result });
      });
    },
    async close() {
      for (const listener of onClose) listener();
    },
    onMessage(listener) {
      onMessage.add(listener);
      return () => onMessage.delete(listener);
    },
    onError: () => () => {},
    onClose(listener) {
      onClose.add(listener);
      return () => onClose.delete(listener);
    },
  };
}

async function createFixture(connectedServers: readonly string[]) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-selector-cache-prefix-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      retry: { enabled: false },
      compaction: { enabled: false },
      codemode: { mode: "on" },
      defaultTools: ["read", "bash", "edit", "write"],
    }),
  );
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      {
        name: "codemode",
        factory: createCodemodeExtension(),
        builtin: true,
        replaceable: true,
      },
      {
        name: "mcp",
        factory: createMcpExtension({
          loadConfig: () => ({
            servers: connectedServers.map((name) => ({
              name,
              config: { url: `https://${name}.example.test/mcp`, description: `Server ${name}` },
              source: "test",
              scope: "global" as const,
            })),
            errors: [],
          }),
          createTransport: createFakeTransport,
          logPath: join(agentDir, "mcp.log"),
        }),
        builtin: true,
        replaceable: true,
      },
      { name: "pi-mcp-selector-test", factory: mcpSelectorExtension },
    ],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);

  const model = getModel("anthropic", "claude-sonnet-4-5");
  if (model === undefined) throw new Error("missing pinned model");
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: join(cwd, "models.json"),
    allowModelNetwork: false,
  });
  await modelRuntime.setRuntimeApiKey("anthropic", "TEST-NOT-A-REAL-KEY");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
    settingsManager,
  });
  sessions.push(session);

  const turns: CapturedTurn[] = [];
  const responses: AssistantMessage[] = [];
  session.agent.streamFunction = (currentModel, context, requestOptions) => {
    requestOptions?.signal?.throwIfAborted();
    turns.push({
      systemPrompt: getCurrentSystemPrompt(context.messages),
      tools: getCurrentTools(context.messages).map(({ name, description, parameters }) => ({
        name,
        description,
        parameters: structuredClone(parameters),
      })),
      messages: structuredClone(context.messages),
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("Unexpected model request");
    const message: AssistantMessage = {
      ...next,
      api: currentModel.api,
      provider: currentModel.provider,
      model: currentModel.id,
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const reason = message.stopReason;
      if (reason === "error" || reason === "aborted") {
        stream.push({ type: "error", reason, error: message });
      } else if (reason !== "pending") {
        stream.push({ type: "done", reason, message });
      }
    });
    return stream;
  };
  await session.bindExtensions({ mode: "rpc" });
  // Servers connect in the background; the Catalogue lists a server once its tools register.
  for (const name of connectedServers) {
    await expectEventually(() =>
      session
        .getAllTools()
        .some((tool) => tool.name.startsWith(`mcp__${name.replaceAll("-", "_")}__`)),
    );
  }
  return { session, turns, responses };
}

async function expectEventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the MCP server to connect");
}

function userTexts(turn: CapturedTurn | undefined): string[] {
  return (turn?.messages ?? []).flatMap((message) =>
    message.role === "user"
      ? [
          Array.isArray(message.content)
            ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
            : message.content,
        ]
      : [],
  );
}

/** Assert byte-equal ordered tools and system prompt, and an append-only transcript. */
function expectStablePrefix(turns: readonly CapturedTurn[]): void {
  const [first] = turns;
  if (first === undefined) throw new Error("no captured turns");
  for (const [index, turn] of turns.entries()) {
    const previous = turns[index - 1];
    if (previous === undefined) continue;
    expect(JSON.stringify(turn.tools), `tools of turn ${index}`).toBe(JSON.stringify(first.tools));
    expect(turn.systemPrompt, `system prompt of turn ${index}`).toBe(first.systemPrompt);
    expect(
      JSON.stringify(turn.messages.slice(0, previous.messages.length)),
      `transcript prefix of turn ${index}`,
    ).toBe(JSON.stringify(previous.messages));
    expect(turn.messages.length, `transcript growth in turn ${index}`).toBeGreaterThan(
      previous.messages.length,
    );
  }
}

describe("MCP Server References keep the cached prefix stable", () => {
  test("a turn with a reference leaves tools and system prompt byte-identical and extends history", async () => {
    const fixture = await createFixture(["github", "dev-radius"]);
    const activeBefore = fixture.session.getActiveToolNames();
    const exposureBefore = fixture.session
      .getAllTools()
      .map((tool) => [tool.name, tool.exposure, tool.namespace?.name]);
    fixture.responses.push(
      fauxAssistantMessage("One."),
      fauxAssistantMessage("Two."),
      fauxAssistantMessage("Three."),
    );
    await fixture.session.prompt("Hello");
    await fixture.session.prompt("Look in &github, not &dev_radius.");
    await fixture.session.prompt("And again with &github's tools");
    expect(fixture.turns).toHaveLength(3);
    expectStablePrefix(fixture.turns);

    // The model sees links, and the listed servers are the same before and after.
    expect(userTexts(fixture.turns[1]).at(-1)).toBe(
      'Look in [&github](mcp://github "MCP server mcp__github"), not [&dev_radius](mcp://dev-radius "MCP server mcp__dev_radius").',
    );
    expect(userTexts(fixture.turns[2]).at(-1)).toBe(
      'And again with [&github](mcp://github "MCP server mcp__github")\'s tools',
    );
    // MCP tools stay behind codemode, so the reference has nothing to declare or load.
    expect(fixture.turns[0]?.tools.map((tool) => tool.name)).toEqual([
      ...activeBefore.filter((name) => name !== "codemode"),
      "codemode",
    ]);
    expect(fixture.turns[0]?.systemPrompt).toContain("github");
    // Pointing at a server loads, connects, and exposes nothing.
    expect(fixture.session.getActiveToolNames()).toEqual(activeBefore);
    expect(
      fixture.session.getAllTools().map((tool) => [tool.name, tool.exposure, tool.namespace?.name]),
    ).toEqual(exposureBefore);
  });
});
