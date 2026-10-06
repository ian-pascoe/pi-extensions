// Recording Child Agent sessions: deterministic child turns with no provider or model calls.
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  AgentSessionFactory,
  ChildAgentRuntime,
  PersistedAgent,
  PersistedSessionIdentity,
  RuntimeProfile,
  RuntimeTurnOutcome,
} from "../../src/minimal-subagents-types.js";

/** One child runtime whose prompt completes at once, or is held until aborted or completed. */
export class RecordingChildRuntime implements ChildAgentRuntime {
  readonly sessionLeafId: string;
  isRunning = false;
  abortCount = 0;
  disposed = false;
  private promptOutcome: PromiseWithResolvers<RuntimeTurnOutcome> | undefined;

  constructor(
    agentId: string,
    private readonly holdPrompt: boolean,
    private readonly abortGate: Promise<void> | undefined,
  ) {
    this.sessionLeafId = `leaf-${agentId}`;
  }

  async runPrompt(): Promise<RuntimeTurnOutcome> {
    if (!this.holdPrompt) {
      return { status: "completed", output: "completed child turn" };
    }
    this.isRunning = true;
    this.promptOutcome = Promise.withResolvers<RuntimeTurnOutcome>();
    return this.promptOutcome.promise;
  }

  async runMessage(): Promise<RuntimeTurnOutcome> {
    return { status: "completed", output: "completed child message" };
  }

  async queueCoordinatorMessage(): Promise<void> {}

  async abort(): Promise<void> {
    this.abortCount++;
    await this.abortGate;
    this.isRunning = false;
    this.promptOutcome?.resolve({ status: "cancelled", output: "" });
  }

  completePrompt(): void {
    this.isRunning = false;
    this.promptOutcome?.resolve({ status: "completed", output: "completed after disable" });
  }

  dispose(): void {
    this.disposed = true;
  }

  getRuntimeProfile(): RuntimeProfile {
    return { model: "lifecycle-test/model", thinking_level: "medium" };
  }

  snapshotCommittedMessages(): AgentMessage[] {
    return [];
  }

  snapshotActivityMessages(): AgentMessage[] {
    return [];
  }

  hasDeliveryEvidence(): boolean {
    return false;
  }

  getUsage(): undefined {
    return undefined;
  }
}

/** Creates Recording child runtimes and records every session lifecycle call. */
export class RecordingAgentSessionFactory implements AgentSessionFactory {
  readonly createdAgentIds: string[] = [];
  readonly openedAgentIds: string[] = [];
  readonly clonedAgentIds: string[] = [];
  readonly adoptedAgentIds: string[] = [];
  readonly trashedAgentIds: string[] = [];
  readonly runtimes = new Map<string, RecordingChildRuntime>();
  holdPrompts = false;
  abortGate: Promise<void> | undefined;

  createIdentity(agent: PersistedAgent): PersistedSessionIdentity {
    this.createdAgentIds.push(agent.agent_id);
    return {
      sessionFile: `/recording-sessions/${agent.agent_id}.jsonl`,
      sessionId: `session-${agent.agent_id}`,
      sessionLeafId: `leaf-${agent.agent_id}`,
    };
  }

  async openRuntime(agent: PersistedAgent): Promise<ChildAgentRuntime> {
    this.openedAgentIds.push(agent.agent_id);
    return this.runtimeFor(agent.agent_id);
  }

  async resolveLaunchMissingDependencies(): Promise<string[]> {
    return [];
  }

  async resolveRestorationMissingDependencies(): Promise<string[]> {
    return [];
  }

  resolveThinkingLevel(_modelId: string, requested: ThinkingLevel): ThinkingLevel {
    return requested;
  }

  modelSupportsImages(): boolean {
    return true;
  }

  async cloneSession(agent: PersistedAgent): Promise<PersistedSessionIdentity> {
    this.clonedAgentIds.push(agent.agent_id);
    return this.clonedIdentity(agent.agent_id);
  }

  async cloneForkSourceSession(agent: PersistedAgent): Promise<PersistedSessionIdentity> {
    this.clonedAgentIds.push(agent.agent_id);
    return this.clonedIdentity(agent.agent_id);
  }

  async adoptForkSessionOwnership(agent: PersistedAgent): Promise<PersistedSessionIdentity> {
    this.adoptedAgentIds.push(agent.agent_id);
    return {
      sessionFile: agent.session_file ?? `/recording-sessions/${agent.agent_id}.jsonl`,
      sessionId: agent.session_id ?? `session-${agent.agent_id}`,
      sessionLeafId: agent.session_leaf_id ?? `leaf-${agent.agent_id}`,
    };
  }

  async trashSession(agent: PersistedAgent): Promise<void> {
    this.trashedAgentIds.push(agent.agent_id);
  }

  private runtimeFor(agentId: string): RecordingChildRuntime {
    const existing = this.runtimes.get(agentId);
    if (existing) return existing;
    const runtime = new RecordingChildRuntime(agentId, this.holdPrompts, this.abortGate);
    this.runtimes.set(agentId, runtime);
    return runtime;
  }

  private clonedIdentity(agentId: string): PersistedSessionIdentity {
    return {
      sessionFile: `/recording-clones/${agentId}.jsonl`,
      sessionId: `clone-${agentId}`,
      sessionLeafId: `clone-leaf-${agentId}`,
    };
  }
}
