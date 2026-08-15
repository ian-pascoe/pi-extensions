import type { Theme } from "@earendil-works/pi-coding-agent";

/** Theme operations used by the Minimal Subagents widget renderer. */
export type MinimalSubagentsWidgetTheme = Pick<Theme, "fg" | "bold">;
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { MinimalSubagentsCoordinator } from "./minimal-subagents-coordinator.js";
import {
  formatSubagentDuration,
  renderSubagentStatusLabel,
  renderSubagentStatusSymbol,
} from "./minimal-subagents-rendering.js";
import type {
  AgentSummary,
  HierarchyStatusResult,
  RuntimeProfile,
  TurnStatus,
} from "./minimal-subagents-types.js";

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
  runtimeProfile: RuntimeProfile;
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
        runtimeProfile: {
          model: item.agent.model,
          thinking_level: item.agent.thinking_level,
        },
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

const MINIMAL_SUBAGENTS_WIDGET_SEPARATOR_TEXT = "  ·  ";
const MINIMAL_SUBAGENTS_WIDGET_ELLIPSIS = "…";

interface MinimalSubagentsWidgetRowParts {
  identity: string;
  status: string;
  profile: string;
  task?: string;
}

function joinMinimalSubagentsWidgetRow(
  parts: MinimalSubagentsWidgetRowParts,
  separator: string,
): string {
  return [parts.identity, parts.status, parts.profile, parts.task]
    .filter((part): part is string => part !== undefined)
    .join(separator);
}

function formatMinimalSubagentsRuntimeProfile(
  profile: RuntimeProfile,
  maxWidth?: number,
): string | undefined {
  const suffix = `:${profile.thinking_level}`;
  const fullProfile = `${profile.model}${suffix}`;
  if (maxWidth === undefined || visibleWidth(fullProfile) <= maxWidth) return fullProfile;

  const shortestProfile = `${MINIMAL_SUBAGENTS_WIDGET_ELLIPSIS}${suffix}`;
  if (maxWidth < visibleWidth(shortestProfile)) return undefined;
  const modelWidth = maxWidth - visibleWidth(suffix);
  const prefix = sliceByColumn(
    profile.model,
    0,
    Math.max(0, modelWidth - visibleWidth(MINIMAL_SUBAGENTS_WIDGET_ELLIPSIS)),
    true,
  );
  return `${prefix}${MINIMAL_SUBAGENTS_WIDGET_ELLIPSIS}${suffix}`;
}

function renderMinimalSubagentsWidgetRowParts(
  row: MinimalSubagentsWidgetRow,
  task: string | undefined,
  duration: string | undefined,
  profile: string,
  theme: MinimalSubagentsWidgetTheme,
): MinimalSubagentsWidgetRowParts {
  const branch = row.depth > 0 ? `${"  ".repeat(row.depth)}╰─ ` : "  ";
  const styledBranch = theme.fg("borderMuted", branch);
  const agentId = row.structural ? theme.fg("muted", row.agentId) : theme.bold(row.agentId);
  const identity = `${styledBranch}${renderSubagentStatusSymbol(theme, row.status)} ${agentId}`;
  const status = `${renderSubagentStatusLabel(theme, row.status)}${
    duration ? ` ${theme.fg("muted", duration)}` : ""
  }`;
  return {
    identity,
    status,
    profile: theme.fg("muted", profile),
    task: task ? theme.fg("muted", task) : undefined,
  };
}

function minimalSubagentsWidgetRowFits(
  parts: MinimalSubagentsWidgetRowParts,
  separator: string,
  width: number,
): boolean {
  return visibleWidth(joinMinimalSubagentsWidgetRow(parts, separator)) <= width;
}

function minimalSubagentsWidgetProfileBudget(
  row: MinimalSubagentsWidgetRow,
  task: string | undefined,
  duration: string | undefined,
  separator: string,
  theme: MinimalSubagentsWidgetTheme,
  width: number,
): number {
  const fixedParts = renderMinimalSubagentsWidgetRowParts(row, task, duration, "", theme);
  return width - visibleWidth(joinMinimalSubagentsWidgetRow(fixedParts, separator));
}

