import { stripVTControlCharacters } from "node:util";
import {
  DynamicBorder,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import { hintLine, joinInline, noticeText } from "@ian-pascoe/pi-utils/ui";
import type { MinimalSubagentsCoordinator } from "./minimal-subagents-coordinator.js";
import {
  formatSubagentDuration,
  orderActiveAgentSubtrees,
  renderSubagentStatusLabel,
  renderSubagentStatusMark,
  subagentStatusLadder,
  treeRowPrefixes,
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

/** The panel's ellipsis, in Pi's three-dot form. */
const ELLIPSIS = "...";

/** The theme operations the panel draws with; Pi's `Theme` satisfies it. */
type StatusPanelTheme = Pick<Theme, "fg" | "bold">;

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
  private readonly border = new DynamicBorder((text) => this.theme.fg("border", text));

  /** Bind one live status component to its coordinator, terminal, and explicit refresh owner. */
  constructor(
    private readonly coordinator: MinimalSubagentsCoordinator,
    private readonly getAccess: () => MinimalSubagentsStatusAccess,
    private readonly tui: TUI,
    private readonly theme: StatusPanelTheme,
    private readonly keybindings: Pick<KeybindingsManager, "matches" | "getKeys">,
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

  /** Render the tree or Child Session Transcript in Pi's selector frame, within the terminal. */
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
      const cancelKey = this.keybindings.getKeys("tui.select.cancel").join("/");
      return new Text(this.theme.fg("muted", `${cancelKey} back · Enlarge terminal`), 0, 0)
        .render(width)
        .slice(0, height);
    }
    const innerWidth = width - 2;
    const selected = this.flattened.find(({ agent }) => agent.agent_id === this.selectedAgentId);
    const transcriptView = this.view === "transcript" && this.transcript;
    const header = transcriptView
      ? [
          this.theme.fg("accent", this.theme.bold(`Transcript · ${this.selectedAgentId}`)),
          selected ? this.renderAgentRow(selected.agent, "", false) : "",
        ]
      : this.renderHeader();
    const help = [
      "",
      ...wrapTextWithAnsi(this.renderHints(Boolean(transcriptView)), innerWidth),
    ].slice(0, Math.min(3, height - 4));
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
      const prefixes = treeRowPrefixes(this.flattened.map(({ depth }) => depth));
      body = this.flattened.map(({ agent }, index) =>
        this.renderAgentRow(agent, prefixes[index] ?? "", agent.agent_id === this.selectedAgentId),
      );
      if (body.length === 0) body.push(this.theme.fg("muted", "No Child Agents yet."));
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
    // Each row keeps Pi's one-column margin and fills the pane so the overlay covers what is under it.
    const rows = [...visibleHeader, ...visibleBody, ...help].map((line) =>
      truncateToWidth(` ${line}`, width, ELLIPSIS, true),
    );
    const [border = ""] = this.border.render(width);
    return [border, ...rows, border];
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

  private keyLabel(binding: Parameters<KeybindingsManager["getKeys"]>[0]): string {
    return this.keybindings.getKeys(binding).join("/");
  }

  private renderHints(transcript: boolean): string {
    const page = `${this.keyLabel("tui.select.pageUp")}/${this.keyLabel("tui.select.pageDown")}`;
    const hints = transcript
      ? hintLine(this.theme, [
          { key: this.keyLabel("tui.select.cancel"), description: "tree" },
          { key: "end", description: "live" },
          { key: this.keyLabel("app.tools.expand"), description: "tools" },
          { key: "\u2191\u2193", description: "scroll" },
          { key: page, description: "page" },
        ])
      : hintLine(this.theme, [
          { key: "\u2191\u2193", description: "select" },
          { key: this.keyLabel("tui.select.confirm"), description: "transcript" },
          { key: page, description: "page" },
          { key: this.keyLabel("tui.select.cancel"), description: "close" },
        ]);
    if (!transcript) return hints;
    const following = this.following
      ? this.theme.fg("muted", "following")
      : this.theme.fg("warning", "paused");
    return `${hints}  ${following}`;
  }

  private renderHeader(): string[] {
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
    const field = (label: string, ...values: string[]) =>
      `${this.theme.fg("muted", `${label}:`)} ${joinInline(this.theme, values)}`;
    return [
      this.theme.fg("accent", this.theme.bold("Subagents status")),
      field("Access", accessState, statusAccessSourceLabel(this.access.source)),
      field(
        "Defaults",
        `branch ${this.access.branchOverride}`,
        `project ${projectValue}`,
        `global ${authoredAccessValue(this.access.globalEnabled)}`,
      ),
      field("Coordinator Tools", toolState),
      field("Direct Children", `${running} running`, `${idle} idle`),
      ...(this.notice ? [this.theme.fg("warning", this.notice)] : []),
    ];
  }

  /** One row of the hierarchy: selection marker, tree prefix, Status Mark, id, status, profile, task. */
  private renderAgentRow(agent: AgentSummary, prefix: string, selected: boolean): string {
    const status = subagentStatusLadder(agent);
    const elapsed = formatSubagentDuration(agent.elapsed_ms);
    const task = agent.task?.replace(/\s+/g, " ").trim();
    const identity = `${renderSubagentStatusMark(this.theme, status)} ${
      selected ? this.theme.fg("accent", agent.agent_id) : agent.agent_id
    }`;
    const details = joinInline(this.theme, [
      identity,
      `${renderSubagentStatusLabel(this.theme, status)}${
        elapsed ? ` ${this.theme.fg("muted", elapsed)}` : ""
      }`,
      this.theme.fg("muted", `${agent.model}:${agent.thinking_level}`),
      task ? this.theme.fg("muted", task) : undefined,
    ]);
    const marker = selected ? this.theme.fg("accent", "→ ") : "  ";
    return `${marker}${prefix ? this.theme.fg("dim", prefix) : ""}${details}`;
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
        this.context.ui.notify(noticeText("Subagents", "Status view failed."), "error");
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
