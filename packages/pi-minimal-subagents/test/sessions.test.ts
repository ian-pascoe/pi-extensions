import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));
import {
  buildDepthBoundSubagentPrompt,
  createChildResourceLoaderOptions,
  createPersistentChildIdentity,
  findDeliveryEvidence,
  PiAgentSessionFactory,
} from "../src/minimal-subagents-sessions.js";
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
    const sessionFile = join(directory, "child.jsonl");
    writeFileSync(sessionFile, "{}\n");
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
    await factory.trashSessionFile(sessionFile);
    expect(existsSync(sessionFile)).toBe(false);
  });

  it("accepts successful trash removal without attempting unlink fallback", async () => {
    const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-trash-success-"));
    temporaryDirectories.push(directory);
    const sessionFile = join(directory, "child.jsonl");
    writeFileSync(sessionFile, "{}\n");
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
    await factory.trashSessionFile(sessionFile);
    expect(execFileMock).toHaveBeenCalledWith("trash", [sessionFile], expect.any(Function));
    expect(existsSync(sessionFile)).toBe(false);
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
