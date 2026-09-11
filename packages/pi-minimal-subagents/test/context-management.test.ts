import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type AssistantMessage,
  type Context,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { AgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentSessionFactory } from "../src/minimal-subagents-sessions.js";
import type { ChildAgentRuntime, PersistedAgent } from "../src/minimal-subagents-types.js";

const model = {
  ...getModel("anthropic", "claude-sonnet-4-5"),
  contextWindow: 200_000,
  maxTokens: 512,
};
const modelId = `${model.provider}/${model.id}`;
const directories: string[] = [];
const runtimes: ChildAgentRuntime[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function reply(text: string, input = 100): AssistantMessage {
  const message = fauxAssistantMessage(text);
  return { ...message, usage: { ...message.usage, input, output: 10, totalTokens: input + 10 } };
}

function call(name: string, args: ToolCall["arguments"]): AssistantMessage {
  return {
    ...reply(""),
    content: [{ type: "toolCall", name, arguments: args, id: name }],
    stopReason: "toolUse",
  };
}

function fixture(codeMode: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-rollover-"));
  directories.push(directory);
  writeFileSync(
    join(directory, "settings.json"),
    JSON.stringify({
      extensions: [
        resolve(import.meta.dirname, "../../pi-context-management/src/index.ts"),
        ...(codeMode ? [resolve(import.meta.dirname, "../../pi-codemode/src/index.ts")] : []),
      ],
      compaction: { enabled: true, keepRecentTokens: 128, reserveTokens: 512 },
    }),
  );
  writeFileSync(
    join(directory, "auth.json"),
    JSON.stringify({ anthropic: { type: "api_key", key: "TEST-NOT-A-REAL-KEY" } }),
  );
  const provider = vi.spyOn(ModelRuntime.prototype, "streamSimple").mockImplementation(() => {
    throw new Error("Unexpected direct provider request, including a native summarizer");
  });
  const factory = new PiAgentSessionFactory({
    cwd: directory,
    agentDir: directory,
    sessionDir: directory,
    rootSessionId: "root-session",
    extensionEntrypoint: join(directory, "index.ts"),
    models: [model],
    eligibleModelIds: [modelId],
    modelScopeRestricted: false,
    availableToolNames: ["read", "bash"],
    projectTrusted: true,
    getCoordinatorTools: () => [],
  });
  const agent: PersistedAgent = {
    agent_id: codeMode ? "child.grandchild" : "child",
    friendly_id: codeMode ? "grandchild" : "child",
    parent_id: codeMode ? "child" : "root",
    created_at: "2026-01-01T00:00:00.000Z",
    spawn_entry_id: "spawn",
    launch_contract: {
      session_context: "omit",
      project_context: "omit",
      model: modelId,
      thinking_level: "off",
      tools: codeMode ? ["codemode_execute"] : "none",
      ordinary_tools: codeMode ? ["codemode_execute"] : [],
      delegation: "none",
    },
    capability_ceiling: codeMode ? ["codemode_execute"] : [],
    availability: "available",
    missing_dependencies: [],
    recent_messages: [],
  };
  const identity = factory.createIdentity(agent, []);
  agent.session_file = identity.sessionFile;
  agent.session_id = identity.sessionId;
  agent.session_leaf_id = identity.sessionLeafId;
  return { factory, agent, provider };
}

async function open(factory: PiAgentSessionFactory, agent: PersistedAgent) {
  const subscriptions = vi.spyOn(AgentSession.prototype, "subscribe");
  const runtime = await factory.openRuntime(agent);
  runtimes.push(runtime);
  const session = subscriptions.mock.contexts.find(
    (context): context is AgentSession => context instanceof AgentSession,
  );
  subscriptions.mockRestore();
  if (!session) throw new Error("Expected the real child AgentSession");
  const requests: Context[] = [];
  const responses: AssistantMessage[] = [];
  session.agent.streamFunction = (currentModel, context) => {
    requests.push({
      systemPrompt: context.systemPrompt,
      messages: structuredClone(context.messages),
      tools: context.tools?.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters: structuredClone(parameters),
      })),
    });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected model request");
    const unavailable = next.content.find(
      (part) => part.type === "toolCall" && !context.tools?.some((tool) => tool.name === part.name),
    );
    const message = {
      ...(unavailable ? reply("Blocked: required Context Management tool is unavailable.") : next),
      api: currentModel.api,
      provider: currentModel.provider,
      model: currentModel.id,
    };
    const reason = message.stopReason;
    if (reason !== "stop" && reason !== "toolUse") throw new Error("Invalid scripted response");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.push({ type: "done", reason, message }));
    return stream;
  };
  return { runtime, session, requests, responses };
}

describe("Child Agent Context Management", () => {
  it.each([false, true])(
    "completes threshold Rollover with a restricted child (restored nested CodeMode: %s)",
    async (codeMode) => {
      const f = fixture(codeMode);
      const contract = structuredClone(f.agent.launch_contract);
      const ceiling = [...f.agent.capability_ceiling];
      if (codeMode) {
        const previous = await open(f.factory, f.agent);
        previous.responses.push(reply("Earlier child work."));
        await previous.runtime.runPrompt("Earlier task", false, modelId, "off");
        f.agent.session_leaf_id = previous.runtime.sessionLeafId;
        previous.runtime.dispose();
      }
      const child = await open(f.factory, f.agent);
      child.responses.push(
        reply("Ready. ".repeat(100), 200_000),
        codeMode
          ? call("codemode_execute", {
              script:
                'return await tools.context_notes({ action: "write", name: "task", content: "Fresh child state." });',
              sessionId: "child-notes",
              wait: true,
            })
          : call("context_notes", { action: "write", name: "task", content: "Fresh child state." }),
        call("context_rollover", { handoff: "Fresh child continuation." }),
        reply("Continued after checkpoint."),
      );
      const result = await child.runtime.runPrompt(
        "OLD-CHILD-HISTORY " + "history ".repeat(12_000),
        false,
        modelId,
        "off",
      );
      expect(JSON.stringify(child.requests[1]?.messages)).toContain("Prepare a Context Rollover");
      const checkpoints = child.session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "compaction");
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]).toMatchObject({
        summary: expect.stringContaining("Fresh child continuation."),
        details: { reason: "normal" },
      });
      expect(result).toMatchObject({ status: "completed", output: "Continued after checkpoint." });
      expect(child.requests).toHaveLength(4);
      expect(child.requests[0]?.tools?.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["context_history", "context_notes", "context_rollover"]),
      );
      expect(child.requests[2]?.messages).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolName: codeMode ? "codemode_execute" : "context_notes",
          isError: false,
        }),
      );
      for (const request of child.requests.slice(1)) {
        expect(request.tools).toEqual(child.requests[0]?.tools);
        expect(request.systemPrompt).toBe(child.requests[0]?.systemPrompt);
      }
      expect(JSON.stringify(child.requests[3]?.messages)).toContain("Fresh child continuation.");
      expect(JSON.stringify(child.requests[3]?.messages)).not.toContain("OLD-CHILD-HISTORY");
      expect(child.session.messages).toEqual(
        child.session.sessionManager.buildSessionContext().messages,
      );
      expect(f.agent.launch_contract).toEqual(contract);
      expect(f.agent.capability_ceiling).toEqual(ceiling);
      expect(f.provider).not.toHaveBeenCalled();
      const reopened = SessionManager.open(f.agent.session_file!);
      expect(reopened.buildSessionContext().messages).toEqual(child.session.messages);
    },
  );
});
