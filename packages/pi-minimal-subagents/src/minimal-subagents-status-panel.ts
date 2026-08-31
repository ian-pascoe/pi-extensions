import { contentText } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { MinimalSubagentsCoordinator } from "./minimal-subagents-coordinator.js";
import {
  formatSubagentDuration,
  renderMinimalSubagentsMessage,
  renderMinimalSubagentsResult,
  subagentStatusLadder,
} from "./minimal-subagents-rendering.js";
import { COORDINATOR_TOOL_NAMES } from "./minimal-subagents-capabilities.js";
import type { SubagentAccessSnapshot } from "./minimal-subagents-access.js";
import type {
  AgentSummary,
  ChildAgentTranscriptSnapshot,
  HierarchyStatusResult,
} from "./minimal-subagents-types.js";

const STATUS_PANEL_REFRESH_MS = 1_000;
const STATUS_PANEL_FIXED_LINE_COUNT = 7;
const STATUS_PANEL_MIN_VIEWPORT_LINES = 4;
const COORDINATOR_TOOL_COUNT = COORDINATOR_TOOL_NAMES.length;

type StartStatusPanelRefresh = (refresh: () => void) => () => void;

function startStatusPanelRefresh(refresh: () => void): () => void {
  const interval = setInterval(refresh, STATUS_PANEL_REFRESH_MS);
  interval.unref?.();
  return () => clearInterval(interval);
}

/** Supplies read-only Subagent Access data without coupling the panel to persistence mechanics. */
export type MinimalSubagentsStatusAccess = SubagentAccessSnapshot & {
  readonly projectTrusted: boolean;
};

interface FlattenedStatusAgent {
  agent: AgentSummary;
  depth: number;
}

function flattenStatusAgents(status: HierarchyStatusResult): FlattenedStatusAgent[] {
  const flattened: FlattenedStatusAgent[] = [];
  const visit = (agent: AgentSummary, depth: number): void => {
    flattened.push({ agent, depth });
    for (const child of agent.children) visit(child, depth + 1);
  };
  const roots = "agents" in status ? status.agents : [status.agent];
  for (const agent of roots) visit(agent, 0);
  return flattened;
}

function authoredAccessValue(value: boolean | undefined): string {
  return value === undefined ? "unset" : value ? "enabled" : "disabled";
}

function statusAccessSourceLabel(source: SubagentAccessSnapshot["source"]): string {
  switch (source) {
    case "branch":
      return "branch override";
    case "project":
      return "project setting";
    case "global":
      return "global setting";
    case "default":
      return "built-in default";
  }
}

