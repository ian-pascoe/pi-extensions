/**
 * Coexistence with pi-minimal-subagents (plan step 7).
 *
 * The child here is a real in-process Child Agent: it is opened by pi-minimal-subagents'
 * `PiAgentSessionFactory`, exactly as the coordinator does, with its own SessionManager and
 * session id, its own resource loader, and the pi-termctrl extension loaded from settings through
 * jiti (a fresh module instance sharing the process registry on `globalThis`). Only its model
 * stream and the termctrl driver are scripted. The parent is a real Pi session from
 * `createSdkFixture`. Disposing the child runtime is the coordinator's shutdown path
 * (`session_shutdown` with reason `quit`).
 *
 * The child is granted `terminal_start`, which pi-minimal-subagents verifies before the child's
 * `session_start`; pi-termctrl therefore registers its Terminal tools at load. The child starts a
 * Terminal and Background jobs through the replaced `bash`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { EXIT_NOTIFICATION_TYPE } from "../src/exit-notification.js";
import { TermctrlRegistry } from "../src/termctrl-registry.js";
import { FakeDriverFactory } from "./fake-driver.js";
import { createSdkFixture, disposeSdkFixtures, settle } from "./sdk-fixture.js";

/** The subset of pi-minimal-subagents' `PersistedAgent` a launch needs. */
interface ChildAgentRecord {
  agent_id: string;
  friendly_id: string;
  parent_id: string;
  created_at: string;
  spawn_entry_id: string;
  session_file?: string;
  session_id?: string;
  session_leaf_id?: string;
  launch_contract: {
    session_context: "inherit";
    project_context: "inherit";
    model: string;
    thinking_level: "medium";
    tools: "modify";
    ordinary_tools: string[];
    delegation: "none";
  };
  capability_ceiling: string[];
  availability: "available";
  missing_dependencies: string[];
  recent_messages: [];
}

/** The subset of pi-minimal-subagents' `ChildAgentRuntime` this test drives. */
interface ChildRuntime {
  runPrompt(
    task: string,
    compact: boolean,
    callerModel: string,
    callerThinkingLevel: "medium",
  ): Promise<{ status: string; output: string; error?: string }>;
  dispose(): Promise<void>;
  getActiveToolNames?(): string[];
}

/** The subset of pi-minimal-subagents' `PiAgentSessionFactory` this test drives. */
interface ChildSessionFactory {
  resolveLaunchMissingDependencies(agent: ChildAgentRecord): Promise<string[]>;
  createIdentity(
    agent: ChildAgentRecord,
    importedMessages: [],
  ): { sessionFile: string; sessionId: string; sessionLeafId?: string };
  openRuntime(agent: ChildAgentRecord): Promise<ChildRuntime>;
}

interface ChildSessionFactoryOptions {
  cwd: string;
  agentDir: string;
  sessionDir: string;
  rootSessionId: string;
  extensionEntrypoint: string;
  models: readonly Model<"openai-completions">[];
  eligibleModelIds: readonly string[];
  modelScopeRestricted: boolean;
  availableToolNames: readonly string[];
  projectTrusted: boolean;
  getCoordinatorTools: () => [];
  observeSession: (session: AgentSession) => undefined;
}

const CHILD_MODEL: Model<"openai-completions"> = {
  id: "model",
  name: "Coexistence child model",
  api: "openai-completions",
  provider: "anthropic",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};
const CHILD_MODEL_ID = "anthropic/model";

const available = { kind: "available", path: "/fake/termctrl" } as const;
const directories: string[] = [];
const runtimes: ChildRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  await disposeSdkFixtures();
  await TermctrlRegistry.teardownForTests();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function loadChildSessionFactory(): Promise<
  new (options: ChildSessionFactoryOptions) => ChildSessionFactory
> {
  // Load the sibling package's source without widening this package's TypeScript rootDir.
  const {
    PiAgentSessionFactory,
  }: { PiAgentSessionFactory: new (options: ChildSessionFactoryOptions) => ChildSessionFactory } =
    await import(
      new URL("../../pi-minimal-subagents/src/minimal-subagents-sessions.js", import.meta.url).href
    );
  return PiAgentSessionFactory;
}

