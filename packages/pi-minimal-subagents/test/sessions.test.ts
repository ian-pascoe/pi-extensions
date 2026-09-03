import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  AssistantMessage,
  Model,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  AgentSession,
  SessionManager,
  SettingsManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChildResourceLoader } from "../src/minimal-subagents-child-resources.js";
import {
  captureChildTurnOutcome,
  createPersistentChildIdentity,
  findDeliveryEvidence,
  PiAgentSessionFactory,
  resolveChildActiveToolNames,
  verifyChildSessionIdentity,
  type SessionFileTrashCapability,
} from "../src/minimal-subagents-sessions.js";
import type { CoordinatorMessage, PersistedAgent } from "../src/minimal-subagents-types.js";

const temporaryDirectories: string[] = [];
const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const TEST_MODEL: Model<"openai-completions"> = {
  id: "model",
  name: "Child tool adapter test model",
  api: "openai-completions",
  provider: "provider",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

function userMessage(text: string, timestamp: number): UserMessage {
  return { role: "user", content: text, timestamp };
}

function assistantMessage(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "model",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp,
  };
}

function customMessageEntry<TDetails>(customType: string, details: TDetails): SessionEntry {
  return {
    type: "custom_message",
    id: `custom-${customType}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType,
    content: "evidence",
    details,
    display: false,
  };
}

function toolResultEntry<TDetails>(toolName: string, details: TDetails): SessionEntry {
  const message: ToolResultMessage<TDetails> = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName,
    content: [{ type: "text", text: "result" }],
    details,
    isError: false,
    timestamp: 1,
  };
  return {
    type: "message",
    id: "tool-result",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message,
  };
}

const unavailableSessionFileTrash: SessionFileTrashCapability = {
  async moveSessionFile() {
    return Object.assign(new Error("trash unavailable"), { code: "ENOENT" });
  },
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function persistedAgent(): PersistedAgent {
  return {
    agent_id: "child",
    friendly_id: "child",
    parent_id: "root",
    created_at: "2026-01-01T00:00:00.000Z",
    spawn_entry_id: "entry",
    launch_contract: {
      session_context: "inherit",
      project_context: "inherit",
      model: "provider/model",
      thinking_level: "medium",
      tools: "read",
      ordinary_tools: ["read"],
      delegation: "fanout",
    },
    capability_ceiling: ["read"],
    availability: "available",
    missing_dependencies: [],
    recent_messages: [],
  };
}

describe("minimal subagent sessions", () => {
  it("retains a finalized assistant response when compaction replaces session context", async () => {
    type Listener = Parameters<AgentSession["subscribe"]>[0];
    const listeners = new Set<Listener>();
    const session: Pick<AgentSession, "subscribe"> = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const outcome = await captureChildTurnOutcome(
      session,
      async () => {
        const assistant = assistantMessage("completed before compaction", 1);
        for (const listener of listeners) listener({ type: "message_end", message: assistant });
      },
      () => false,
    );
    expect(outcome).toMatchObject({
      status: "completed",
      output: "completed before compaction",
    });
  });

  it("queues an active-turn coordination message without starting a second prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-active-turn-message-"));
    temporaryDirectories.push(directory);
    const agent = persistedAgent();
    const identity = createPersistentChildIdentity({
      agent,
      importedMessages: [],
      cwd: directory,
      sessionDir: directory,
      rootSessionId: "root",
    });
    agent.session_file = identity.sessionFile;
    agent.session_id = identity.sessionId;
    agent.session_leaf_id = identity.sessionLeafId;
    const factory = new PiAgentSessionFactory({
      cwd: directory,
      agentDir: directory,
      sessionDir: directory,
      rootSessionId: "root",
      extensionEntrypoint: join(directory, "index.ts"),
      models: [TEST_MODEL],
      eligibleModelIds: ["provider/model"],
      modelScopeRestricted: false,
      availableToolNames: ["read"],
      projectTrusted: true,
      getCoordinatorTools: () => [],
    });
    const runtime = await factory.openRuntime(agent);
    const secondPrompt = vi
      .spyOn(AgentSession.prototype, "sendCustomMessage")
      .mockRejectedValue(
        new Error(
          "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
        ),
      );
    const steer = vi.spyOn(Agent.prototype, "steer");
    const message: CoordinatorMessage = {
      customType: "minimal-subagents.message",
      content: "change direction",
      details: {
        source_agent_id: "root",
        destination_agent_id: "child",
        source_turn_id: "root:turn",
        message_id: "message",
      },
    };

    try {
      await expect(runtime.queueCoordinatorMessage(message)).resolves.toBeUndefined();
      expect(secondPrompt).not.toHaveBeenCalled();
      expect(steer).toHaveBeenCalledWith(expect.objectContaining({ role: "custom" }));
    } finally {
      secondPrompt.mockRestore();
      steer.mockRestore();
      runtime.dispose();
    }
  });

  it("force-flushes persistent child identity before any model response", () => {
    const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-session-"));
    temporaryDirectories.push(directory);
    const identity = createPersistentChildIdentity({
      agent: persistedAgent(),
      importedMessages: [userMessage("hello", 1)],
      cwd: directory,
      sessionDir: directory,
      rootSessionId: "root-session",
    });
    const contents = readFileSync(identity.sessionFile, "utf8");
    expect(contents).toContain('"customType":"minimal-subagents.identity"');
    expect(contents).toContain('"canonical_agent_id":"child"');
    expect(contents).toContain('"content":"hello"');
  });

  it("clones an identity-only child before any assistant response", async () => {
    const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-identity-only-clone-"));
    temporaryDirectories.push(directory);
    const agent = persistedAgent();
    const identity = createPersistentChildIdentity({
      agent,
      importedMessages: [],
      cwd: directory,
      sessionDir: directory,
      rootSessionId: "root",
    });
    agent.session_file = identity.sessionFile;
    agent.session_id = identity.sessionId;
    agent.session_leaf_id = identity.sessionLeafId;
    const factory = new PiAgentSessionFactory({
      cwd: directory,
      agentDir: directory,
      sessionDir: directory,
      rootSessionId: "root",
      extensionEntrypoint: join(directory, "index.ts"),
      models: [],
      eligibleModelIds: [],
      modelScopeRestricted: false,
      availableToolNames: [],
      projectTrusted: true,
      getCoordinatorTools: () => [],
    });

    const clone = await factory.cloneSession(agent);

    expect(readFileSync(clone.sessionFile, "utf8")).toContain(
      '"customType":"minimal-subagents.fork-clone"',
    );
    const cloneSession = SessionManager.open(clone.sessionFile, directory, directory);
    expect(cloneSession.getSessionId()).toBe(clone.sessionId);
    expect(() =>
      verifyChildSessionIdentity(
        cloneSession,
        { ...agent, session_file: clone.sessionFile, session_id: clone.sessionId },
        "root",
      ),
    ).not.toThrow();
  });

  it("rejects a mismatched child identity before clone or deletion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-identity-mismatch-"));
    temporaryDirectories.push(directory);
    const owner = persistedAgent();
    const identity = createPersistentChildIdentity({
      agent: owner,
      importedMessages: [],
      cwd: directory,
      sessionDir: directory,
      rootSessionId: "root",
    });
    const impostor = { ...owner, agent_id: "other", friendly_id: "other" };
    impostor.session_file = identity.sessionFile;
    impostor.session_id = identity.sessionId;
    const sessionManager = SessionManager.open(identity.sessionFile, directory, directory);
    expect(() => verifyChildSessionIdentity(sessionManager, impostor, "root")).toThrow(
      "Minimal subagents session identity mismatch: ownership for other",
    );
    const factory = new PiAgentSessionFactory({
      cwd: directory,
      agentDir: directory,
      sessionDir: directory,
      rootSessionId: "root",
      extensionEntrypoint: join(directory, "index.ts"),
      models: [],
      eligibleModelIds: [],
      modelScopeRestricted: false,
      availableToolNames: [],
      projectTrusted: true,
      getCoordinatorTools: () => [],
    });
    await expect(factory.cloneSession(impostor)).rejects.toThrow("ownership for other");
    await expect(factory.trashSession(impostor)).rejects.toThrow("ownership for other");
    expect(existsSync(identity.sessionFile)).toBe(true);
  });

  it("clones a child into a distinct session without mutating the source", async () => {
    const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-fork-"));
    temporaryDirectories.push(directory);
    const agent = persistedAgent();
    const identity = createPersistentChildIdentity({
      agent,
      importedMessages: [],
      cwd: directory,
      sessionDir: directory,
      rootSessionId: "root",
    });
    const source = SessionManager.open(identity.sessionFile, directory, directory);
    source.appendSessionInfo("source child");
    source.appendMessage(userMessage("source task", 1));
    source.appendMessage(assistantMessage("source answer", 2));
    const selectedLeafId = source.getLeafId();
    source.appendCustomEntry("wrong-branch-tail", { should_not_clone: true });
    const sourceFile = source.getSessionFile();
    if (!sourceFile) throw new Error("source session was not persisted");
    const sourceBefore = readFileSync(sourceFile, "utf8");
    agent.session_file = sourceFile;
    agent.session_id = source.getSessionId();
    agent.session_leaf_id = selectedLeafId ?? undefined;
    const factory = new PiAgentSessionFactory({
      cwd: directory,
      agentDir: directory,
      sessionDir: directory,
      rootSessionId: "root",
      extensionEntrypoint: join(directory, "index.ts"),
      models: [],
      eligibleModelIds: [],
      modelScopeRestricted: false,
      availableToolNames: [],
      projectTrusted: true,
      getCoordinatorTools: () => [],
    });

    const clone = await factory.cloneSession(agent);
    const cloneSession = SessionManager.open(clone.sessionFile, directory, directory);
    expect(clone.sessionId).not.toBe(source.getSessionId());
    expect(cloneSession.getSessionId()).toBe(clone.sessionId);
    expect(readFileSync(sourceFile, "utf8")).toBe(sourceBefore);
    expect(readFileSync(sourceFile, "utf8")).not.toContain("minimal-subagents.fork-clone");
    expect(readFileSync(clone.sessionFile, "utf8")).toContain(
      '"customType":"minimal-subagents.fork-clone"',
    );
    expect(readFileSync(clone.sessionFile, "utf8")).not.toContain("wrong-branch-tail");
  });

  it("preserves real assistant turns and generation-specific ownership across A to B to C forks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-fork-ownership-"));
    temporaryDirectories.push(directory);
    const agent = persistedAgent();
    const sourceIdentity = createPersistentChildIdentity({
      agent,
      importedMessages: [],
      cwd: directory,
      sessionDir: directory,
      rootSessionId: "source-root",
    });
    agent.session_file = sourceIdentity.sessionFile;
    agent.session_id = sourceIdentity.sessionId;
    agent.session_leaf_id = sourceIdentity.sessionLeafId;
    const sourceSession = SessionManager.open(sourceIdentity.sessionFile, directory, directory);
    sourceSession.appendMessage(userMessage("generation A task", 1));
    sourceSession.appendMessage(assistantMessage("generation A answer", 2));
    agent.session_leaf_id = sourceSession.getLeafId() ?? undefined;
    const sourceFactory = new PiAgentSessionFactory({
      cwd: directory,
      agentDir: directory,
      sessionDir: directory,
      rootSessionId: "source-root",
      extensionEntrypoint: join(directory, "index.ts"),
      models: [],
      eligibleModelIds: [],
      modelScopeRestricted: false,
      availableToolNames: [],
      projectTrusted: true,
      getCoordinatorTools: () => [],
    });
    const clone = await sourceFactory.cloneSession(agent);
    const forkedAgent = {
      ...agent,
      session_file: clone.sessionFile,
      session_id: clone.sessionId,
      session_leaf_id: clone.sessionLeafId,
    };
    const destinationFactory = new PiAgentSessionFactory({
      cwd: directory,
      agentDir: directory,
      sessionDir: directory,
      rootSessionId: "destination-root",
      extensionEntrypoint: join(directory, "index.ts"),
      models: [],
      eligibleModelIds: [],
      modelScopeRestricted: false,
      availableToolNames: [],
      projectTrusted: true,
      getCoordinatorTools: () => [],
    });
    const cloneSession = SessionManager.open(clone.sessionFile, directory, directory);
    expect(() => verifyChildSessionIdentity(cloneSession, forkedAgent, "destination-root")).toThrow(
      "root owner for child",
    );
    await expect(
      destinationFactory.adoptForkSessionOwnership(forkedAgent, "wrong-source-root"),
    ).rejects.toThrow("fork provenance for child");

    const adopted = await destinationFactory.adoptForkSessionOwnership(forkedAgent, "source-root");
    forkedAgent.session_leaf_id = adopted.sessionLeafId;
    const adoptedSession = SessionManager.open(adopted.sessionFile, directory, directory);
    expect(() =>
      verifyChildSessionIdentity(adoptedSession, forkedAgent, "destination-root"),
    ).not.toThrow();
    expect(() => verifyChildSessionIdentity(adoptedSession, forkedAgent, "source-root")).toThrow(
      "root owner for child",
    );
    expect(readFileSync(adopted.sessionFile, "utf8")).toContain(
      '"destination_root_session_id":"destination-root"',
    );
    adoptedSession.appendMessage(userMessage("generation B task", 3));
    adoptedSession.appendMessage(assistantMessage("generation B answer", 4));
    forkedAgent.session_leaf_id = adoptedSession.getLeafId() ?? undefined;

    const secondClone = await destinationFactory.cloneSession(forkedAgent);
    const secondForkAgent = {
      ...forkedAgent,
      session_file: secondClone.sessionFile,
      session_id: secondClone.sessionId,
      session_leaf_id: secondClone.sessionLeafId,
    };
    const nextDestinationFactory = new PiAgentSessionFactory({
      cwd: directory,
      agentDir: directory,
      sessionDir: directory,
      rootSessionId: "next-destination-root",
      extensionEntrypoint: join(directory, "index.ts"),
      models: [],
      eligibleModelIds: [],
      modelScopeRestricted: false,
      availableToolNames: [],
      projectTrusted: true,
      getCoordinatorTools: () => [],
    });
    const secondAdoption = await nextDestinationFactory.adoptForkSessionOwnership(
      secondForkAgent,
      "destination-root",
    );
    secondForkAgent.session_leaf_id = secondAdoption.sessionLeafId;
    const secondAdoptedSession = SessionManager.open(
      secondAdoption.sessionFile,
      directory,
      directory,
    );
    secondAdoptedSession.appendMessage(userMessage("generation C task", 5));
    secondAdoptedSession.appendMessage(assistantMessage("generation C answer", 6));
    secondForkAgent.session_leaf_id = secondAdoptedSession.getLeafId() ?? undefined;
    expect(() =>
      verifyChildSessionIdentity(secondAdoptedSession, secondForkAgent, "next-destination-root"),
    ).not.toThrow();
    const secondContents = readFileSync(secondAdoption.sessionFile, "utf8");
    expect(secondContents).toContain("generation A answer");
    expect(secondContents).toContain("generation B answer");
    expect(secondContents).toContain("generation C answer");
    const currentOwnershipEntries = secondAdoptedSession
      .getBranch()
      .filter(
        (entry) =>
          entry.type === "custom" && entry.customType === "minimal-subagents.fork-ownership",
      );
    expect(currentOwnershipEntries).toHaveLength(2);
    expect(currentOwnershipEntries.at(-1)).toMatchObject({
      data: { clone_session_id: secondAdoptedSession.getSessionId() },
    });
  });

  it("loads all configured extensions except the coordinator entrypoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-resources-"));
    temporaryDirectories.push(directory);
    const coordinatorEntrypoint = join(directory, "index.ts");
    const selectedEntrypoint = join(directory, "selected.ts");
    const otherEntrypoint = join(directory, "other.ts");
    for (const extensionPath of [coordinatorEntrypoint, selectedEntrypoint, otherEntrypoint]) {
      writeFileSync(extensionPath, "export default function extension() {}\n");
    }
    writeFileSync(
      join(directory, "settings.json"),
      JSON.stringify({
        extensions: [coordinatorEntrypoint, selectedEntrypoint, otherEntrypoint],
      }),
    );
    const loader = createChildResourceLoader({
      cwd: directory,
      agentDir: directory,
      projectContext: "inherit",
      extensionEntrypoint: coordinatorEntrypoint,
      systemPromptBlock: "child prompt",
      settingsManager: SettingsManager.create(directory, directory, { projectTrusted: true }),
    });

    await loader.reload();

    expect(loader.getExtensions().extensions.map((extension) => extension.resolvedPath)).toEqual([
      selectedEntrypoint,
      otherEntrypoint,
    ]);
  });

  it("lets retained tool adapters replace a complete read bundle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-tool-adapter-runtime-"));
    temporaryDirectories.push(directory);
    const adapterEntrypoint = join(directory, "tool-adapter.ts");
    const codeModeEntrypoint = resolve(import.meta.dirname, "../../pi-codemode/src/index.ts");
    const globalObserverEntrypoint = join(directory, "global-observer.ts");
    const globalObserverMarker = join(directory, "global-observer-ran");
    const lateToolMarker = join(directory, "late-tool-activated");
    const projectAdapterEntrypoint = join(directory, ".pi", "project-adapter.ts");
    const projectAdapterMarker = join(directory, "project-adapter-ran");
    writeFileSync(
      adapterEntrypoint,
      `import { Type } from "typebox";
export default function adapter(pi) {
  pi.registerTool({
    name: "exec_command",
    label: "exec_command",
    description: "test adapter command",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
  });
  pi.registerTool({
    name: "write_stdin",
    label: "write_stdin",
    description: "test adapter input",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
  });
  pi.on("session_start", () => pi.setActiveTools(["exec_command", "write_stdin", "project_tool"]));
}
`,
    );
    writeFileSync(
      globalObserverEntrypoint,
      `import { writeFileSync } from "node:fs";
import { Type } from "typebox";
export default function globalObserver(pi) {
  pi.on("session_start", () => {
    writeFileSync(${JSON.stringify(globalObserverMarker)}, "ran");
    setTimeout(() => {
      pi.registerTool({
        name: "late_tool",
        label: "late_tool",
        description: "late test tool",
        parameters: Type.Object({}),
        async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
      });
      pi.setActiveTools([...pi.getActiveTools(), "late_tool"]);
      writeFileSync(${JSON.stringify(lateToolMarker)}, "ran");
    }, 0);
  });
}
`,
    );
    mkdirSync(join(directory, ".pi"));
    writeFileSync(
      projectAdapterEntrypoint,
      `import { writeFileSync } from "node:fs";
import { Type } from "typebox";
export default function projectAdapter(pi) {
  writeFileSync(${JSON.stringify(projectAdapterMarker)}, "ran");
  pi.registerTool({
    name: "project_tool",
    label: "project_tool",
    description: "test project adapter command",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
  });
}
`,
    );
    writeFileSync(
      join(directory, ".pi", "settings.json"),
      JSON.stringify({ extensions: [projectAdapterEntrypoint] }),
    );
    writeFileSync(
      join(directory, "settings.json"),
      JSON.stringify({
        extensions: [adapterEntrypoint, globalObserverEntrypoint, codeModeEntrypoint],
      }),
    );
    const agent = persistedAgent();
    const identity = createPersistentChildIdentity({
      agent,
      importedMessages: [],
      cwd: directory,
      sessionDir: directory,
      rootSessionId: "root",
    });
    agent.session_file = identity.sessionFile;
    agent.session_id = identity.sessionId;
    agent.session_leaf_id = identity.sessionLeafId;
    agent.launch_contract.ordinary_tools = ["read", "grep", "find", "ls"];
    agent.capability_ceiling = ["read", "grep", "find", "ls"];
    agent.launch_contract.project_context = "omit";
    const factory = new PiAgentSessionFactory({
      cwd: directory,
      agentDir: directory,
      sessionDir: directory,
      rootSessionId: "root",
      extensionEntrypoint: join(directory, "minimal-subagents.ts"),
      models: [TEST_MODEL],
      eligibleModelIds: ["provider/model"],
      modelScopeRestricted: false,
      availableToolNames: ["read", "grep", "find", "ls", "bash", "exec_command", "write_stdin"],
      getRuntimeToolAdapters: () => [
        {
          toolNames: ["exec_command", "write_stdin"],
          replacements: [
            {
              sourceToolNames: ["read", "grep", "find", "ls"],
              runtimeToolNames: ["exec_command", "write_stdin"],
            },
            {
              sourceToolNames: ["bash"],
              runtimeToolNames: ["exec_command", "write_stdin"],
            },
          ],
        },
        {
          toolNames: ["project_tool"],
          replacements: [],
        },
      ],
      projectTrusted: true,
      getCoordinatorTools: () => [],
    });

    const runtime = await factory.openRuntime(agent);

    try {
      await vi.waitFor(() => expect(existsSync(lateToolMarker)).toBe(true));
      expect(runtime.getActiveToolNames?.()).toEqual(["exec_command", "write_stdin"]);
      expect(existsSync(globalObserverMarker)).toBe(true);
      expect(existsSync(projectAdapterMarker)).toBe(true);
    } finally {
      runtime.dispose();
    }

    const shellAgent = persistedAgent();
    shellAgent.agent_id = "shell-child";
    shellAgent.friendly_id = "shell-child";
    shellAgent.launch_contract.tools = ["read", "bash"];
    shellAgent.launch_contract.ordinary_tools = ["read", "bash"];
    shellAgent.launch_contract.project_context = "omit";
    shellAgent.capability_ceiling = ["read", "bash"];
    const shellIdentity = createPersistentChildIdentity({
      agent: shellAgent,
      importedMessages: [],
      cwd: directory,
      sessionDir: directory,
      rootSessionId: "root",
    });
    shellAgent.session_file = shellIdentity.sessionFile;
    shellAgent.session_id = shellIdentity.sessionId;
    shellAgent.session_leaf_id = shellIdentity.sessionLeafId;
    rmSync(lateToolMarker);

    const shellRuntime = await factory.openRuntime(shellAgent);

    try {
      await vi.waitFor(() => expect(existsSync(lateToolMarker)).toBe(true));
      expect(shellRuntime.getActiveToolNames?.()).toEqual(["read", "exec_command", "write_stdin"]);
    } finally {
      shellRuntime.dispose();
    }
  }, 15_000);

  it("keeps arbitrary runtime tool replacements inside the Launch Contract", () => {
    const toolName = fc.stringMatching(/^[a-z][a-z0-9_]{0,11}$/);
    const toolNames = fc.uniqueArray(toolName, { maxLength: 12 });
    const replacements = fc.array(
      fc.record({
        sourceToolNames: fc.uniqueArray(toolName, { minLength: 1, maxLength: 4 }),
        runtimeToolNames: fc.uniqueArray(toolName, { minLength: 1, maxLength: 4 }),
      }),
      { maxLength: 6 },
    );

    fc.assert(
      fc.property(toolNames, toolNames, replacements, (allowed, requested, generated) => {
        const activeReplacements = generated.filter(
          (replacement) =>
            replacement.sourceToolNames.every((name) => allowed.includes(name)) &&
            replacement.runtimeToolNames.every((name) => requested.includes(name)),
        );
        const permitted = new Set([
          ...allowed,
          ...activeReplacements.flatMap((replacement) => replacement.runtimeToolNames),
        ]);
        const replaced = new Set(
          activeReplacements.flatMap((replacement) => replacement.sourceToolNames),
        );
        const resolved = resolveChildActiveToolNames(allowed, requested, [
          {
            toolNames: generated.flatMap((replacement) => replacement.runtimeToolNames),
            replacements: generated,
          },
        ]);

        expect(new Set(resolved).size).toBe(resolved.length);
        expect(resolved.every((name) => permitted.has(name))).toBe(true);
        expect(allowed.every((name) => replaced.has(name) || resolved.includes(name))).toBe(true);
      }),
    );
  });

  it("omits only project AGENTS context and skills", async () => {
    const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-project-context-"));
    temporaryDirectories.push(directory);
    const agentDir = join(directory, "agent");
    const projectDir = join(directory, "project");
    mkdirSync(join(agentDir, "skills", "user-skill"), { recursive: true });
    mkdirSync(join(agentDir, "skills", "shared-skill"), { recursive: true });
    mkdirSync(join(projectDir, ".pi", "skills", "project-skill"), { recursive: true });
    mkdirSync(join(projectDir, ".pi", "skills", "shared-skill"), { recursive: true });
    mkdirSync(join(projectDir, ".pi", "prompts"), { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "user context");
    writeFileSync(join(projectDir, "AGENTS.md"), "project context");
    writeFileSync(
      join(agentDir, "skills", "user-skill", "SKILL.md"),
      "---\nname: user-skill\ndescription: User skill\n---\n",
    );
    writeFileSync(
      join(projectDir, ".pi", "skills", "project-skill", "SKILL.md"),
      "---\nname: project-skill\ndescription: Project skill\n---\n",
    );
    writeFileSync(
      join(agentDir, "skills", "shared-skill", "SKILL.md"),
      "---\nname: shared-skill\ndescription: User fallback\n---\n",
    );
    writeFileSync(
      join(projectDir, ".pi", "skills", "shared-skill", "SKILL.md"),
      "---\nname: shared-skill\ndescription: Project winner\n---\n",
    );
    writeFileSync(join(projectDir, ".pi", "prompts", "project-prompt.md"), "Project prompt");
    writeFileSync(join(projectDir, ".pi", "SYSTEM.md"), "Project system prompt");
    writeFileSync(join(projectDir, ".pi", "APPEND_SYSTEM.md"), "Project appended prompt");
    const loader = createChildResourceLoader({
      cwd: projectDir,
      agentDir,
      projectContext: "omit",
      extensionEntrypoint: join(directory, "index.ts"),
      systemPromptBlock: "child prompt",
      settingsManager: SettingsManager.create(projectDir, agentDir, { projectTrusted: true }),
    });

    await loader.reload();

    expect(loader.getAgentsFiles().agentsFiles.map(({ content }) => content)).toEqual([
      "user context",
    ]);
    const skillNames = loader.getSkills().skills.map(({ name }) => name);
    expect(skillNames).toContain("user-skill");
    expect(skillNames).not.toContain("project-skill");
    expect(loader.getSkills().skills.find(({ name }) => name === "shared-skill")?.description).toBe(
      "User fallback",
    );
    expect(loader.getPrompts().prompts.map(({ name }) => name)).toContain("project-prompt");
    expect(loader.getSystemPrompt()).toBe("Project system prompt");
    expect(loader.getAppendSystemPrompt()).toEqual(["Project appended prompt", "child prompt"]);
  });

  it("finds exact delivery evidence in custom results and wait tool results", () => {
    const details = { source_agent_id: "child", source_turn_id: "turn" };
    expect(
      findDeliveryEvidence(
        [customMessageEntry("minimal-subagents.result", details)],
        "child",
        "turn",
      ),
    ).toBe(true);
    expect(
      findDeliveryEvidence([toolResultEntry("subagent_wait", details)], "child", "other"),
    ).toBe(false);
    const coordinationEvidence = customMessageEntry("minimal-subagents.message", {
      ...details,
      delivery_id: "message:1",
    });
    expect(findDeliveryEvidence([coordinationEvidence], "child", "turn", "message:1")).toBe(true);
    expect(findDeliveryEvidence([coordinationEvidence], "child", "turn")).toBe(false);
    expect(
      findDeliveryEvidence(
        [
          customMessageEntry("minimal-subagents.result", {
            ...details,
            messages: [{ delivery_id: "message:batched" }],
          }),
        ],
        "child",
        "turn",
        "message:batched",
      ),
    ).toBe(true);
    expect(
      findDeliveryEvidence(
        [toolResultEntry("subagent_wait", { ...details, event: "message" })],
        "child",
        "turn",
      ),
    ).toBe(false);
    expect(
      findDeliveryEvidence(
        [
          toolResultEntry("subagent_wait", {
            ...details,
            event: "turn",
            messages: [{ delivery_id: "message:2" }],
          }),
        ],
        "child",
        "turn",
        "message:2",
      ),
    ).toBe(true);
  });

  it("falls back to unlinking a session when the optional trash command fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-trash-"));
    temporaryDirectories.push(directory);
    const agent = persistedAgent();
    const identity = createPersistentChildIdentity({
      agent,
      importedMessages: [],
      cwd: directory,
      sessionDir: directory,
      rootSessionId: "root",
    });
    agent.session_file = identity.sessionFile;
    agent.session_id = identity.sessionId;
    agent.session_leaf_id = identity.sessionLeafId;
    const factory = new PiAgentSessionFactory({
      cwd: directory,
      agentDir: directory,
      sessionDir: directory,
      rootSessionId: "root",
      extensionEntrypoint: join(directory, "index.ts"),
      models: [],
      eligibleModelIds: [],
      modelScopeRestricted: false,
      availableToolNames: [],
      projectTrusted: true,
      sessionFileTrash: unavailableSessionFileTrash,
      getCoordinatorTools: () => [],
    });
    await factory.trashSession(agent);
    expect(existsSync(identity.sessionFile)).toBe(false);
  });

  it("discovers unavailable launch models and built-in tools without opening a runtime", async () => {
    const factory = new PiAgentSessionFactory({
      cwd: "/tmp/project",
      agentDir: "/tmp/agent",
      sessionDir: "/tmp/sessions",
      rootSessionId: "root",
      extensionEntrypoint: "/tmp/index.ts",
      models: [],
      eligibleModelIds: [],
      modelScopeRestricted: false,
      availableToolNames: ["read"],
      projectTrusted: true,
      getCoordinatorTools: () => [],
    });
    const agent = persistedAgent();
    agent.launch_contract.ordinary_tools = ["read", "write"];
    await expect(factory.resolveLaunchMissingDependencies(agent)).resolves.toEqual([
      "provider/model",
      "write",
    ]);
  });
});