function renderTranscriptSnapshot(
  snapshot: ChildAgentTranscriptSnapshot,
  tui: TUI,
  cwd: string,
  expanded: boolean,
  width: number,
): string[] {
  if (snapshot.messages.length === 0) {
    return snapshot.fallback
      ? new Text(snapshot.fallback, 3, 0).render(width)
      : new Text("No Recent Activity", 3, 0).render(width);
  }
  const container = new Container();
  const tools = new Map(
    snapshot.toolDefinitions.map((definition) => [definition.name, definition]),
  );
  const pendingTools = new Map<string, ToolExecutionComponent>();

  for (const [messageIndex, message] of snapshot.messages.entries()) {
    switch (message.role) {
      case "user": {
        const text = contentText(message.content, "\n\n");
        if (text) container.addChild(new UserMessageComponent(text));
        break;
      }
      case "assistant": {
        const assistant = new AssistantMessageComponent(message);
        assistant.updateContent(message, messageIndex === snapshot.streamingAssistantIndex);
        container.addChild(assistant);
        for (const content of message.content) {
          if (content.type !== "toolCall") continue;
          const tool = new ToolExecutionComponent(
            content.name,
            content.id,
            content.arguments,
            { showImages: false },
            tools.get(content.name),
            tui,
            cwd,
          );
          tool.setExpanded(expanded);
          container.addChild(tool);
          if (message.stopReason === "aborted" || message.stopReason === "error") {
            tool.updateResult({
              content: [
                {
                  type: "text",
                  text:
                    message.stopReason === "aborted"
                      ? "Operation aborted"
                      : (message.errorMessage ?? "Error"),
                },
              ],
              isError: true,
            });
          } else {
            pendingTools.set(content.id, tool);
          }
        }
        break;
      }
      case "toolResult": {
        const tool = pendingTools.get(message.toolCallId);
        if (tool) {
          tool.updateResult(message);
          pendingTools.delete(message.toolCallId);
        }
        break;
      }
      case "custom": {
        if (!message.display) break;
        const renderer =
          message.customType === "minimal-subagents.message"
            ? renderMinimalSubagentsMessage
            : message.customType === "minimal-subagents.result"
              ? renderMinimalSubagentsResult
              : undefined;
        const custom = new CustomMessageComponent(message, renderer);
        custom.setExpanded(expanded);
        container.addChild(custom);
        break;
      }
      case "bashExecution": {
        const bash = new BashExecutionComponent(message.command, tui, message.excludeFromContext);
        if (message.output) bash.appendOutput(message.output);
        bash.setComplete(
          message.exitCode,
          message.cancelled,
          // SAFETY: Persisted bash messages retain only the truncation flag; BashExecutionComponent reads that flag here.
          message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
          message.fullOutputPath,
        );
        bash.setExpanded(expanded);
        container.addChild(bash);
        break;
      }
      case "branchSummary": {
        const summary = new BranchSummaryMessageComponent(message);
        summary.setExpanded(expanded);
        container.addChild(summary);
        break;
      }
      case "compactionSummary": {
        const summary = new CompactionSummaryMessageComponent(message);
        summary.setExpanded(expanded);
        container.addChild(summary);
        break;
      }
    }
  }
  return container.render(width);
}

/** Interactive, read-only Child Agent hierarchy and transcript status component. */
export class MinimalSubagentsStatusPanelComponent implements Component {
  private status!: HierarchyStatusResult;
  private access!: MinimalSubagentsStatusAccess;
  private flattened: FlattenedStatusAgent[] = [];
  private selectedAgentId?: string;
  private readonly expandedAgentIds = new Set<string>();
  private readonly transcripts = new Map<string, ChildAgentTranscriptSnapshot>();
  private scrollOffset = 0;
  private ensureSelectionVisible = true;
  private toolOutputExpanded = false;
  private disposed = false;
  private readonly stopRefresh: () => void;

  /** Bind one live status component to its coordinator, terminal, and explicit refresh owner. */
  constructor(
    private readonly coordinator: MinimalSubagentsCoordinator,
    private readonly getAccess: () => MinimalSubagentsStatusAccess,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly cwd: string,
    private readonly onClose: () => void,
    startRefresh: StartStatusPanelRefresh = startStatusPanelRefresh,
  ) {
    this.refreshData();
    this.stopRefresh = startRefresh(() => {
      try {
        this.refreshData();
        this.tui.requestRender();
      } catch {
        this.close();
      }
    });
  }

