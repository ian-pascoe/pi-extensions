/**
 * Cache proofs for the per-operation DAP tools, using Pi's default system prompt so tool snippets
 * and guidelines are part of the proof. Every case drives a real Pi session offline; only
 * the model stream is scripted. Each captured turn holds the ordered tool definitions (name,
 * description, parameters) and the system prompt exactly as Pi hands them to the provider, plus the
 * full transcript. Where the configuration is unchanged, tools and system prompt must be byte-equal
 * from turn to turn and across reload, and each transcript must extend the previous one.
 */
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
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { DAP_OPERATIONS } from "../src/dap-tool-contract.js";
import { createPiDapExtension } from "../src/pi-dap-extension.js";

interface CapturedTurn {
  readonly systemPrompt: string;
  readonly tools: Tool[];
  readonly messages: Message[];
}

interface Fixture {
  readonly session: AgentSession;
  readonly turns: CapturedTurn[];
  readonly responses: AssistantMessage[];
}

interface FixtureOptions {
  /** Global `defaultTools` setting. */
  readonly defaultTools?: readonly string[];
  /** SDK `tools` allowlist, the equivalent of `--tools`. */
  readonly tools?: readonly string[];
  readonly codemode?: boolean;
  readonly toolSearch?: boolean;
  /** Extra extensions, loaded after Pi DAP, such as hooks that observe tool calls. */
  readonly extraExtensions?: readonly InlineExtension[];
}

type InlineExtension = NonNullable<
  ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"]
>[number];

const DAP_TOOLS = DAP_OPERATIONS.map((operation) => `dap_${operation}`);
/** The only tools whose results, and so output schemas, carry `desired_breakpoints`. */
const DESIRED_BREAKPOINT_TOOLS = ["dap_launch", "dap_set_breakpoints", "dap_status"];
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

/** Real Pi collaborators; the only scripted collaborator is the external model stream. */
async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-dap-cache-prefix-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  const builtins = [
    ...(options.codemode === true ? ["codemode"] : []),
    ...(options.toolSearch === true ? ["tool_search"] : []),
  ];
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      retry: { enabled: false },
      compaction: { enabled: false },
      codemode: { mode: "on" },
      defaultTools: [...(options.defaultTools ?? ["read", "bash", "edit", "write"]), ...builtins],
    }),
  );
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const factories: InlineExtension[] = [];
  if (options.codemode === true) {
    factories.push({
      name: "codemode",
      factory: createCodemodeExtension(),
      builtin: true,
      replaceable: true,
    });
  }
  if (options.toolSearch === true) {
    factories.push({
      name: "tool-search",
      factory: createToolSearchExtension(),
      builtin: true,
      replaceable: true,
    });
  }
  factories.push({
    name: "pi-dap-cache-prefix-test",
    factory: createPiDapExtension(() => agentDir),
  });
  factories.push(...(options.extraExtensions ?? []));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: builtins.length === 0,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: factories,
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
  const sessionOptions: CreateAgentSessionOptions = {
    cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
    settingsManager,
  };
  // Without `tools`, Pi uses the `defaultTools` selection, like omitting `--tools`.
  if (options.tools !== undefined) sessionOptions.tools = [...options.tools];
  const { session } = await createAgentSession(sessionOptions);
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
  return { session, turns, responses };
}