interface ChildHarness {
  readonly factory: ChildSessionFactory;
  readonly agent: ChildAgentRecord;
  readonly sessions: AgentSession[];
  readonly responses: AssistantMessage[];
  readonly requests: number[];
}

/** A child agent directory whose settings load pi-termctrl with a scripted driver. */
async function createChildHarness(ordinaryTools: string[]): Promise<ChildHarness> {
  const directory = await mkdtemp(join(tmpdir(), "pi-termctrl-subagent-"));
  directories.push(directory);
  const wrapper = join(directory, "termctrl-child.ts");
  const extensionSource = fileURLToPath(
    new URL("../src/pi-termctrl-extension.ts", import.meta.url),
  );
  const fakeDriverSource = fileURLToPath(new URL("./fake-driver.ts", import.meta.url));
  await writeFile(
    wrapper,
    `import { createPiTermctrlExtension } from ${JSON.stringify(extensionSource)};
import { FakeDriverFactory } from ${JSON.stringify(fakeDriverSource)};
export default createPiTermctrlExtension({
  getAgentDirectory: () => ${JSON.stringify(directory)},
  resolveBinary: () => ({ kind: "available", path: "/fake/termctrl" }),
  createDriver: new FakeDriverFactory().create,
});
`,
  );
  await writeFile(
    join(directory, "settings.json"),
    JSON.stringify({ extensions: [wrapper], compaction: { enabled: false } }),
  );

  const sessions: AgentSession[] = [];
  const responses: AssistantMessage[] = [];
  const requests: number[] = [];
  const PiAgentSessionFactory = await loadChildSessionFactory();
  const factory = new PiAgentSessionFactory({
    cwd: directory,
    agentDir: directory,
    sessionDir: directory,
    rootSessionId: "root",
    extensionEntrypoint: join(directory, "minimal-subagents.ts"),
    models: [CHILD_MODEL],
    eligibleModelIds: [CHILD_MODEL_ID],
    modelScopeRestricted: false,
    availableToolNames: ordinaryTools,
    projectTrusted: false,
    getCoordinatorTools: () => [],
    observeSession(session) {
      sessions.push(session);
      session.agent.streamFunction = (model) => {
        requests.push(requests.length);
        const next = responses.shift();
        if (next === undefined) throw new Error("Unexpected child model request");
        const message: AssistantMessage = {
          ...next,
          api: model.api,
          provider: model.provider,
          model: model.id,
        };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const reason = message.stopReason;
          if (reason === "stop" || reason === "length" || reason === "toolUse") {
            stream.push({ type: "done", reason, message });
          }
        });
        return stream;
      };
      return undefined;
    },
  });
  const agent: ChildAgentRecord = {
    agent_id: "child",
    friendly_id: "child",
    parent_id: "root",
    created_at: "2026-01-01T00:00:00.000Z",
    spawn_entry_id: "entry",
    launch_contract: {
      session_context: "inherit",
      project_context: "inherit",
      model: CHILD_MODEL_ID,
      thinking_level: "medium",
      tools: "modify",
      ordinary_tools: ordinaryTools,
      delegation: "none",
    },
    capability_ceiling: ordinaryTools,
    availability: "available",
    missing_dependencies: [],
    recent_messages: [],
  };
  return { factory, agent, sessions, responses, requests };
}

async function openChild(
  harness: ChildHarness,
): Promise<{ runtime: ChildRuntime; session: AgentSession }> {
  const identity = harness.factory.createIdentity(harness.agent, []);
  harness.agent.session_file = identity.sessionFile;
  harness.agent.session_id = identity.sessionId;
  if (identity.sessionLeafId !== undefined) harness.agent.session_leaf_id = identity.sessionLeafId;
  const runtime = await harness.factory.openRuntime(harness.agent);
  runtimes.push(runtime);
  const session = harness.sessions.at(-1);
  if (session === undefined) throw new Error("child session was not observed");
  await session.modelRuntime.setRuntimeApiKey("anthropic", "TEST-NOT-A-REAL-KEY");
  return { runtime, session };
}

function exitNotificationIds(session: AgentSession): string[] {
  return session.messages.flatMap((message) =>
    message.role === "custom" && message.customType === EXIT_NOTIFICATION_TYPE
      ? [JSON.stringify(message.details)]
      : [],
  );
}

