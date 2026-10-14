/**
 * Combined-mode test: Pi Context Management and Pi Minimal Subagents loaded together, as the Git
 * collection loads them, and each loaded alone.
 *
 * Why this lives at the repository root: neither package may depend on the other, so a
 * package-level test's Turborepo cache key cannot see the other package's source. The root
 * `//#test:root` task lists both packages (and pi-utils, which carries the shared Agent Lineage
 * Record) as inputs; see `formatter-lsp-combined-order.test.ts` for the same arrangement.
 *
 * What it pins: a Child Agent that Minimal Subagents spawns can list its root's Notes through
 * `context_notes` with `scope: "lineage"`, because Minimal Subagents writes the Agent Lineage Record
 * into the child session and Context Management reads it. Each package alone declares the same
 * tools to the model, byte for byte, as when both are loaded, and Context Management alone answers
 * the lineage scope with the session's own Notes.
 *
 * Every model request goes to an offline provider extension written into the test's directory;
 * Child Agents load it from the same Pi settings, so the root and its children share one script.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Model } from "@earendil-works/pi-ai";
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

const SUBAGENTS_ENTRYPOINT = "./packages/pi-minimal-subagents/src/index.ts";
const CONTEXT_ENTRYPOINT = "./packages/pi-context-management/src/index.ts";

/** Both extensions in the order the root `package.json` lists them, which Pi loads in. */
const collectionOrder = rootManifest.pi.extensions.filter(
  (entrypoint) => entrypoint === SUBAGENTS_ENTRYPOINT || entrypoint === CONTEXT_ENTRYPOINT,
);

const CONTEXT_TOOLS = ["context_notes", "context_history", "context_rollover"];
const COORDINATOR_TOOLS = [
  "subagent",
  "agent_message",
  "subagent_wait",
  "subagent_status",
  "subagent_cancel",
  "subagent_delete",
];

const MODEL: Model<"openai-completions"> = {
  id: "model",
  name: "Offline combined-mode test model",
  api: "openai-completions",
  provider: "provider",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

/** Marks the Child Agent's task, so the shared script can tell the child's requests from the root's. */
const CHILD_TASK = "LINEAGE-TASK: list the Notes of your lineage";

/**
 * The offline provider. It records each request as one JSON line and answers from a script keyed
 * on the conversation's first user message and the tool results so far.
 */
function providerSource(requestsPath: string): string {
  return `import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const textOf = (message) => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).map((block) => block.type === "text" ? block.text : "").join("");
function next(messages) {
  const first = textOf(messages.find((message) => message.role === "user"));
  const done = messages.filter((message) => message.role === "toolResult").map((message) => message.toolName);
  const call = (name, args) => ({ name, arguments: args });
  if (first.includes(${JSON.stringify(CHILD_TASK)}))
    return done.length === 0 ? call("context_notes", { action: "list", scope: "lineage" }) : undefined;
  if (first === "STANDALONE") {
    if (!done.includes("context_notes")) return call("context_notes", { action: "write", name: "own", content: "mine" });
    return done.length === 1 ? call("context_notes", { action: "list", scope: "lineage" }) : undefined;
  }
  if (first !== "COMBINED") return undefined;
  if (!done.includes("context_notes")) return call("context_notes", { action: "write", name: "plan", content: "root plan" });
  if (!done.includes("subagent")) return call("subagent", { agent_id: "reader", task: ${JSON.stringify(CHILD_TASK)}, tools: ["context_notes"] });
  if (!done.includes("subagent_wait")) return call("subagent_wait", { agent_id: "reader", timeout_ms: 60000 });
  return undefined;
}
export default function (pi) {
  pi.registerProvider("provider", {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "offline-test-key",
    models: [${JSON.stringify(MODEL)}],
    streamSimple(model, context) {
      appendFileSync(${JSON.stringify(requestsPath)}, JSON.stringify(context) + "\\n");
      const toolCall = next(context.messages);
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), usage: ZERO_USAGE,
        content: toolCall ? [{ type: "toolCall", id: "call-" + context.messages.length, ...toolCall }]
          : [{ type: "text", text: "done" }],
        stopReason: toolCall ? "toolUse" : "stop",
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message }));
      return stream;
    },
  });
}
`;
}

const directories: string[] = [];
const sessions: AgentSession[] = [];

/**
 * Pi compiles extension TypeScript with jiti and caches it on disk; a cold cache can take longer
 * than a test's timeout. Loading both extensions once here keeps that one-time cost out of the
 * first test. The hook timeout only guards against a hang.
 */
beforeAll(async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-context-lineage-warm-up-")));
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
    // `dispose` does not emit `session_shutdown`; Minimal Subagents stops its children on it.
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

interface RootSession {
  readonly session: AgentSession;
  /** Every model request so far, from the root and its children, in order. */
  readonly requests: () => Promise<Context[]>;
}

/**
 * A persisted root Pi session loading the offline provider and the given extensions from Pi
 * settings, where Child Agents load their extensions from too.
 */
async function startRoot(extensions: readonly string[]): Promise<RootSession> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-context-lineage-combined-")));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  const requestsPath = join(cwd, "requests.jsonl");
  await writeFile(requestsPath, "");
  const providerPath = join(cwd, "offline-provider.ts");
  await writeFile(providerPath, providerSource(requestsPath));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [
        providerPath,
        ...extensions.map((entrypoint) => resolve(repositoryRoot, entrypoint)),
      ],
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
  // Minimal Subagents reads Pi's agent directory when the session starts.
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: MODEL,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
    settingsManager,
  });
  sessions.push(session);
  await session.bindExtensions({ mode: "print" });
  return {
    session,
    requests: async () =>
      (await readFile(requestsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => Value.Parse(ContextSchema, JSON.parse(line))),
  };
}