  /** Handle read-only hierarchy navigation and close keys. */
  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.toggleSelectedAgent();
    } else if (this.keybindings.matches(data, "app.tools.expand")) {
      this.toolOutputExpanded = !this.toolOutputExpanded;
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.viewportHeight());
      this.ensureSelectionVisible = false;
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.scrollOffset += this.viewportHeight();
      this.ensureSelectionVisible = false;
    } else {
      return;
    }
    this.tui.requestRender();
  }

  /** Render the fixed access header and scrollable Child Agent hierarchy. */
  render(width: number): string[] {
    if (width <= 0) return [];
    const header = this.renderHeader(width);
    const rowStarts = new Map<string, number>();
    const body: string[] = [];
    for (const { agent, depth } of this.flattened) {
      rowStarts.set(agent.agent_id, body.length);
      body.push(this.renderAgentRow(agent, depth, width));
      if (!this.expandedAgentIds.has(agent.agent_id)) continue;
      const transcript = this.transcripts.get(agent.agent_id);
      if (transcript) {
        body.push(
          ...renderTranscriptSnapshot(
            transcript,
            this.tui,
            this.cwd,
            this.toolOutputExpanded,
            width,
          ),
        );
      }
    }
    const viewportHeight = this.viewportHeight();
    const selectedLine = this.selectedAgentId ? rowStarts.get(this.selectedAgentId) : undefined;
    if (this.ensureSelectionVisible && selectedLine !== undefined) {
      if (selectedLine < this.scrollOffset) this.scrollOffset = selectedLine;
      if (selectedLine >= this.scrollOffset + viewportHeight) {
        this.scrollOffset = selectedLine - viewportHeight + 1;
      }
    }
    this.ensureSelectionVisible = false;
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, body.length - viewportHeight));
    const visibleBody = body.slice(this.scrollOffset, this.scrollOffset + viewportHeight);
    const help = truncateToWidth(
      this.theme.fg(
        "dim",
        "↑↓ select  Enter Recent Activity  configured tool key expands output  PgUp/PgDn scroll  Esc close",
      ),
      width,
      "…",
    );
    return [...header, ...visibleBody, help];
  }

  /** Invalidate no cached layout because each render derives the current snapshot. */
  invalidate(): void {}

  /** Release the live refresh owner idempotently. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopRefresh();
  }

  private refreshData(): void {
    this.status = this.coordinator.inspectStatus();
    this.access = this.getAccess();
    this.flattened = flattenStatusAgents(this.status);
    const liveIds = new Set(this.flattened.map(({ agent }) => agent.agent_id));
    if (!this.selectedAgentId || !liveIds.has(this.selectedAgentId)) {
      this.selectedAgentId = this.flattened[0]?.agent.agent_id;
    }
    for (const agentId of this.expandedAgentIds) {
      if (!liveIds.has(agentId)) {
        this.expandedAgentIds.delete(agentId);
        this.transcripts.delete(agentId);
        continue;
      }
      this.refreshAgentTranscript(agentId);
    }
  }

  private renderHeader(width: number): string[] {
    const direct = "agents" in this.status ? this.status.agents : [this.status.agent];
    const running = direct.filter((agent) => agent.state === "running").length;
    const idle = direct.length - running;
    const accessState = this.access.enabled ? "enabled" : "disabled";
    const activeCoordinatorToolCount = this.access.coordinatorTools.activeCount;
    const toolState = `${activeCoordinatorToolCount}/${COORDINATOR_TOOL_COUNT} active${
      activeCoordinatorToolCount > 0 && activeCoordinatorToolCount < COORDINATOR_TOOL_COUNT
        ? " (inconsistent)"
        : ""
    }`;
    const projectValue = this.access.projectTrusted
      ? authoredAccessValue(this.access.projectEnabled)
      : "unavailable (untrusted)";
    return [
      truncateToWidth(this.theme.bold("Subagents status"), width, "…"),
      truncateToWidth(
        `Access: ${accessState} · ${statusAccessSourceLabel(this.access.source)}`,
        width,
        "…",
      ),
      truncateToWidth(
        `Defaults: branch ${this.access.branchOverride} · project ${projectValue} · global ${authoredAccessValue(this.access.globalEnabled)}`,
        width,
        "…",
      ),
      truncateToWidth(`Coordinator Tools: ${toolState}`, width, "…"),
      truncateToWidth(`Direct Children: ${running} running · ${idle} idle`, width, "…"),
      "",
    ];
  }

  private renderAgentRow(agent: AgentSummary, depth: number, width: number): string {
    const selected = agent.agent_id === this.selectedAgentId;
    const disclosure = this.expandedAgentIds.has(agent.agent_id) ? "▾" : "▸";
    const status = subagentStatusLadder(agent);
    const elapsed = formatSubagentDuration(agent.elapsed_ms);
    const task = agent.task?.replace(/\s+/g, " ").trim();
    const line = `${selected ? ">" : " "} ${"  ".repeat(depth)}${disclosure} ${agent.agent_id} · ${status}${
      elapsed ? ` ${elapsed}` : ""
    } · ${agent.model}:${agent.thinking_level}${task ? ` · ${task}` : ""}`;
    return truncateToWidth(selected ? this.theme.fg("accent", line) : line, width, "…");
  }

  private moveSelection(delta: number): void {
    if (this.flattened.length === 0) return;
    const current = this.flattened.findIndex(
      ({ agent }) => agent.agent_id === this.selectedAgentId,
    );
    const next = Math.max(0, Math.min(this.flattened.length - 1, current + delta));
    this.selectedAgentId = this.flattened[next]?.agent.agent_id;
    this.ensureSelectionVisible = true;
  }

  private toggleSelectedAgent(): void {
    const agentId = this.selectedAgentId;
    if (!agentId) return;
    if (this.expandedAgentIds.delete(agentId)) {
      this.transcripts.delete(agentId);
      return;
    }
    this.expandedAgentIds.add(agentId);
    this.refreshAgentTranscript(agentId);
  }

  private refreshAgentTranscript(agentId: string): void {
    try {
      this.transcripts.set(agentId, this.coordinator.inspectTranscript(agentId));
    } catch (error) {
      this.transcripts.set(agentId, {
        messages: [],
        toolDefinitions: [],
        fallback: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private viewportHeight(): number {
    return Math.max(
      STATUS_PANEL_MIN_VIEWPORT_LINES,
      this.tui.terminal.rows - STATUS_PANEL_FIXED_LINE_COUNT,
    );
  }

  /** Settle the custom view and release its refresh timer exactly once. */
  close(): void {
    if (this.disposed) return;
    this.dispose();
    this.onClose();
  }
}