async function waitFor(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function entryStates(): [string, string][] {
  return (TermctrlRegistry.current()?.entries() ?? []).map(({ id, state }) => [id, state]);
}

test("a child agent's shutdown stops only its entries and no Exit notification crosses sessions", async () => {
  // Parent: a Terminal and a long Background job.
  const drivers = new FakeDriverFactory();
  const parent = await createSdkFixture({ binary: available, createDriver: drivers.create });
  const parentOwner = parent.session.sessionManager.getSessionId();
  parent.responses.push(
    fauxAssistantMessage(fauxToolCall("terminal_start", { command: "python3", wait_ms: 0 }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Terminal started."),
    fauxAssistantMessage(
      fauxToolCall("bash", { command: "echo parent; sleep 30", background: true }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Job started."),
  );
  await parent.session.prompt("Start a REPL");
  await settle(parent.session);
  await parent.session.prompt("Start a job");
  await settle(parent.session);
  expect(entryStates()).toEqual([
    ["t1", "running"],
    ["b1", "running"],
  ]);

  // Child: a short job that exits while the child lives, and a long job its shutdown must stop.
  const child = await createChildHarness(["bash", "terminal_start"]);
  await expect(child.factory.resolveLaunchMissingDependencies(child.agent)).resolves.toEqual([]);
  const { runtime, session: childSession } = await openChild(child);
  expect(runtime.getActiveToolNames?.()).toEqual(["bash", "terminal_start"]);
  const childOwner = childSession.sessionManager.getSessionId();
  expect(childOwner).not.toBe(parentOwner);
  child.responses.push(
    fauxAssistantMessage(
      [
        fauxToolCall("terminal_start", { command: "child-repl", wait_ms: 0 }),
        fauxToolCall("bash", { command: "echo child short; sleep 2.3", background: true }),
        fauxToolCall("bash", { command: "echo child long; sleep 30", background: true }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("The Terminal and both jobs are running."),
    fauxAssistantMessage("The short job finished."),
  );
  const outcome = await runtime.runPrompt("Start two jobs", false, CHILD_MODEL_ID, "medium");
  expect(outcome).toMatchObject({ status: "completed" });
  const registry = TermctrlRegistry.current();
  expect(registry?.ownedEntries(childOwner).map(({ id }) => id)).toEqual(["t2", "b2", "b3"]);
  expect(registry?.ownedEntries(parentOwner).map(({ id }) => id)).toEqual(["t1", "b1"]);

  // The short job's exit reaches the child, and starts a child turn, never the parent.
  await waitFor(
    () => exitNotificationIds(childSession).length === 1 && child.requests.length === 3,
  );
  await waitFor(() => !childSession.isStreaming);
  expect(exitNotificationIds(childSession)).toEqual([expect.stringContaining('"id":"b2"')]);
  expect(exitNotificationIds(parent.session)).toEqual([]);
  expect(parent.turns).toHaveLength(4);

  // The coordinator's shutdown of the child stops the child's entries only.
  runtimes.splice(runtimes.indexOf(runtime), 1);
  await runtime.dispose();
  expect(registry?.ownedEntries(childOwner)).toEqual([]);
  expect(entryStates()).toEqual([
    ["t1", "running"],
    ["b1", "running"],
  ]);
  expect(drivers.terminal(0).stopCalls).toBe(0);
  expect(drivers.terminal(1).request.command.at(-1)).toBe("child-repl");
  expect(drivers.terminal(1).stopCalls).toBe(1);

  // The parent still owns and drives its Terminal and job; nothing reached it from the child.
  parent.responses.push(
    fauxAssistantMessage(fauxToolCall("terminal_list", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Listed."),
  );
  await parent.session.prompt("What is running?");
  await settle(parent.session);
  const listed = JSON.stringify(parent.turns.at(-1)?.messages.at(-1));
  expect(listed).toContain("t1 running");
  expect(listed).toContain("b1 running");
  expect(listed).not.toContain("t2");
  expect(listed).not.toContain("b2");
  expect(listed).not.toContain("b3");
  expect(exitNotificationIds(parent.session)).toEqual([]);
}, 30_000);
