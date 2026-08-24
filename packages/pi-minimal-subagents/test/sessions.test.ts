import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  AgentSession,
  createExtensionRuntime,
  SessionManager,
  type Extension,
  type LoadExtensionsResult,
  type RegisteredTool,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureChildTurnOutcome,
  createChildResourceLoaderOptions,
  createPersistentChildIdentity,
  findDeliveryEvidence,
  PiAgentSessionFactory,
  verifyChildSessionIdentity,
  type SessionFileTrashCapability,
} from "../src/minimal-subagents-sessions.js";
import type { PersistedAgent } from "../src/minimal-subagents-types.js";

const temporaryDirectories: string[] = [];
const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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

function loadedExtension(resolvedPath: string, toolNames: readonly string[]): Extension {
  const sourceInfo: Extension["sourceInfo"] = {
    path: resolvedPath,
    source: resolvedPath,
    scope: "temporary",
    origin: "top-level",
  };
  const tools = new Map<string, RegisteredTool>();
  for (const toolName of toolNames) {
    tools.set(toolName, {
      sourceInfo,
      definition: {
        name: toolName,
        label: toolName,
        description: "test tool",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      },
    });
  }
  return {
    path: resolvedPath,
    resolvedPath,
    sourceInfo,
    handlers: new Map(),
    tools,
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
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

  it("filters the exact coordinator entrypoint and extensions missing selected tools", () => {
    const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-resources-"));
    temporaryDirectories.push(directory);
    const coordinatorEntrypoint = join(directory, "index.ts");
    const options = createChildResourceLoaderOptions({
      cwd: directory,
      agentDir: directory,
      projectContext: "inherit",
      extensionEntrypoint: coordinatorEntrypoint,
      systemPromptBlock: "child prompt",
      ordinaryToolNames: ["custom_read"],
    });
    const loadResult: LoadExtensionsResult = {
      extensions: [
        loadedExtension(coordinatorEntrypoint, ["custom_read"]),
        loadedExtension(join(directory, "selected.ts"), ["custom_read"]),
        loadedExtension(join(directory, "irrelevant.ts"), ["other"]),
      ],
      errors: [
        { path: coordinatorEntrypoint, error: "recursive" },
        { path: join(directory, "broken.ts"), error: "broken" },
      ],
      runtime: createExtensionRuntime(),
    };
    const result = options.extensionsOverride?.(loadResult);
    expect(result?.extensions.map((extension) => extension.resolvedPath)).toEqual([
      join(directory, "selected.ts"),
    ]);
    expect(result?.errors).toEqual([{ path: join(directory, "broken.ts"), error: "broken" }]);
  });

  it("omits project resources, recognizes built-ins, and appends the child prompt", () => {
    const options = createChildResourceLoaderOptions({
      cwd: "/tmp/project",
      agentDir: "/tmp/agent",
      projectContext: "omit",
      extensionEntrypoint: "/tmp/index.ts",
      systemPromptBlock: "child prompt",
      ordinaryToolNames: ["read"],
    });
    expect(options.noExtensions).toBe(true);
    expect(options.noContextFiles).toBe(true);
    expect(options.noSkills).toBe(true);
    expect(options.appendSystemPromptOverride?.(["base"])).toEqual(["child prompt"]);
  });

  it("inherits project resources and base prompt blocks when project context is included", () => {
    const options = createChildResourceLoaderOptions({
      cwd: "/tmp/project",
      agentDir: "/tmp/agent",
      projectContext: "inherit",
      extensionEntrypoint: "/tmp/index.ts",
      systemPromptBlock: "child prompt",
      ordinaryToolNames: ["read"],
    });
    expect(options.noExtensions).toBe(true);
    expect(options.noContextFiles).toBe(false);
    expect(options.noSkills).toBe(false);
    expect(options.noPromptTemplates).toBe(false);
    expect(options.agentsFilesOverride).toBeUndefined();
    expect(options.appendSystemPromptOverride?.(["base", "project"])).toEqual([
      "base",
      "project",
      "child prompt",
    ]);
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
