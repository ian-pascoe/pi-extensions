import { stripVTControlCharacters } from "node:util";
import {
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import type { MinimalSubagentsCoordinator } from "./minimal-subagents-coordinator.js";
import {
  formatSubagentDuration,
  orderActiveAgentSubtrees,
  subagentStatusLadder,
} from "./minimal-subagents-rendering.js";
import { COORDINATOR_TOOL_NAMES } from "./minimal-subagents-capabilities.js";
import {
  createTranscriptRenderCache,
  renderTranscriptSnapshot,
  type TranscriptLayout,
} from "./minimal-subagents-transcript.js";
import type { SubagentAccessSnapshot } from "./minimal-subagents-access.js";
import type {
  AgentSummary,
  ChildAgentTranscriptSnapshot,
  HierarchyStatusResult,
} from "./minimal-subagents-types.js";

const STATUS_PANEL_REFRESH_MS = 1_000;
const STATUS_PANEL_MARGIN = 1;
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
    for (const child of agent.children ?? []) visit(child, depth + 1);
  };
  const roots = "agents" in status ? status.agents : [status.agent];
  for (const agent of orderActiveAgentSubtrees(roots)) visit(agent, 0);
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

const BACKGROUND_CLEARING_SEQUENCES = ["\u001b[0m", "\u001b[m", "\u001b[49m"] as const;

/**
 * Re-open the panel background after each sequence that clears it. Truncation ends its cut text
 * and ellipsis with full resets, and embedded native components may reset or close their own
 * backgrounds; without this the rest of the row (ellipsis, padding, border) loses the panel fill.
 */
function keepBackgroundThroughResets(text: string, backgroundOpen: string): string {
  if (!backgroundOpen) return text;
  let result = text;
  for (const sequence of BACKGROUND_CLEARING_SEQUENCES) {
    result = result.replaceAll(sequence, `${sequence}${backgroundOpen}`);
  }
  return result;
}

function transcriptText(line: string): string {
  return stripVTControlCharacters(line).replace(/\s/g, "");
}

function anchoredTranscriptOffset(
  previous: TranscriptLayout,
  next: TranscriptLayout,
  offset: number,
): number {
  const index = previous.messageStarts.findLastIndex((start) => start <= offset);
  const previousStart = previous.messageStarts[index] ?? 0;
  const nextStart = next.messageStarts[index] ?? 0;
  const oldLines = previous.lines
    .slice(previousStart, previous.messageStarts[index + 1])
    .map(transcriptText);
  const newLines = next.lines.slice(nextStart, next.messageStarts[index + 1]).map(transcriptText);
  const row = offset - previousStart;
  if (oldLines.slice(0, row + 1).every((line, lineIndex) => line === newLines[lineIndex])) {
    return nextStart + row;
  }
  const text = oldLines[row];
  if (text) {
    const occurrence = oldLines.slice(0, row).filter((line) => line === text).length;
    let seen = 0;
    const match = newLines.findIndex((line) => line === text && seen++ === occurrence);
    if (match >= 0) return nextStart + match;
  }
  let characters = oldLines.slice(0, row).reduce((total, line) => total + line.length, 0);
  for (const [lineIndex, line] of newLines.entries()) {
    if (characters < line.length) return nextStart + lineIndex;
    characters -= line.length;
  }
  return nextStart + Math.max(0, newLines.length - 1);
}

