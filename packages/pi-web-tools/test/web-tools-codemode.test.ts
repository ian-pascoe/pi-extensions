import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
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
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { createPiWebToolsExtension } from "../src/index.js";
import { selectSearchProvider } from "../src/web-search.js";

interface CapturedTurn {
  readonly systemPrompt: string;
  readonly tools: Tool[];
  readonly messages: Message[];
}

const directories: string[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const SEARCH_TEXT = "Title: Pi\nURL: https://pi.dev\nHighlights: an agent harness";
const LONG_PAGE = `<p>${"word ".repeat(30_000)}</p><p>FINAL MARKER</p>`;

/** A fresh session, or one with a fixed id so Search Provider selection is deterministic. */
async function openSessionManager(cwd: string, sessionId: string | undefined) {
  const sessionDirectory = join(cwd, "sessions");
  if (sessionId === undefined) return SessionManager.create(cwd, sessionDirectory);
  await mkdir(sessionDirectory);
  const sessionFile = join(sessionDirectory, "session.jsonl");
  await writeFile(
    sessionFile,
    `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd })}\n`,
  );
  return SessionManager.open(sessionFile);
}

/** Real Pi session with built-in codemode and Web Tools; only the network and model are scripted. */
async function createFixture(sessionId?: string) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-tools-sdk-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      retry: { enabled: false },
      compaction: { enabled: false },
      codemode: { mode: "on" },
      defaultTools: ["read", "bash", "edit", "write", "codemode"],
    }),
  );
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const fetch: typeof globalThis.fetch = async (_input, init) =>
    init?.method === "POST"
      ? new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: SEARCH_TEXT }] },
          }),
        )
      : new Response(LONG_PAGE, { headers: { "content-type": "text/html" } });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    // Built-in extension factories load only when extension discovery stays enabled.
    noExtensions: false,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
      { name: "pi-web-tools-test", factory: createPiWebToolsExtension({ fetch }) },
    ],
    systemPromptOverride: () => "Standing instructions: answer with the shortest correct turn.",
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
    sessionManager: await openSessionManager(cwd, sessionId),
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
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } else if (message.stopReason !== "pending") {
        stream.push({ type: "done", reason: message.stopReason, message });
      }
    });
    return stream;
  };
  await session.bindExtensions({ mode: "rpc" });
  // Pi's built-in codemode registers inactive; SDK sessions activate it explicitly.
  session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
  return { session, turns, responses, cwd };
}

function scriptResult(messages: readonly Message[]): string {
  const result = messages.findLast((message) => message.role === "toolResult");
  if (result?.role !== "toolResult" || result.toolName !== "codemode") return "";
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("Web Tools through Pi codemode", () => {
  test("scripts receive typed web_search and web_fetch values", async () => {
    const fixture = await createFixture();
    const code = `
      const search = await tools.web_search({ query: "pi agent" });
      const page = await tools.web_fetch({ url: "https://example.com/long", format: "text" });
      return {
        provider: search.provider,
        searchContent: search.content,
        searchSpilled: search.full_output_path !== undefined,
        url: page.url,
        content_type: page.content_type,
        format: page.format,
        truncated: page.truncated,
        structuredTruncated: page.structured_truncated,
        hasFinalMarker: page.content.includes("FINAL MARKER"),
        spilled: typeof page.full_output_path,
      };`;
    fixture.responses.push(
      fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    );
    await fixture.session.prompt("Search and fetch in one script");

    const output = scriptResult(fixture.turns[1]?.messages ?? []);
    expect(output).toMatch(/^Script completed/);
    const value: unknown = JSON.parse(output.slice(output.indexOf("{")));
    expect(value).toEqual({
      provider: expect.stringMatching(/^(exa|parallel)$/),
      searchContent: SEARCH_TEXT,
      searchSpilled: false,
      url: "https://example.com/long",
      content_type: "text/html",
      format: "text",
      truncated: true,
      structuredTruncated: false,
      hasFinalMarker: true,
      spilled: "string",
    });
  });

  test("keeps ordered tool definitions identical across turns and reload", async () => {
    const fixture = await createFixture();
    fixture.responses.push(
      fauxAssistantMessage(
        fauxToolCall("codemode", {
          code: 'return (await tools.web_search({ query: "pi" })).content.length;',
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("First."),
      fauxAssistantMessage("Second."),
      fauxAssistantMessage("Third."),
    );
    await fixture.session.prompt("Turn one");
    await fixture.session.prompt("Turn two");
    await fixture.session.reload();
    await fixture.session.prompt("Turn three");

    const [first] = fixture.turns;
    expect(fixture.turns).toHaveLength(4);
    const declared = first?.tools.map(({ name }) => name) ?? [];
    expect(declared).toContain("codemode");
    // Pi appends the script-call result line to a declared tool's description (or lists it in codemode's).
    const text = (first?.tools ?? []).map(({ description }) => description).join("\n");
    expect(text).toMatch(
      /web_search\(args\)` resolves to `\{ provider, content, warnings\?, full_output_path\? \}`/,
    );
    expect(text).toMatch(
      /web_fetch\(args\)` resolves to `\{ url, content_type, format, content, truncated, structured_truncated, full_output_path\? \}`/,
    );
    for (const turn of fixture.turns) {
      expect(turn.systemPrompt).toBe(first?.systemPrompt);
      expect(turn.tools).toEqual(first?.tools);
    }
  });

  test("scripts see warnings only for parameters they supplied", async () => {
    const fixture = await createFixture();
    const provider = selectSearchProvider(fixture.session.sessionId);
    const ignoredType = `${provider === "exa" ? "Exa" : "Parallel"} ignores: type.`;
    const code = `
      const plain = await tools.web_search({ query: "pi" });
      const typed = await tools.web_search({ query: "pi", type: "fast" });
      return { plainHasWarnings: "warnings" in plain, typedWarnings: typed.warnings };`;
    fixture.responses.push(
      fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    );
    await fixture.session.prompt("Search twice");

    const output = scriptResult(fixture.turns[1]?.messages ?? []);
    expect(output).toMatch(/^Script completed/);
    const value: unknown = JSON.parse(output.slice(output.indexOf("{")));
    expect(value).toEqual({ plainHasWarnings: false, typedWarnings: [ignoredType] });
  });

  test("declares identical tools and system prompt for Exa and Parallel sessions", async () => {
    // session-b selects Exa and session-a selects Parallel.
    const turnFor = async (sessionId: string) => {
      const fixture = await createFixture(sessionId);
      fixture.responses.push(fauxAssistantMessage("Done."));
      await fixture.session.prompt("Hello");
      const [turn] = fixture.turns;
      if (turn === undefined) throw new Error("Expected one model turn");
      // The prompt names the per-fixture temporary working directory, which is not provider state.
      const systemPrompt = turn.systemPrompt.replaceAll(fixture.cwd, "<fixture-cwd>");
      return { provider: selectSearchProvider(sessionId), turn, systemPrompt };
    };
    const exa = await turnFor("session-b");
    const parallel = await turnFor("session-a");
    expect([exa.provider, parallel.provider]).toEqual(["exa", "parallel"]);
    expect(exa.turn.tools.map(({ name }) => name)).toContain("web_search");
    expect(parallel.turn.tools).toEqual(exa.turn.tools);
    expect(parallel.systemPrompt).toBe(exa.systemPrompt);
  });
});
