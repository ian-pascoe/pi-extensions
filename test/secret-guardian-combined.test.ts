/**
 * Combined-mode test: Pi Secret and Pi Guardian loaded together as the Git collection loads them.
 *
 * Why this lives at the repository root: see `formatter-lsp-combined-order.test.ts`. Neither
 * package depends on the other; they share held Secret values only through pi-utils' secret
 * registry (ADR-0008).
 *
 * What it pins: Pi Secret resolves `{{secret:NAME}}` in a call's arguments in its `tool_call`
 * handler, and Guardian snapshots arguments in its own. Whichever loads first, the tool receives
 * the value, while Guardian's review request and audit journal hold only the Secret Reference and
 * Guardian reports no argument drift.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import rootManifest from "../package.json" with { type: "json" };

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const SECRET_ENTRYPOINT = "./packages/pi-secret/src/index.ts";
const GUARDIAN_ENTRYPOINT = "./packages/pi-guardian/src/index.ts";

/** The two extensions in the order the root `package.json` lists them, which Pi loads in. */
const collectionOrder = rootManifest.pi.extensions.filter(
  (entrypoint) => entrypoint === SECRET_ENTRYPOINT || entrypoint === GUARDIAN_ENTRYPOINT,
);

const agentModel: Model<"openai-completions"> = {
  id: "agent",
  name: "Agent",
  api: "openai-completions",
  provider: "secret-combined",
  baseUrl: "https://guardian.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 2_048,
};

const directories: string[] = [];
const sessions: AgentSession[] = [];

/**
 * Pi compiles extension TypeScript with jiti and caches it on disk; on a fresh CI runner the first
 * load of pi-secret and pi-guardian runs past the test timeout under a cold `bun run verify`. Loading
 * both once here keeps that one-time cost out of the first test. The hook timeout only guards
 * against a hang.
 */
beforeAll(async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-secret-guardian-warm-up-"));
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

function toolCalls(...calls: [name: string, args: ToolCall["arguments"], id: string][]) {
  const message: AssistantMessage = {
    ...fauxAssistantMessage(""),
    content: calls.map(([name, args, id]) => ({ type: "toolCall", name, arguments: args, id })),
    stopReason: "toolUse",
  };
  return message;
}

async function run(order: readonly string[], value: string) {
  const dir = await mkdtemp(join(tmpdir(), "pi-secret-guardian-"));
  directories.push(dir);
  await writeFile(
    join(dir, "settings.json"),
    JSON.stringify({
      compaction: { enabled: false },
      retry: { enabled: false },
      guardian: { enabled: true, model: "secret-combined/reviewer" },
    }),
  );
  const received: string[] = [];
  const reviews: string[] = [];
  const fixture: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: "deploy",
      label: "Deploy",
      description: "Deploy with a token.",
      parameters: Type.Object({ token: Type.String() }),
      async execute(_id, params) {
        received.push(params.token);
        return { content: [{ type: "text", text: "deployed" }], details: {} };
      },
    });
    pi.registerProvider("secret-combined", {
      api: "openai-completions",
      apiKey: "offline",
      baseUrl: "https://guardian.invalid",
      models: ["agent", "reviewer"].map((id) => ({
        id,
        name: id,
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 2_048,
      })),
      streamSimple: (model, context) => {
        reviews.push(JSON.stringify(context));
        const stream = createAssistantMessageEventStream();
        const text = JSON.stringify({
          risk_level: "low",
          user_authorization: "high",
          rationale: "The user asked for this deployment.",
        });
        const message = {
          ...fauxAssistantMessage(text),
          api: model.api,
          provider: model.provider,
          model: model.id,
        };
        queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
        return stream;
      },
    });
  };
  const settingsManager = SettingsManager.create(dir, dir);
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [fixture],
    additionalExtensionPaths: order.map((entrypoint) => resolve(repositoryRoot, entrypoint)),
    systemPromptOverride: () => "Standing instructions: finish the user's task.",
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    sessionManager: SessionManager.create(dir, join(dir, "sessions")),
    settingsManager,
    resourceLoader: loader,
    modelRuntime: await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    }),
    model: agentModel,
    noTools: "builtin",
  });
  sessions.push(session);
  const responses = [
    toolCalls(["secret_ask", { names: ["DEPLOY_TOKEN"] }, "call-ask"]),
    toolCalls(["deploy", { token: "{{secret:DEPLOY_TOKEN}}" }, "call-deploy"]),
    fauxAssistantMessage("Deployed."),
  ];
  session.agent.streamFunction = (model) => {
    const next = responses.shift() ?? fauxAssistantMessage("Done.");
    const message = { ...next, api: model.api, provider: model.provider, model: model.id };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() =>
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      }),
    );
    return stream;
  };
  const notices: string[] = [];
  const runner = session.extensionRunner;
  await session.bindExtensions({
    mode: "tui",
    uiContext: {
      ...runner.getUIContext(),
      notify: (text) => notices.push(text),
      custom: (factory) =>
        new Promise((resolveDialog) => {
          void (async () => {
            const dialog: Component = await factory(
              // SAFETY: the dialog only asks the TUI to re-render.
              { requestRender: () => {} } as never,
              // SAFETY: the dialog styles only through `fg`, `bg`, and `bold`.
              { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
              // SAFETY: the dialog matches keys through the keybindings manager only.
              getKeybindings() as never,
              resolveDialog,
            );
            dialog.handleInput?.(`\x1b[200~${value}\x1b[201~`);
            dialog.handleInput?.("\r");
          })();
        }),
    },
  });
  await session.prompt("Deploy with my token.");
  const journal = session.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "custom" && entry.customType === "pi-guardian-review" ? [entry.data] : [],
    );
  return { received, reviews, journal, notices };
}

describe("Pi Secret with Pi Guardian", () => {
  test("the collection loads Pi Secret before Guardian", () => {
    expect(collectionOrder).toEqual([SECRET_ENTRYPOINT, GUARDIAN_ENTRYPOINT]);
  });

  test.each([
    ["collection", collectionOrder, "tok-collection-5f1d0a"],
    ["swapped", collectionOrder.toReversed(), "tok-swapped-c27e94"],
  ])(
    "in %s order, Guardian reviews only the Secret Reference the tool receives the value for",
    async (_name, order, value) => {
      const { received, reviews, journal, notices } = await run(order, value);

      expect(received).toEqual([value]);
      // secret_ask runs without review; the deploy call is reviewed once.
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toContain("{{secret:DEPLOY_TOKEN}}");
      expect(reviews[0]).not.toContain(value);
      expect(journal).toMatchObject([
        { toolName: "deploy", result: "allowed", arguments: '{"token":"{{secret:DEPLOY_TOKEN}}"}' },
      ]);
      expect(JSON.stringify(journal)).not.toContain(value);
      expect(journal[0]).not.toHaveProperty("argumentDrift");
      expect(notices.filter((notice) => notice.includes("load Guardian last"))).toEqual([]);
    },
  );
});