/** Interactive, read-only Child Agent hierarchy and transcript status component. */
export class MinimalSubagentsStatusPanelComponent implements Component {
  private status!: HierarchyStatusResult;
  private access!: MinimalSubagentsStatusAccess;
  private flattened: FlattenedStatusAgent[] = [];
  private selectedAgentId?: string;
  private view: "tree" | "transcript" = "tree";
  private transcript?: ChildAgentTranscriptSnapshot;
  private notice = "";
  private scrollOffset = 0;
  private following = true;
  private transcriptLineCount = 0;
  private transcriptLayout?: TranscriptLayout;
  private readonly transcriptCache = createTranscriptRenderCache();
  private bodyHeight = 1;
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
      if (this.view === "tree") this.close();
      else {
        this.view = "tree";
        this.transcript = undefined;
        this.scrollOffset = 0;
        this.ensureSelectionVisible = true;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.openSelectedTranscript();
    } else if (this.keybindings.matches(data, "app.tools.expand")) {
      this.toolOutputExpanded = !this.toolOutputExpanded;
    } else if (this.view === "transcript" && matchesKey(data, "end")) {
      this.following = true;
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.scroll(-this.viewportHeight());
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.scroll(this.viewportHeight());
    } else {
      return;
    }
    this.tui.requestRender();
  }

  /** Render one framed, terminal-bounded tree or Child Session Transcript. */
  render(width: number): string[] {
    if (width <= 0) return [];
    const height = Math.max(
      1,
      Math.min(
        Math.floor(this.tui.terminal.rows * 0.9),
        this.tui.terminal.rows - 2 * STATUS_PANEL_MARGIN,
      ),
    );
    if (width < 6 || height < 5) {
      return new Text("Esc back · Enlarge terminal", 0, 0).render(width).slice(0, height);
    }
    const innerWidth = width - 4;
    const selected = this.flattened.find(({ agent }) => agent.agent_id === this.selectedAgentId);
    const transcriptView = this.view === "transcript" && this.transcript;
    const header = transcriptView
      ? [
          this.theme.bold(`Transcript · ${this.selectedAgentId}`),
          selected ? this.renderAgentRow(selected.agent, 0, innerWidth) : "",
        ]
      : this.renderHeader(innerWidth);
    const toolKey = this.keybindings.getKeys("app.tools.expand").join("/");
    const helpText = transcriptView
      ? `Esc tree · End live · ${toolKey} tools · ↑↓/PgUp/PgDn scroll · ${this.following ? "Following" : "Paused"}`
      : "Esc close · Enter transcript · ↑↓ select · PgUp/PgDn page";
    const help = new Text(this.theme.fg("text", helpText), 0, 0)
      .render(innerWidth)
      .slice(0, Math.min(2, height - 4));
    const visibleHeader = header.slice(0, Math.max(1, height - help.length - 3));
    this.bodyHeight = Math.max(1, height - 2 - visibleHeader.length - help.length);
    let body: string[];
    if (transcriptView) {
      const layout = renderTranscriptSnapshot(
        transcriptView,
        this.tui,
        this.cwd,
        this.toolOutputExpanded,
        innerWidth,
        this.transcriptCache,
      );
      if (!this.following && this.transcriptLayout) {
        this.scrollOffset = anchoredTranscriptOffset(
          this.transcriptLayout,
          layout,
          this.scrollOffset,
        );
      }
      this.transcriptLayout = layout;
      body = layout.lines;
      this.transcriptLineCount = body.length;
      const maximum = Math.max(0, body.length - this.bodyHeight);
      this.scrollOffset = this.following ? maximum : Math.min(this.scrollOffset, maximum);
    } else {
      body = this.flattened.map(({ agent, depth }) =>
        this.renderAgentRow(agent, depth, innerWidth),
      );
      if (body.length === 0) body.push("No Child Agents yet.");
      const selectedLine = this.flattened.findIndex(
        ({ agent }) => agent.agent_id === this.selectedAgentId,
      );
      if (this.ensureSelectionVisible && selectedLine >= 0) {
        if (selectedLine < this.scrollOffset) this.scrollOffset = selectedLine;
        if (selectedLine >= this.scrollOffset + this.bodyHeight)
          this.scrollOffset = selectedLine - this.bodyHeight + 1;
      }
      this.ensureSelectionVisible = false;
      this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, body.length - this.bodyHeight));
    }
    const visibleBody = body.slice(this.scrollOffset, this.scrollOffset + this.bodyHeight);
    while (visibleBody.length < this.bodyHeight) visibleBody.push("");
    const border = (text: string) => this.theme.fg("border", text);
    const backgroundOpen = this.theme.getBgAnsi("customMessageBg");
    const rows = [...visibleHeader, ...visibleBody, ...help].map((line) => {
      const content = keepBackgroundThroughResets(
        truncateToWidth(line, innerWidth, "…"),
        backgroundOpen,
      );
      return this.theme.bg(
        "customMessageBg",
        `${border("│")} ${content}${" ".repeat(innerWidth - visibleWidth(content))} ${border("│")}`,
      );
    });
    return [border(`╭${"─".repeat(width - 2)}╮`), ...rows, border(`╰${"─".repeat(width - 2)}╯`)];
  }

  /** Rebuild native transcript components when their theme changes. */
  invalidate(): void {
    this.transcriptCache.messages = new WeakMap();
    this.transcriptCache.results = new WeakMap();
  }

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
      if (this.view === "transcript") {
        this.notice = `${this.selectedAgentId} is no longer available.`;
        this.view = "tree";
        this.transcript = undefined;
      }
      this.ensureSelectionVisible = true;
      this.selectedAgentId = this.flattened[0]?.agent.agent_id;
    }
    if (this.view === "transcript" && this.selectedAgentId) {
      this.refreshAgentTranscript(this.selectedAgentId);
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
      this.theme.fg("warning", this.notice),
    ];
  }

  private renderAgentRow(agent: AgentSummary, depth: number, width: number): string {
    const selected = agent.agent_id === this.selectedAgentId;
    const disclosure = "▸";
    const status = subagentStatusLadder(agent);
    const elapsed = formatSubagentDuration(agent.elapsed_ms);
    const task = agent.task?.replace(/\s+/g, " ").trim();
    const line = `${selected ? ">" : " "} ${"  ".repeat(depth)}${disclosure} ${agent.agent_id} · ${status}${
      elapsed ? ` ${elapsed}` : ""
    } · ${agent.model}:${agent.thinking_level}${task ? ` · ${task}` : ""}`;
    return truncateToWidth(selected ? this.theme.fg("accent", line) : line, width, "…");
  }

  private scroll(delta: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
    this.ensureSelectionVisible = false;
    if (this.view === "transcript") {
      const maximum = Math.max(0, this.transcriptLineCount - this.viewportHeight());
      this.scrollOffset = Math.min(this.scrollOffset, maximum);
      this.following = this.scrollOffset === maximum;
    }
  }

  private moveSelection(delta: number): void {
    if (this.view === "transcript") {
      this.scroll(delta);
      return;
    }
    if (this.flattened.length === 0) return;
    const current = this.flattened.findIndex(
      ({ agent }) => agent.agent_id === this.selectedAgentId,
    );
    const next = Math.max(0, Math.min(this.flattened.length - 1, current + delta));
    this.selectedAgentId = this.flattened[next]?.agent.agent_id;
    this.ensureSelectionVisible = true;
  }

  private openSelectedTranscript(): void {
    if (this.view === "transcript" || !this.selectedAgentId) return;
    this.view = "transcript";
    this.notice = "";
    this.following = true;
    this.scrollOffset = 0;
    this.toolOutputExpanded = false;
    this.refreshAgentTranscript(this.selectedAgentId);
  }

  private refreshAgentTranscript(agentId: string): void {
    try {
      this.transcript = this.coordinator.inspectTranscript(agentId);
    } catch (error) {
      this.transcript = {
        messages: [],
        toolDefinitions: [],
        fallback: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private viewportHeight(): number {
    return this.bodyHeight;
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
  private overlayHandle?: OverlayHandle;

  /** Bind the panel owner to one Root Agent session and refresh lifecycle. */
  constructor(
    private readonly coordinator: MinimalSubagentsCoordinator,
    private readonly context: ExtensionContext,
    private readonly getAccess: () => MinimalSubagentsStatusAccess,
    private readonly startRefresh: StartStatusPanelRefresh = startStatusPanelRefresh,
  ) {}

  /** Open or focus the single live view; RPC receives a notification and structured modes stay silent. */
  open(): Promise<void> {
    if (this.activePromise) {
      this.overlayHandle?.focus();
      return this.activePromise;
    }
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
      .custom<void>(
        (tui, theme, keybindings, done) => {
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
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "90%",
            maxHeight: "90%",
            margin: STATUS_PANEL_MARGIN,
          },
          onHandle: (handle) => {
            this.overlayHandle = handle;
          },
        },
      )
      .catch(() => {
        this.context.ui.notify("Subagents status view failed.", "error");
      })
      .finally(() => {
        this.activePanel?.dispose();
        this.activePanel = undefined;
        this.activePromise = undefined;
        this.overlayHandle = undefined;
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
