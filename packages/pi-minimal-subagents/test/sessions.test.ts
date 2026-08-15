import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));
import {
  buildDepthBoundSubagentPrompt,
  captureChildTurnOutcome,
  createChildResourceLoaderOptions,
  createPersistentChildIdentity,
  findDeliveryEvidence,
  PiAgentSessionFactory,
  verifyChildSessionIdentity,
} from "../src/minimal-subagents-sessions.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PersistedAgent } from "../src/minimal-subagents-types.js";

const temporaryDirectories: string[] = [];
beforeEach(() => {
  execFileMock
    .mockReset()
    .mockImplementation(
      (
        _command: string,
        _arguments: string[],
        callback: (error: NodeJS.ErrnoException | null) => void,
      ) => callback(Object.assign(new Error("trash unavailable"), { code: "ENOENT" })),
    );
});
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
    type Listener = (event: unknown) => void;
    const listeners = new Set<Listener>();
    const session = {
      messages: [] as unknown[],
      subscribe(listener: Listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const outcome = await captureChildTurnOutcome(
      session as never,
      async () => {
        const assistant = {
          role: "assistant",
          content: [{ type: "text", text: "completed before compaction" }],
          stopReason: "stop",
          timestamp: 1,
        };
        for (const listener of listeners) listener({ type: "message_end", message: assistant });
        session.messages = [{ role: "compactionSummary", summary: "replacement" }];
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
      importedMessages: [{ role: "user", content: "hello", timestamp: 1 }] as never[],
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
    source.appendMessage({
      role: "user",
      content: [{ type: "text", text: "source task" }],
      timestamp: 1,
    } as never);
    source.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "source answer" }],
      stopReason: "stop",
      timestamp: 2,
    } as never);
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
    sourceSession.appendMessage({
      role: "user",
      content: [{ type: "text", text: "generation A task" }],
      timestamp: 1,
    } as never);
    sourceSession.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "generation A answer" }],
      stopReason: "stop",
      timestamp: 2,
    } as never);
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
    adoptedSession.appendMessage({
      role: "user",
      content: [{ type: "text", text: "generation B task" }],
      timestamp: 3,
    } as never);
    adoptedSession.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "generation B answer" }],
      stopReason: "stop",
      timestamp: 4,
    } as never);
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
    secondAdoptedSession.appendMessage({
      role: "user",
      content: [{ type: "text", text: "generation C task" }],
      timestamp: 5,
    } as never);
    secondAdoptedSession.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "generation C answer" }],
      stopReason: "stop",
      timestamp: 6,
    } as never);
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
    const result = options.extensionsOverride?.({
      extensions: [
        { resolvedPath: coordinatorEntrypoint, tools: new Map([["custom_read", {}]]) },
        { resolvedPath: join(directory, "selected.ts"), tools: new Map([["custom_read", {}]]) },
        { resolvedPath: join(directory, "irrelevant.ts"), tools: new Map([["other", {}]]) },
      ],
      errors: [
        { path: coordinatorEntrypoint, error: "recursive" },
        { path: join(directory, "broken.ts"), error: "broken" },
      ],
    } as never);
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
        [{ type: "custom_message", customType: "minimal-subagents.result", details }],
        "child",
        "turn",
      ),
    ).toBe(true);
    expect(
      findDeliveryEvidence(
        [{ type: "message", message: { role: "toolResult", toolName: "subagent_wait", details } }],
        "child",
        "other",
      ),
    ).toBe(false);
    const coordinationEvidence = {
      type: "custom_message",
      customType: "minimal-subagents.message",
      details: { ...details, delivery_id: "message:1" },
    };
    expect(findDeliveryEvidence([coordinationEvidence], "child", "turn", "message:1")).toBe(true);
    expect(findDeliveryEvidence([coordinationEvidence], "child", "turn")).toBe(false);
    expect(
      findDeliveryEvidence(
        [
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "subagent_wait",
              details: { ...details, event: "message" },
            },
          },
        ],
        "child",
        "turn",
      ),
    ).toBe(false);
  });

  it("derives child fanout instructions from the active depth cap", () => {
    expect(buildDepthBoundSubagentPrompt(persistedAgent(), 2)).toContain(
      "Remaining delegation depth: 1.",
    );
    expect(buildDepthBoundSubagentPrompt(persistedAgent(), 1)).toContain(
      "Delegation is owned by your parent.",
    );
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
      getCoordinatorTools: () => [],
    });
    await factory.trashSession(agent);
    expect(existsSync(identity.sessionFile)).toBe(false);
  });

  it("accepts successful trash removal without attempting unlink fallback", async () => {
    const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-trash-success-"));
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
    execFileMock.mockImplementation(
      (
        _command: string,
        arguments_: string[],
        callback: (error: NodeJS.ErrnoException | null) => void,
      ) => {
        rmSync(arguments_.at(-1)!);
        callback(null);
      },
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
    await factory.trashSession(agent);
    expect(execFileMock).toHaveBeenCalledWith(
      "trash",
      [identity.sessionFile],
      expect.any(Function),
    );
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
