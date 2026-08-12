import type { Usage } from "@earendil-works/pi-ai";
import {
  getMarkdownTheme,
  keyHint,
  type AgentToolResult,
  type Theme,
  type ThemeColor,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Markdown,
  sliceByColumn,
  Spacer,
  Text,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
export type CoordinatorToolName =
  | "subagent"
  | "agent_message"
  | "subagent_wait"
  | "subagent_status"
  | "subagent_cancel"
  | "subagent_delete";

interface RenderableCoordinatorMessage {
  content: unknown;
  details?: unknown;
}

interface CoordinatorMessageRenderOptions {
  expanded: boolean;
  outputPad: number;
}

const SUBAGENT_STATUS_PRESENTATION: Record<string, { symbol: string; color: ThemeColor }> = {
  running: { symbol: "◉", color: "accent" },
  waiting: { symbol: "◌", color: "accent" },
  completed: { symbol: "✓", color: "success" },
  failed: { symbol: "×", color: "error" },
  cancelled: { symbol: "■", color: "warning" },
  interrupted: { symbol: "!", color: "warning" },
  unavailable: { symbol: "!", color: "warning" },
  idle: { symbol: "○", color: "dim" },
  delivered: { symbol: "→", color: "accent" },
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function coordinatorMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const block = asRecord(item);
      return block?.type === "text" ? (asString(block.text) ?? "") : "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolResultText(result: AgentToolResult<unknown>): string {
  const text = result.content.find((item) => item.type === "text");
  return text?.type === "text" ? text.text : "";
}

/** Render the shared semantic symbol and color for one subagent status. */
export function renderSubagentStatusSymbol(theme: Theme, status: string): string {
  const presentation = SUBAGENT_STATUS_PRESENTATION[status] ?? SUBAGENT_STATUS_PRESENTATION.idle!;
  return theme.fg(presentation.color, presentation.symbol);
}

/** Render a subagent status label with the same semantic color as its symbol. */
export function renderSubagentStatusLabel(theme: Theme, status: string): string {
  const presentation = SUBAGENT_STATUS_PRESENTATION[status] ?? SUBAGENT_STATUS_PRESENTATION.idle!;
  return theme.fg(presentation.color, status);
}

function renderSubagentSeparator(theme: Theme): string {
  return theme.fg("dim", "  ·  ");
}

function renderSubagentSummary(
  theme: Theme,
  status: string,
  agentId: string,
  metrics: readonly string[] = [],
): string {
  const identity = `${renderSubagentStatusSymbol(theme, status)} ${theme.fg("accent", theme.bold(agentId))}`;
  return [
    identity,
    renderSubagentStatusLabel(theme, status),
    ...metrics.map((metric) => theme.fg("muted", metric)),
  ].join(renderSubagentSeparator(theme));
}

function renderLabelValue(theme: Theme, label: string, value: unknown): Text {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return new Text(`${theme.fg("muted", `${label}:`)} ${text ?? ""}`, 0, 0);
}

function appendSection(
  container: Container,
  theme: Theme,
  label: string,
  content: string | Component,
): void {
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", theme.bold(label)), 0, 0));
  container.addChild(typeof content === "string" ? new Text(content, 0, 0) : content);
}

function renderFallbackToolResult(
  result: AgentToolResult<unknown>,
  theme: Theme,
  isError: boolean,
): Component {
  const content = toolResultText(result) || "(no output)";
  return new Text(isError ? theme.fg("error", content) : content, 0, 0);
}

function collapsedExpansionHint(theme: Theme): string {
  return theme.fg("dim", `  ·  ${keyHint("app.tools.expand", "to expand")}`);
}

/** Format milliseconds for compact subagent rows without losing sub-second durations. */
export function formatSubagentDuration(elapsedMs: number | undefined): string | undefined {
  if (elapsedMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined;
  if (elapsedMs < 1_000) return `${Math.round(elapsedMs)}ms`;
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Format token counts as compact decimal values for transcript and widget summaries. */
export function formatSubagentTokenCount(tokens: number | undefined): string | undefined {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) return undefined;
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}m`;
}

/** Collapse multiline task or message text into one terminal-friendly preview. */
export function formatSubagentPreview(content: string, maxWidth = 72): string {
  const singleLine = content.replace(/\s+/g, " ").trim();
  const boundedWidth = Math.max(1, maxWidth);
  if (visibleWidth(singleLine) <= boundedWidth) return singleLine;
  if (boundedWidth === 1) return "…";
  return `${sliceByColumn(singleLine, 0, boundedWidth - 1, true).trimEnd()}…`;
}

function currentSubagentPreviewWidth(reservedWidth: number): number {
  return Math.max(12, Math.min(72, (process.stdout.columns || 100) - reservedWidth));
}

/** Format complete Pi usage metrics for expanded subagent output. */
export function formatSubagentUsage(usage: Usage | undefined): string | undefined {
  const usageRecord = asRecord(usage);
  if (!usageRecord) return undefined;
  const values = [
    `input ${formatSubagentTokenCount(asNumber(usageRecord.input)) ?? "0"}`,
    `output ${formatSubagentTokenCount(asNumber(usageRecord.output)) ?? "0"}`,
    `cache read ${formatSubagentTokenCount(asNumber(usageRecord.cacheRead)) ?? "0"}`,
    `cache write ${formatSubagentTokenCount(asNumber(usageRecord.cacheWrite)) ?? "0"}`,
    `total ${formatSubagentTokenCount(asNumber(usageRecord.totalTokens)) ?? "0"}`,
  ];
  const totalCost = asNumber(asRecord(usageRecord.cost)?.total);
  if (totalCost !== undefined && totalCost > 0) values.push(`cost $${totalCost.toFixed(4)}`);
  return values.join(" · ");
}

type CoordinatorToolCallRenderer = (args: Record<string, unknown>, theme: Theme) => Component;

function coordinatorToolCallTitle(theme: Theme, label: string): string {
  return theme.fg("toolTitle", theme.bold(label));
}

function coordinatorToolCallPreview(theme: Theme, value: unknown): string {
  return typeof value === "string" && value.length > 0
    ? ` · ${theme.fg("dim", `“${formatSubagentPreview(value, currentSubagentPreviewWidth(36))}”`)}`
    : "";
}

function renderManagementToolCall(
  label: string,
  args: Record<string, unknown>,
  theme: Theme,
): Component {
  return new Text(
    `${coordinatorToolCallTitle(theme, label)} ${theme.fg("accent", asString(args.agent_id) ?? "agent")} ${theme.fg("dim", args.recursive === false ? "· target only" : "· recursive")}`,
    0,
    0,
  );
}

const COORDINATOR_TOOL_CALL_RENDERERS: Record<CoordinatorToolName, CoordinatorToolCallRenderer> = {
  subagent: (args, theme) =>
    new Text(
      `${coordinatorToolCallTitle(theme, "Subagent")} ${theme.fg("accent", asString(args.agent_id) ?? "generated")}${coordinatorToolCallPreview(theme, args.task)}`,
      0,
      0,
    ),
  agent_message: (args, theme) =>
    new Text(
      `${coordinatorToolCallTitle(theme, "Message")} ${theme.fg("accent", asString(args.agent_id) ?? "parent")}${coordinatorToolCallPreview(theme, args.message)}`,
      0,
      0,
    ),
  subagent_wait: (args, theme) =>
    new Text(
      `${coordinatorToolCallTitle(theme, "Wait")} ${theme.fg("accent", asString(args.agent_id) ?? "agent")}`,
      0,
      0,
    ),
  subagent_status: (args, theme) =>
    new Text(
      `${coordinatorToolCallTitle(theme, "Status")} ${theme.fg("accent", asString(args.agent_id) ?? "children")}`,
      0,
      0,
    ),
  subagent_cancel: (args, theme) => renderManagementToolCall("Cancel", args, theme),
  subagent_delete: (args, theme) => renderManagementToolCall("Delete", args, theme),
};

function renderSpawnResult(
  details: Record<string, unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  args: Record<string, unknown>,
): Component {
  const agentId = asString(details.agent_id) ?? "subagent";
  const status = asString(details.status) ?? "running";
  const agent = asRecord(details.agent);
  const launchContract = asRecord(agent?.launch_contract);
  if (!options.expanded) {
    return new Text(
      `${renderSubagentSummary(theme, status, agentId)}${collapsedExpansionHint(theme)}`,
      0,
      0,
    );
  }
  const container = new Container();
  container.addChild(new Text(renderSubagentSummary(theme, status, agentId), 0, 0));
  container.addChild(renderLabelValue(theme, "Turn", asString(details.turn_id) ?? "unknown"));
  appendSection(container, theme, "Task", asString(args.task) ?? "(task unavailable)");
  const resolvedModel = asString(launchContract?.model) ?? asString(args.model);
  const resolvedThinking =
    asString(launchContract?.thinking_level) ?? asString(args.thinking_level);
  const launch = [
    `delegation ${asString(launchContract?.delegation) ?? asString(args.delegation) ?? "none"}`,
    `session context ${asString(launchContract?.session_context) ?? asString(args.session_context) ?? "inherit"}`,
    `project context ${asString(launchContract?.project_context) ?? asString(args.project_context) ?? "inherit"}`,
    resolvedModel ? `model ${resolvedModel}` : undefined,
    resolvedThinking ? `thinking ${resolvedThinking}` : undefined,
  ].filter(Boolean);
  appendSection(container, theme, "Launch", launch.join(" · "));
  appendSection(
    container,
    theme,
    "Resolved tools",
    asStringArray(launchContract?.ordinary_tools ?? agent?.tools).join(", ") || "none",
  );
  return container;
}

function renderMessageResult(
  details: Record<string, unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  args: Record<string, unknown>,
): Component {
  const agentId = asString(details.agent_id) ?? asString(args.agent_id) ?? "parent";
  const historicalBehavior = asString(details.behavior) ?? asString(args.behavior);
  const metrics = historicalBehavior ? [historicalBehavior] : [];
  const delivered = details.delivered === true;
  const summary = delivered
    ? renderSubagentSummary(theme, "delivered", agentId, metrics)
    : renderSubagentSummary(theme, "failed", agentId, metrics);
  if (!options.expanded) return new Text(`${summary}${collapsedExpansionHint(theme)}`, 0, 0);
  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  appendSection(container, theme, "Message", asString(args.message) ?? "(message unavailable)");
  appendSection(container, theme, "Recipient", agentId);
  const error = asString(details.error);
  if (error) appendSection(container, theme, "Error", error);
  return container;
}

function renderWaitResult(
  details: Record<string, unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  args: Record<string, unknown>,
): Component {
  const agentId = asString(details.agent_id) ?? asString(args.agent_id) ?? "agent";
  const status = options.isPartial ? "waiting" : (asString(details.status) ?? "completed");
  const duration = formatSubagentDuration(asNumber(details.elapsed_ms));
  const usage = asRecord(details.usage) as Usage | undefined;
  const tokens = formatSubagentTokenCount(usage?.totalTokens);
  const metrics = [duration, tokens ? `${tokens} tokens` : undefined].filter(
    (metric): metric is string => Boolean(metric),
  );
  const summary = renderSubagentSummary(theme, status, agentId, metrics);
  if (options.isPartial || !options.expanded) {
    return new Text(`${summary}${options.isPartial ? "" : collapsedExpansionHint(theme)}`, 0, 0);
  }
  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  container.addChild(renderLabelValue(theme, "Turn", asString(details.turn_id) ?? "unknown"));
  const output = asString(details.output) ?? "";
  if (status === "completed") {
    appendSection(
      container,
      theme,
      "Output",
      output.length > 0 ? new Markdown(output, 0, 0, getMarkdownTheme()) : "(no output)",
    );
  } else {
    appendSection(
      container,
      theme,
      "Error",
      (asString(details.error) ?? output) || "(no error detail)",
    );
    appendSection(container, theme, "Diagnostics", JSON.stringify(details, null, 2));
  }
  const usageText = formatSubagentUsage(usage);
  if (usageText) appendSection(container, theme, "Usage", usageText);
  return container;
}

function countDirectStatusAgents(agents: unknown[]): { children: number; running: number } {
  let children = 0;
  let running = 0;
  for (const item of agents) {
    const agent = asRecord(item);
    if (!agent) continue;
    children++;
    if (agent.state === "running") running++;
  }
  return { children, running };
}

function renderDirectStatusRows(agents: unknown[], theme: Theme): string[] {
  const rows: string[] = [];
  for (const item of agents) {
    const agent = asRecord(item);
    if (!agent) continue;
    const availability = asString(agent.availability) ?? "available";
    const latestTurn = asRecord(agent.latest_turn);
    const status =
      availability === "unavailable"
        ? "unavailable"
        : asString(agent.state) === "running"
          ? "running"
          : (asString(latestTurn?.status) ?? "idle");
    const duration = formatSubagentDuration(asNumber(agent.elapsed_ms));
    const childCount = asNumber(agent.child_count) ?? 0;
    const metrics = [duration, childCount > 0 ? `${childCount} children` : undefined].filter(
      (metric): metric is string => Boolean(metric),
    );
    rows.push(renderSubagentSummary(theme, status, asString(agent.agent_id) ?? "unknown", metrics));
  }
  return rows;
}

function renderStatusResult(
  details: Record<string, unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const agents = Array.isArray(details.agents) ? details.agents : undefined;
  if (agents) {
    const counts = countDirectStatusAgents(agents);
    const summary = [
      theme.fg("muted", `${counts.children} children`),
      theme.fg(counts.running > 0 ? "accent" : "dim", `${counts.running} running`),
    ].join(renderSubagentSeparator(theme));
    if (!options.expanded) return new Text(`${summary}${collapsedExpansionHint(theme)}`, 0, 0);
    return new Text(
      `${summary}\n${renderDirectStatusRows(agents, theme).join("\n") || theme.fg("dim", "(no agents)")}`,
      0,
      0,
    );
  }
  const agent = asRecord(details.agent);
  if (!agent) {
    return new Text(
      [theme.fg("muted", "0 children"), theme.fg("dim", "0 running")].join(
        renderSubagentSeparator(theme),
      ),
      0,
      0,
    );
  }
  const availability = asString(agent.availability) ?? "available";
  const latestTurn = asRecord(agent.latest_turn);
  const status =
    availability === "unavailable"
      ? "unavailable"
      : asString(agent.state) === "running"
        ? "running"
        : (asString(latestTurn?.status) ?? "idle");
  const id = asString(agent.agent_id) ?? "agent";
  const childCount = asNumber(agent.child_count) ?? 0;
  const duration = formatSubagentDuration(asNumber(agent.elapsed_ms));
  const summary = renderSubagentSummary(
    theme,
    status,
    id,
    [duration, `${childCount} children`].filter((metric): metric is string => Boolean(metric)),
  );
  if (!options.expanded) return new Text(`${summary}${collapsedExpansionHint(theme)}`, 0, 0);
  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  for (const [label, value] of [
    ["Parent", agent.parent_id],
    ["Availability", availability],
    ["Turn", agent.active_turn_id ?? asRecord(agent.latest_turn)?.turn_id],
    ["Duration", duration],
    ["Model", agent.model],
    ["Thinking", agent.thinking_level],
    ["Session", agent.session_file],
    ["Spawn entry", agent.spawn_entry_id],
  ] as const) {
    if (value !== undefined) container.addChild(renderLabelValue(theme, label, value));
  }
  if (asString(agent.task)) appendSection(container, theme, "Task", String(agent.task));
  const launchContract = asRecord(agent.launch_contract);
  if (launchContract) {
    const launchValues = [
      `session context ${asString(launchContract.session_context) ?? "inherit"}`,
      `project context ${asString(launchContract.project_context) ?? "inherit"}`,
      `model ${asString(launchContract.model) ?? asString(agent.model) ?? "unknown"}`,
      `thinking ${asString(launchContract.thinking_level) ?? asString(agent.thinking_level) ?? "unknown"}`,
      `delegation ${asString(launchContract.delegation) ?? "none"}`,
    ];
    appendSection(container, theme, "Launch contract", launchValues.join(" · "));
  }
  appendSection(container, theme, "Tools", asStringArray(agent.tools).join(", ") || "none");
  appendSection(
    container,
    theme,
    "Capability ceiling",
    asStringArray(agent.capability_ceiling).join(", ") || "none",
  );
  const missing = asStringArray(agent.missing_dependencies);
  if (missing.length > 0)
    appendSection(container, theme, "Missing dependencies", missing.join("\n"));
  if (asString(agent.unavailable_reason)) {
    appendSection(container, theme, "Unavailable reason", String(agent.unavailable_reason));
  }
  const recentMessages = Array.isArray(agent.recent_messages)
    ? agent.recent_messages
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  if (recentMessages.length > 0) {
    appendSection(
      container,
      theme,
      "Recent messages",
      recentMessages
        .map(
          (message) =>
            `${asString(message.source_agent_id) ?? "unknown"}: ${asString(message.content) ?? ""}`,
        )
        .join("\n"),
    );
  }
  const latestResult = asRecord(agent.latest_result);
  if (latestResult) {
    const output = asString(latestResult.output) ?? "";
    appendSection(
      container,
      theme,
      "Latest result",
      asString(latestResult.status) === "completed" && output
        ? new Markdown(output, 0, 0, getMarkdownTheme())
        : output || JSON.stringify(latestResult, null, 2),
    );
  }
  const usageText = formatSubagentUsage(asRecord(agent.usage) as Usage | undefined);
  if (usageText) appendSection(container, theme, "Usage", usageText);
  return container;
}

function renderCancelResult(
  details: Record<string, unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const id = asString(details.agent_id) ?? "agent";
  const turns = asStringArray(details.cancelled_turn_ids);
  const summary =
    turns.length > 0
      ? renderSubagentSummary(theme, "cancelled", id, [`${turns.length} turns cancelled`])
      : renderSubagentSummary(theme, "completed", id, ["no active turns"]);
  if (!options.expanded) return new Text(`${summary}${collapsedExpansionHint(theme)}`, 0, 0);
  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  container.addChild(renderLabelValue(theme, "Requested target", id));
  container.addChild(
    renderLabelValue(theme, "Mode", details.recursive === false ? "target only" : "recursive"),
  );
  appendSection(
    container,
    theme,
    "Affected agents",
    asStringArray(details.affected_agent_ids).join("\n") || "(none)",
  );
  appendSection(container, theme, "Cancelled turns", turns.join("\n") || "(none)");
  return container;
}

function renderDeleteResult(
  details: Record<string, unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const id = asString(details.agent_id) ?? "agent";
  const deleted = asStringArray(details.deleted_agent_ids);
  const tombstoned = asStringArray(details.tombstoned_agent_ids);
  const failures = Array.isArray(details.failures) ? details.failures : [];
  const status = failures.length > 0 ? "failed" : "completed";
  const summary = renderSubagentSummary(
    theme,
    status,
    id,
    [
      `${deleted.length} agents deleted`,
      `${tombstoned.length} tombstoned`,
      failures.length > 0 ? `${failures.length} failed` : undefined,
    ].filter((metric): metric is string => Boolean(metric)),
  );
  if (!options.expanded) return new Text(`${summary}${collapsedExpansionHint(theme)}`, 0, 0);
  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  container.addChild(renderLabelValue(theme, "Requested target", id));
  container.addChild(
    renderLabelValue(theme, "Mode", details.recursive === false ? "target only" : "recursive"),
  );
  appendSection(container, theme, "Deleted agents", deleted.join("\n") || "(none)");
  appendSection(container, theme, "Tombstones", tombstoned.join("\n") || "(none)");
  appendSection(
    container,
    theme,
    "Trashed sessions",
    asStringArray(details.trashed_session_files).join("\n") || "(none)",
  );
  if (failures.length > 0) {
    appendSection(
      container,
      theme,
      "Failures",
      theme.fg("error", JSON.stringify(failures, null, 2)),
    );
  }
  return container;
}

type CoordinatorToolResultRenderer = (
  details: Record<string, unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  args: Record<string, unknown>,
) => Component;

const COORDINATOR_TOOL_RESULT_RENDERERS: Record<
  CoordinatorToolName,
  CoordinatorToolResultRenderer
> = {
  subagent: renderSpawnResult,
  agent_message: renderMessageResult,
  subagent_wait: renderWaitResult,
  subagent_status: (details, options, theme) => renderStatusResult(details, options, theme),
  subagent_cancel: (details, options, theme) => renderCancelResult(details, options, theme),
  subagent_delete: (details, options, theme) => renderDeleteResult(details, options, theme),
};

const COORDINATOR_DETAIL_VALIDATORS: Record<
  CoordinatorToolName,
  (details: Record<string, unknown>) => boolean
> = {
  subagent: (details) =>
    asString(details.agent_id) !== undefined &&
    asString(details.turn_id) !== undefined &&
    asString(details.status) !== undefined,
  agent_message: (details) =>
    asString(details.agent_id) !== undefined && typeof details.delivered === "boolean",
  subagent_wait: (details) =>
    asString(details.agent_id) !== undefined && asString(details.status) !== undefined,
  subagent_status: (details) =>
    Array.isArray(details.agents) || asRecord(details.agent) !== undefined,
  subagent_cancel: (details) =>
    asString(details.agent_id) !== undefined &&
    Array.isArray(details.affected_agent_ids) &&
    Array.isArray(details.cancelled_turn_ids),
  subagent_delete: (details) =>
    asString(details.agent_id) !== undefined &&
    Array.isArray(details.deleted_agent_ids) &&
    Array.isArray(details.tombstoned_agent_ids) &&
    Array.isArray(details.failures),
};

/** Render one of the six coordinator tool calls with a shared native Pi grammar. */
export function renderCoordinatorToolCall(
  toolName: CoordinatorToolName,
  args: Record<string, unknown>,
  theme: Theme,
): Component {
  return COORDINATOR_TOOL_CALL_RENDERERS[toolName](args, theme);
}

/** Render one coordinator tool result in native collapsed, expanded, or partial mode. */
export function renderCoordinatorToolResult(
  toolName: CoordinatorToolName,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  args: Record<string, unknown>,
  isError = false,
): Component {
  const details = asRecord(result.details);
  if (!details || !COORDINATOR_DETAIL_VALIDATORS[toolName](details)) {
    return renderFallbackToolResult(result, theme, isError);
  }
  return COORDINATOR_TOOL_RESULT_RENDERERS[toolName](details, options, theme, args);
}

/** Render explicit agent messages with compact source/destination metadata. */
export function renderMinimalSubagentsMessage(
  message: RenderableCoordinatorMessage,
  options: CoordinatorMessageRenderOptions,
  theme: Theme,
): Component {
  return renderCoordinatorMessage("Agent message", "→", message, options, theme);
}

/** Render automatic successful agent results with expandable Markdown output. */
export function renderMinimalSubagentsResult(
  message: RenderableCoordinatorMessage,
  options: CoordinatorMessageRenderOptions,
  theme: Theme,
): Component {
  return renderCoordinatorMessage("Agent result", "✓", message, options, theme);
}

function renderCoordinatorMessage(
  label: string,
  symbol: string,
  message: RenderableCoordinatorMessage,
  options: CoordinatorMessageRenderOptions,
  theme: Theme,
): Component {
  const details = asRecord(message.details);
  const content = coordinatorMessageText(message.content);
  const source = asString(details?.source_agent_id) ?? "unknown";
  const destination = asString(details?.destination_agent_id) ?? "recipient";
  const status = asString(details?.status);
  const route = `${theme.fg("accent", theme.bold(source))} ${theme.fg("dim", "→")} ${theme.fg("accent", theme.bold(destination))}`;
  const heading = [
    `${theme.fg(symbol === "✓" ? "success" : "accent", symbol)} ${theme.bold(label)}`,
    route,
    status ? renderSubagentStatusLabel(theme, status) : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(renderSubagentSeparator(theme));
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  if (!options.expanded) {
    box.addChild(
      new Text(
        `${heading}\n${theme.fg("muted", formatSubagentPreview(content, currentSubagentPreviewWidth(24)))}`,
        0,
        0,
      ),
    );
    return box;
  }
  const container = new Container();
  container.addChild(new Text(heading, 0, 0));
  if (asString(details?.source_turn_id)) {
    container.addChild(renderLabelValue(theme, "Source turn", details?.source_turn_id));
  }
  const duration = formatSubagentDuration(asNumber(details?.elapsed_ms));
  if (duration) container.addChild(renderLabelValue(theme, "Duration", duration));
  container.addChild(new Spacer(1));
  container.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
  const usageText = formatSubagentUsage(asRecord(details?.usage) as Usage | undefined);
  if (usageText) appendSection(container, theme, "Usage", usageText);
  box.addChild(container);
  return box;
}