// Only the fields these assertions read; the provider records whole contexts.
const ContextSchema = Type.Unsafe<Context>(
  Type.Object({ messages: Type.Array(Type.Object({ role: Type.String() })) }),
);

const ListedNotes = Type.Object({
  notes: Type.Array(Type.Object({ name: Type.String(), agent: Type.Optional(Type.String()) }, {})),
});

type ContentBlock = { type: string; text?: string };

function textOf(content: string | readonly ContentBlock[]): string {
  return Value.Check(Type.String(), content)
    ? content
    : content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

/** The `context_notes` results in a request's messages, in order. */
function notesResults(context: Context) {
  return context.messages.flatMap((message) =>
    message.role === "toolResult" && message.toolName === "context_notes"
      ? [{ isError: message.isError, text: textOf(message.content) }]
      : [],
  );
}

/** The Notes of the first `context_notes` list result in a request's messages. */
function listedNotes(context: Context) {
  const result = notesResults(context).find(({ text }) => text.includes('"notes"'));
  if (!result) throw new Error("No context_notes list result");
  return Value.Parse(ListedNotes, JSON.parse(result.text)).notes;
}

function firstUserText(context: Context): string {
  const message = context.messages.find((candidate) => candidate.role === "user");
  return message?.role === "user" ? textOf(message.content) : "";
}

/**
 * What the named tools put before the model, in registration order, as one JSON string: each
 * declaration, and the prompt snippet and guidelines it adds to the system prompt.
 */
function declarations(session: AgentSession, names: readonly string[]): string {
  const tools = session.getAllTools().filter((tool) => names.includes(tool.name));
  expect(tools.map((tool) => tool.name).toSorted()).toEqual(names.toSorted());
  return JSON.stringify(
    tools.map(({ name, description, parameters }) => {
      const definition = session.getToolDefinition(name);
      return {
        name,
        description,
        parameters,
        promptSnippet: definition?.promptSnippet ?? null,
        promptGuidelines: definition?.promptGuidelines ?? null,
      };
    }),
  );
}

describe("Context Management with Minimal Subagents", () => {
  test("a Child Agent lists its root's Notes through the lineage scope", async () => {
    const root = await startRoot(collectionOrder);
    await root.session.prompt("COMBINED");
    const requests = await root.requests();
    const childRequest = requests.find(
      (context) =>
        firstUserText(context).includes(CHILD_TASK) &&
        context.messages.some((message) => message.role === "toolResult"),
    );
    if (!childRequest) throw new Error("The Child Agent never received its list result");
    expect(listedNotes(childRequest)).toContainEqual(
      expect.objectContaining({ name: "plan", agent: "root" }),
    );
    const rootFinal = requests.findLast((context) => firstUserText(context) === "COMBINED");
    expect(
      rootFinal?.messages.some(
        (message) => message.role === "toolResult" && message.toolName === "subagent_wait",
      ),
    ).toBe(true);
  }, 60_000);

  test("each package declares the same tools to the model whether or not the other is loaded", async () => {
    const both = await startRoot(collectionOrder);
    const contextAlone = await startRoot([CONTEXT_ENTRYPOINT]);
    const subagentsAlone = await startRoot([SUBAGENTS_ENTRYPOINT]);
    expect(declarations(contextAlone.session, CONTEXT_TOOLS)).toBe(
      declarations(both.session, CONTEXT_TOOLS),
    );
    expect(declarations(subagentsAlone.session, COORDINATOR_TOOLS)).toBe(
      declarations(both.session, COORDINATOR_TOOLS),
    );
  }, 60_000);

  test("Context Management alone answers the lineage scope with the session's own Notes", async () => {
    const root = await startRoot([CONTEXT_ENTRYPOINT]);
    await root.session.prompt("STANDALONE");
    const requests = await root.requests();
    const final = requests.at(-1);
    if (!final) throw new Error("No model request");
    expect(notesResults(final).map(({ isError }) => isError)).toEqual([false, false]);
    expect(listedNotes(final)).toEqual([expect.objectContaining({ name: "own", agent: "root" })]);
  }, 60_000);
});