function toolCallTurn(name: string, args: Parameters<typeof fauxToolCall>[1]): AssistantMessage {
  return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

function systemMessageCount(messages: readonly Message[]): number {
  return messages.filter((message) => message.role === "system").length;
}

/** Assert byte-equal ordered tools and system prompt, and an append-only transcript. */
function expectStablePrefix(turns: readonly CapturedTurn[], minimumTurns: number): void {
  expect(turns.length, "captured turns").toBeGreaterThanOrEqual(minimumTurns);
  const [first] = turns;
  if (first === undefined) throw new Error("no captured turns");
  expect(systemMessageCount(first.messages)).toBe(1);
  for (const [index, turn] of turns.entries()) {
    const previous = turns[index - 1];
    if (previous === undefined) continue;
    expect(JSON.stringify(turn.tools), `tools of turn ${index}`).toBe(JSON.stringify(first.tools));
    expect(turn.systemPrompt, `system prompt of turn ${index}`).toBe(first.systemPrompt);
    expect(
      JSON.stringify(turn.messages.slice(0, previous.messages.length)),
      `transcript prefix of turn ${index}`,
    ).toBe(JSON.stringify(previous.messages));
    expect(systemMessageCount(turn.messages), `system messages in turn ${index}`).toBe(1);
  }
}

function toolNamesOf(turn: CapturedTurn | undefined): string[] {
  return (turn?.tools ?? []).map(({ name }) => name);
}

function lastToolResultText(turn: CapturedTurn | undefined): string {
  const message = turn?.messages.at(-1);
  if (message?.role !== "toolResult") throw new Error("Expected a tool result");
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("per-operation DAP tools keep the cached prefix stable", () => {
  test("standalone: across turns, real DAP calls, and reload", async () => {
    const fixture = await createFixture();
    fixture.responses.push(
      fauxAssistantMessage("One."),
      toolCallTurn("dap_set_breakpoints", { file_path: "app.ts", breakpoints: [{ line: 3 }] }),
      toolCallTurn("dap_status", {}),
      fauxAssistantMessage("Idle."),
      fauxAssistantMessage("After reload."),
    );
    await fixture.session.prompt("First");
    await fixture.session.prompt("Set a breakpoint and check status");
    await fixture.session.reload();
    await fixture.session.prompt("After reload");
    expectStablePrefix(fixture.turns, 5);
    expect(toolNamesOf(fixture.turns[0])).toEqual(["read", "bash", "edit", "write", ...DAP_TOOLS]);
    expect(fixture.turns[0]?.systemPrompt).toContain(
      "- dap_launch: Debug a program through one configured Debug Session",
    );
    expect(
      fixture.turns[0]?.systemPrompt.match(/Use the dap_\* tools to set source breakpoints/gu),
    ).toHaveLength(1);
    expect(lastToolResultText(fixture.turns[3])).toContain("idle (no Debug Session)");
  });

  test("with codemode: scripts reach every tool and declarations stay stable", async () => {
    const fixture = await createFixture({ codemode: true });
    fixture.responses.push(
      fauxAssistantMessage("One."),
      toolCallTurn("codemode", {
        code: [
          "const status = await tools.dap_status({});",
          "const paused = await tools.dap_pause({});",
          "const namespace = await describeNamespace('dap');",
          "return { state: status.state, output: status.output, pausedState: paused.state, pausedError: paused.error, namespace, stackType: await describeTool('dap_stack'), launchType: await describeTool('dap_launch') };",
        ].join("\n"),
      }),
      fauxAssistantMessage("Done."),
      fauxAssistantMessage("After reload."),
    );
    await fixture.session.prompt("First");
    await fixture.session.prompt("Check the Debug Session from a script");
    await fixture.session.reload();
    await fixture.session.prompt("After reload");
    expectStablePrefix(fixture.turns, 4);

    const [first] = fixture.turns;
    expect(toolNamesOf(first)).toEqual(expect.arrayContaining(DAP_TOOLS));
    // Declared tools are not repeated in the codemode listing; each says how scripts call it.
    const codemode = first?.tools.find(({ name }) => name === "codemode");
    expect(codemode?.description).not.toContain("### `dap_");
    for (const name of DAP_TOOLS) {
      const declared = first?.tools.find((tool) => tool.name === name);
      expect(declared?.description, name).toContain(
        `Codemode: \`tools.${name}(args)\` resolves to \`{ state, `,
      );
      expect(declared?.description, name).toMatch(/\berror\?[,\s]/u);
      // Tools that can fail on the Debug Session state say so, naming the `error` field.
      if (!["dap_set_breakpoints", "dap_status", "dap_stop"].includes(name)) {
        expect(declared?.description, name).toMatch(/`error` message/u);
      }
      // Only the tools that set, begin, or report the Debug Session declare Desired Breakpoints.
      const declaresDesired = /\bdesired_breakpoints\?[,\s]/u.test(declared?.description ?? "");
      expect(declaresDesired, `${name} declares desired_breakpoints`).toBe(
        DESIRED_BREAKPOINT_TOOLS.includes(name),
      );
    }

    // Scripts receive the structured result, including state for a state failure.
    const scriptResult = lastToolResultText(fixture.turns[2]);
    expect(scriptResult).toContain('"state":"idle"');
    expect(scriptResult).toContain('"output":""');
    expect(scriptResult).toContain('"pausedState":"idle"');
    expect(scriptResult).toContain("pause requires a running Debuggee");
    // The namespace keeps its grouping: codemode reports its description, instructions, and tools.
    for (const name of DAP_TOOLS) expect(scriptResult).toContain(name);
    expect(scriptResult).toContain("same single Debug Session");
    // The `error` field's meaning reaches scripts through the rendered declaration.
    expect(scriptResult).toContain("// Set when the Debug Session state did not allow the call");
    // The full declarations of tools that can fail on state render the `error` field's description.
    expect(
      scriptResult.match(/Set when the Debug Session state did not allow the call/gu),
    ).toHaveLength(2);
  });

  test("nested script calls to the tools never overlap on the one Debug Session", async () => {
    const events: string[] = [];
    const fixture = await createFixture({
      codemode: true,
      extraExtensions: [
        {
          name: "dap-call-recorder",
          factory: (pi) => {
            pi.on("tool_call", async (event) => {
              if (!event.toolName.startsWith("dap_")) return;
              events.push(`start ${event.toolName}`);
              // Overlapping calls would both start before either finishes.
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
            });
            pi.on("tool_result", (event) => {
              if (event.toolName.startsWith("dap_")) events.push(`end ${event.toolName}`);
            });
          },
        },
      ],
    });
    fixture.responses.push(
      toolCallTurn("codemode", {
        code: "await Promise.all([tools.dap_set_breakpoints({ file_path: 'a.ts', breakpoints: [] }), tools.dap_status({}), tools.dap_stop({})]);",
      }),
      fauxAssistantMessage("Done."),
    );
    await fixture.session.prompt("Run three calls at once");
    expect(events).toEqual([
      "start dap_set_breakpoints",
      "end dap_set_breakpoints",
      "start dap_status",
      "end dap_status",
      "start dap_stop",
      "end dap_stop",
    ]);
  });

  test("an allowlist can select a subset of the tools without disturbing the prefix", async () => {
    const fixture = await createFixture({ tools: ["read", "dap_status", "dap_pause"] });
    fixture.responses.push(fauxAssistantMessage("One."), fauxAssistantMessage("Two."));
    await fixture.session.prompt("First");
    await fixture.session.prompt("Second");
    expectStablePrefix(fixture.turns, 2);
    expect(toolNamesOf(fixture.turns[0])).toEqual(["read", "dap_status", "dap_pause"]);
  });
});