function renderMinimalSubagentsWidgetRow(
  row: MinimalSubagentsWidgetRow,
  width: number,
  theme: MinimalSubagentsWidgetTheme,
): string {
  const separator = theme.fg("dim", MINIMAL_SUBAGENTS_WIDGET_SEPARATOR_TEXT);
  const task = row.task?.replace(/\s+/g, " ").trim() || undefined;
  const duration = row.status === "unavailable" ? undefined : formatSubagentDuration(row.elapsedMs);
  const fullProfile = formatMinimalSubagentsRuntimeProfile(row.runtimeProfile);
  if (!fullProfile) return "";

  const completeParts = renderMinimalSubagentsWidgetRowParts(
    row,
    task,
    duration,
    fullProfile,
    theme,
  );
  if (minimalSubagentsWidgetRowFits(completeParts, separator, width)) {
    return joinMinimalSubagentsWidgetRow(completeParts, separator);
  }

  const partsWithoutTask = renderMinimalSubagentsWidgetRowParts(
    row,
    undefined,
    duration,
    fullProfile,
    theme,
  );
  if (minimalSubagentsWidgetRowFits(partsWithoutTask, separator, width)) {
    return joinMinimalSubagentsWidgetRow(partsWithoutTask, separator);
  }

  const profileBudget = minimalSubagentsWidgetProfileBudget(
    row,
    undefined,
    duration,
    separator,
    theme,
    width,
  );
  const shortenedProfile = formatMinimalSubagentsRuntimeProfile(row.runtimeProfile, profileBudget);
  if (shortenedProfile) {
    const shortenedParts = renderMinimalSubagentsWidgetRowParts(
      row,
      undefined,
      duration,
      shortenedProfile,
      theme,
    );
    if (minimalSubagentsWidgetRowFits(shortenedParts, separator, width)) {
      return joinMinimalSubagentsWidgetRow(shortenedParts, separator);
    }
  }

  if (duration) {
    const noDurationBudget = minimalSubagentsWidgetProfileBudget(
      row,
      undefined,
      undefined,
      separator,
      theme,
      width,
    );
    const noDurationProfile = formatMinimalSubagentsRuntimeProfile(
      row.runtimeProfile,
      noDurationBudget,
    );
    if (noDurationProfile) {
      const noDurationParts = renderMinimalSubagentsWidgetRowParts(
        row,
        undefined,
        undefined,
        noDurationProfile,
        theme,
      );
      if (minimalSubagentsWidgetRowFits(noDurationParts, separator, width)) {
        return joinMinimalSubagentsWidgetRow(noDurationParts, separator);
      }
    }
  }

  const shortestProfile = formatMinimalSubagentsRuntimeProfile(
    row.runtimeProfile,
    visibleWidth(`${MINIMAL_SUBAGENTS_WIDGET_ELLIPSIS}:${row.runtimeProfile.thinking_level}`),
  )!;
  const lastResortParts = renderMinimalSubagentsWidgetRowParts(
    row,
    undefined,
    undefined,
    shortestProfile,
    theme,
  );
  return truncateToWidth(
    joinMinimalSubagentsWidgetRow(lastResortParts, separator),
    width,
    MINIMAL_SUBAGENTS_WIDGET_ELLIPSIS,
  );
}

/** Render a responsive widget snapshot with ANSI-safe terminal-width truncation. */
export function renderMinimalSubagentsWidgetLines(
  view: MinimalSubagentsWidgetView,
  width: number,
  theme: MinimalSubagentsWidgetTheme,
): string[] {
  if (width <= 0) return [];
  const separator = theme.fg("dim", MINIMAL_SUBAGENTS_WIDGET_SEPARATOR_TEXT);
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
      MINIMAL_SUBAGENTS_WIDGET_ELLIPSIS,
    ),
  ];
  for (const row of view.rows) lines.push(renderMinimalSubagentsWidgetRow(row, width, theme));
  if (view.overflowCount > 0) {
    lines.push(
      truncateToWidth(
        theme.fg("dim", `  …  +${view.overflowCount} more`),
        width,
        MINIMAL_SUBAGENTS_WIDGET_ELLIPSIS,
      ),
    );
  }
  return lines;
}

class MinimalSubagentsWidgetComponent implements Component {
  constructor(
    private view: MinimalSubagentsWidgetView,
    private readonly tui: TUI,
    private readonly theme: MinimalSubagentsWidgetTheme,
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
