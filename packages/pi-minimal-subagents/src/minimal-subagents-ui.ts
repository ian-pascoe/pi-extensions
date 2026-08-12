import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { MinimalSubagentsCoordinator } from "./minimal-subagents-coordinator.js";
import {
  formatSubagentDuration,
  renderSubagentStatusLabel,
  renderSubagentStatusSymbol,
} from "./minimal-subagents-rendering.js";
import type { AgentSummary, HierarchyStatusResult, TurnStatus } from "./minimal-subagents-types.js";

const MINIMAL_SUBAGENTS_UI_KEY = "minimal-subagents";
const MINIMAL_SUBAGENTS_RECENT_LIMIT = 3;
const MINIMAL_SUBAGENTS_WIDGET_ROW_LIMIT = 8;
const MINIMAL_SUBAGENTS_REFRESH_MS = 1_000;
const MINIMAL_SUBAGENTS_COOLDOWN_MS = 10_000;

export interface MinimalSubagentsWidgetRow {
  agentId: string;
  depth: number;
  status: TurnStatus | "idle" | "unavailable";
  elapsedMs?: number;
  task?: string;
  structural: boolean;
}

export interface MinimalSubagentsWidgetView {
  runningCount: number;
  retainedCount: number;
  recentCount: number;
  rows: MinimalSubagentsWidgetRow[];
  overflowCount: number;
}

interface FlattenedAgentSummary {
  agent: AgentSummary;
  depth: number;
  parentId?: string;
  order: number;
}

function flattenAgentHierarchy(agents: readonly AgentSummary[]): FlattenedAgentSummary[] {
  const flattened: FlattenedAgentSummary[] = [];
  const visit = (agent: AgentSummary, depth: number, parentId?: string) => {
    flattened.push({ agent, depth, parentId, order: flattened.length });
    for (const child of agent.children) visit(child, depth + 1, agent.agent_id);
  };
  for (const agent of agents) visit(agent, 0);
  return flattened;
}

function agentTerminalStatus(agent: AgentSummary): TurnStatus | "idle" | "unavailable" {
  if (agent.availability === "unavailable") return "unavailable";
  if (agent.state === "running") return "running";
  return agent.latest_turn?.status ?? "idle";
}

function terminalTimestamp(agent: AgentSummary): number {
  const value = Date.parse(agent.latest_activity_at ?? "");
  return Number.isFinite(value) ? value : 0;
}

function terminalFailurePriority(agent: AgentSummary): number {
  const status = agentTerminalStatus(agent);
  return status === "failed" || status === "unavailable" ? 0 : 1;
}

function candidatePath(
  candidate: FlattenedAgentSummary,
  byId: ReadonlyMap<string, FlattenedAgentSummary>,
): FlattenedAgentSummary[] {
  const path: FlattenedAgentSummary[] = [candidate];
  let parentId = candidate.parentId;
  while (parentId) {
    const parent = byId.get(parentId);
    if (!parent) break;
    path.push(parent);
    parentId = parent.parentId;
  }
  return path.reverse();
}