/** Owns one live status custom view and its non-TUI observer behavior. */
export class MinimalSubagentsStatusPanelController {
  private activePanel?: MinimalSubagentsStatusPanelComponent;
  private activePromise?: Promise<void>;

  /** Bind the panel owner to one Root Agent session and refresh lifecycle. */
  constructor(
    private readonly coordinator: MinimalSubagentsCoordinator,
    private readonly context: ExtensionContext,
    private readonly getAccess: () => MinimalSubagentsStatusAccess,
    private readonly startRefresh: StartStatusPanelRefresh = startStatusPanelRefresh,
  ) {}

  /** Open or focus the single live view; RPC receives a notification and structured modes stay silent. */
  open(): Promise<void> {
    if (this.activePromise) return this.activePromise;
    if (this.context.mode === "rpc") {
      const status = this.coordinator.inspectStatus();
      const direct = "agents" in status ? status.agents : [status.agent];
      const running = direct.filter((agent) => agent.state === "running").length;
      const access = this.getAccess();
      this.context.ui.notify(
        `Subagent Access ${access.enabled ? "enabled" : "disabled"} (${statusAccessSourceLabel(access.source)}); Coordinator Tools ${access.coordinatorTools.activeCount}/${COORDINATOR_TOOL_COUNT}; direct Children ${running} running, ${direct.length - running} idle`,
        "info",
      );
      return Promise.resolve();
    }
    if (this.context.mode !== "tui") return Promise.resolve();

    const promise = this.context.ui
      .custom<void>((tui, theme, keybindings, done) => {
        const panel = new MinimalSubagentsStatusPanelComponent(
          this.coordinator,
          this.getAccess,
          tui,
          theme,
          keybindings,
          this.context.cwd,
          () => done(undefined),
          this.startRefresh,
        );
        this.activePanel = panel;
        return panel;
      })
      .catch(() => {
        this.context.ui.notify("Subagents status view failed.", "error");
      })
      .finally(() => {
        this.activePanel?.dispose();
        this.activePanel = undefined;
        this.activePromise = undefined;
      });
    this.activePromise = promise;
    return promise;
  }

  /** Close the live status view and release its refresh timer during session shutdown. */
  dispose(): void {
    this.activePanel?.close();
    this.activePanel = undefined;
  }
}