/** Project coordinator status into the bounded active/ancestor/recent widget hierarchy. */
export function buildMinimalSubagentsWidgetView(
  status: HierarchyStatusResult,
): MinimalSubagentsWidgetView {
  const agents = "agents" in status ? status.agents : [status.agent];
  const flattened = flattenAgentHierarchy(agents);
  const byId = new Map(flattened.map((item) => [item.agent.agent_id, item]));
  const running = flattened.filter((item) => item.agent.state === "running");
  const recent = flattened
    .filter(
      (item) =>
        item.agent.state !== "running" &&
        (item.agent.availability === "unavailable" || item.agent.latest_turn !== undefined),
    )
    .sort(
      (left, right) =>
        terminalFailurePriority(left.agent) - terminalFailurePriority(right.agent) ||
        terminalTimestamp(right.agent) - terminalTimestamp(left.agent) ||
        left.order - right.order,
    )
    .slice(0, MINIMAL_SUBAGENTS_RECENT_LIMIT);
  const meaningfulIds = new Set(
    [...running, ...recent].map((candidate) => candidate.agent.agent_id),
  );
  const desiredIds = new Set<string>();
  const chosenIds = new Set<string>();
  for (const candidate of [...running, ...recent]) {
    const path = candidatePath(candidate, byId);
    for (const item of path) desiredIds.add(item.agent.agent_id);
    const additions = path.filter((item) => !chosenIds.has(item.agent.agent_id));
    if (chosenIds.size + additions.length > MINIMAL_SUBAGENTS_WIDGET_ROW_LIMIT) continue;
    for (const item of additions) chosenIds.add(item.agent.agent_id);
  }
  const rows = flattened
    .filter((item) => chosenIds.has(item.agent.agent_id))
    .map((item): MinimalSubagentsWidgetRow => {
      const structural = !meaningfulIds.has(item.agent.agent_id);
      return {
        agentId: item.agent.agent_id,
        depth: item.depth,
        status: agentTerminalStatus(item.agent),
        elapsedMs: item.agent.elapsed_ms,
        task: structural ? undefined : item.agent.task,
        structural,
      };
    });
  return {
    runningCount: running.length,
    retainedCount: flattened.length,
    recentCount: recent.filter((item) => chosenIds.has(item.agent.agent_id)).length,
    rows,
    overflowCount: Math.max(0, desiredIds.size - chosenIds.size),
  };
}

/** Render a responsive widget snapshot with ANSI-safe terminal-width truncation. */
export function renderMinimalSubagentsWidgetLines(
  view: MinimalSubagentsWidgetView,
  width: number,
  theme: Theme,
): string[] {
  if (width <= 0) return [];
  const separator = theme.fg("dim", "  ·  ");
  const activity =
    view.runningCount > 0
      ? theme.fg("accent", `${view.runningCount} running`)
      : theme.fg("dim", "idle");
  const lines = [
    truncateToWidth(
      [
        theme.fg("toolTitle", theme.bold("Subagents")),
        activity,
        width >= 44 && view.recentCount > 0
          ? theme.fg("muted", `${view.recentCount} recent`)
          : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join(separator),
      width,
      "…",
    ),
  ];
  for (const row of view.rows) {
    const duration = formatSubagentDuration(row.elapsedMs);
    const task = row.task?.replace(/\s+/g, " ").trim();
    const branch =
      row.depth > 0
        ? theme.fg("borderMuted", `${"  ".repeat(row.depth)}╰─ `)
        : theme.fg("borderMuted", "  ");
    const agentId = row.structural ? theme.fg("muted", row.agentId) : theme.bold(row.agentId);
    const parts = [
      `${branch}${renderSubagentStatusSymbol(theme, row.status)} ${agentId}`,
      row.structural ? undefined : renderSubagentStatusLabel(theme, row.status),
      task ? theme.fg("muted", task) : undefined,
      duration ? theme.fg("muted", duration) : undefined,
    ].filter((part): part is string => Boolean(part));
    lines.push(truncateToWidth(parts.join(separator), width, "…"));
  }
  if (view.overflowCount > 0) {
    lines.push(truncateToWidth(theme.fg("dim", `  …  +${view.overflowCount} more`), width, "…"));
  }
  return lines;
}

class MinimalSubagentsWidgetComponent implements Component {
  constructor(
    private view: MinimalSubagentsWidgetView,
    private readonly tui: TUI,
    private readonly theme: Theme,
  ) {}

  update(view: MinimalSubagentsWidgetView): void {
    this.view = view;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    return renderMinimalSubagentsWidgetLines(this.view, width, this.theme);
  }

  invalidate(): void {}
}

/** Own the root session's widget, footer, live refresh, cooldown, and idempotent cleanup. */
export class MinimalSubagentsUiController {
  private disposed = false;
  private widgetMounted = false;
  private widgetComponent?: MinimalSubagentsWidgetComponent;
  private refreshInterval?: ReturnType<typeof setInterval>;
  private cooldownTimeout?: ReturnType<typeof setTimeout>;
  private previousRunningCount = 0;
  private restorationAttentionConsumed = false;
  private currentView: MinimalSubagentsWidgetView = {
    runningCount: 0,
    retainedCount: 0,
    recentCount: 0,
    rows: [],
    overflowCount: 0,
  };

  constructor(
    private readonly coordinator: MinimalSubagentsCoordinator,
    private readonly context: ExtensionContext,
  ) {}

  refresh(): void {
    if (this.disposed || this.context.mode !== "tui") return;
    const status = this.coordinator.inspectStatus();
    const nextView = buildMinimalSubagentsWidgetView(status);
    this.currentView = nextView;
    if (nextView.runningCount > 0) {
      this.clearCooldown();
      this.ensureRefreshInterval();
      this.showWidget(nextView);
      this.context.ui.setStatus(
        MINIMAL_SUBAGENTS_UI_KEY,
        [
          this.context.ui.theme.fg("accent", `◉ ${nextView.runningCount} running`),
          this.context.ui.theme.fg("muted", `${nextView.retainedCount} retained`),
        ].join(this.context.ui.theme.fg("dim", "  ·  ")),
      );
    } else {
      this.clearRefreshInterval();
      this.context.ui.setStatus(MINIMAL_SUBAGENTS_UI_KEY, undefined);
      const restoredUnavailable =
        !this.restorationAttentionConsumed &&
        this.previousRunningCount === 0 &&
        nextView.rows.some((row) => row.status === "unavailable");
      this.restorationAttentionConsumed = true;
      if (this.previousRunningCount > 0 || restoredUnavailable) {
        this.showWidget(nextView);
        this.ensureCooldown();
      } else if (this.cooldownTimeout) {
        this.showWidget(nextView);
      } else {
        this.hideWidget();
      }
    }
    this.previousRunningCount = nextView.runningCount;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRefreshInterval();
    this.clearCooldown();
    if (this.context.mode === "tui") {
      this.context.ui.setStatus(MINIMAL_SUBAGENTS_UI_KEY, undefined);
      this.context.ui.setWidget(MINIMAL_SUBAGENTS_UI_KEY, undefined);
    }
    this.widgetMounted = false;
    this.widgetComponent = undefined;
  }

  private showWidget(view: MinimalSubagentsWidgetView): void {
    if (this.widgetMounted) {
      this.widgetComponent?.update(view);
      return;
    }
    this.context.ui.setWidget(
      MINIMAL_SUBAGENTS_UI_KEY,
      (tui, theme) => {
        this.widgetComponent = new MinimalSubagentsWidgetComponent(this.currentView, tui, theme);
        return this.widgetComponent;
      },
      { placement: "aboveEditor" },
    );
    this.widgetMounted = true;
  }

  private hideWidget(): void {
    if (!this.widgetMounted) return;
    this.context.ui.setWidget(MINIMAL_SUBAGENTS_UI_KEY, undefined);
    this.widgetMounted = false;
    this.widgetComponent = undefined;
  }

  private ensureRefreshInterval(): void {
    if (this.refreshInterval) return;
    this.refreshInterval = setInterval(() => this.refresh(), MINIMAL_SUBAGENTS_REFRESH_MS);
    this.refreshInterval.unref?.();
  }

  private clearRefreshInterval(): void {
    if (!this.refreshInterval) return;
    clearInterval(this.refreshInterval);
    this.refreshInterval = undefined;
  }

  private ensureCooldown(): void {
    this.clearCooldown();
    this.cooldownTimeout = setTimeout(() => {
      this.cooldownTimeout = undefined;
      this.hideWidget();
    }, MINIMAL_SUBAGENTS_COOLDOWN_MS);
    this.cooldownTimeout.unref?.();
  }

  private clearCooldown(): void {
    if (!this.cooldownTimeout) return;
    clearTimeout(this.cooldownTimeout);
    this.cooldownTimeout = undefined;
  }
}
