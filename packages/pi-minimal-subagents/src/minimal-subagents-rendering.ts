import type { Usage } from "@earendil-works/pi-ai";
import {
  getMarkdownTheme,
  keyHint,
  type AgentToolResult,
  type MessageRenderer,
  type MessageRenderOptions,
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
import {
  parseCoordinatorMessageDetails,
  parseCoordinatorToolCall,
  parseCoordinatorToolResult,
  type CancelRenderDetails,
  type CoordinatorMessageRenderDetails,
  type CoordinatorToolCallInput,
  type CoordinatorToolName,
  type DeleteRenderDetails,
  type ManagementCallArguments,
  type MessageCallArguments,
  type MessageRenderDetails,
  type RenderStatusAgent,
  type SpawnCallArguments,
  type SpawnRenderDetails,
  type StatusRenderDetails,
  type WaitCallArguments,
  type WaitRenderDetails,
} from "./minimal-subagents-render-contract.js";
import { stripCoordinatorMessageEnvelope } from "./minimal-subagents-message-envelope.js";

export type { CoordinatorToolName } from "./minimal-subagents-render-contract.js";

/** Theme operations used by Minimal Subagents transcript renderers. */
export type MinimalSubagentsRenderTheme = Pick<Theme, "fg" | "bg" | "bold">;

/** Theme operation shared by transcript and widget status renderers. */
export type MinimalSubagentsStatusTheme = Pick<Theme, "fg">;

type RenderableCoordinatorMessage = Pick<Parameters<MessageRenderer>[0], "content" | "details">;

type SubagentPresentationStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unavailable"
  | "idle"
  | "delivered"
  | "delivered-via-wait"
  | "queued"
  | "message";

type SubagentStatusPresentation = { readonly symbol: string; readonly color: ThemeColor };

const SUBAGENT_STATUS_PRESENTATION = {
  running: { symbol: "◉", color: "accent" },
  waiting: { symbol: "◌", color: "accent" },
  completed: { symbol: "✓", color: "success" },
  failed: { symbol: "×", color: "error" },
  cancelled: { symbol: "■", color: "warning" },
  interrupted: { symbol: "!", color: "warning" },
  unavailable: { symbol: "!", color: "warning" },
  idle: { symbol: "○", color: "dim" },
  delivered: { symbol: "→", color: "accent" },
  "delivered-via-wait": { symbol: "→", color: "accent" },
  queued: { symbol: "↗", color: "accent" },
  message: { symbol: "→", color: "accent" },
} satisfies { readonly [Status in SubagentPresentationStatus]: SubagentStatusPresentation };

function coordinatorMessageText(content: RenderableCoordinatorMessage["content"]): string {
  if (!Array.isArray(content)) return stripCoordinatorMessageEnvelope(content);
  return stripCoordinatorMessageEnvelope(
    content
      .map((item) => (item.type === "text" ? item.text : ""))
      .filter(Boolean)
      .join("\n"),
  );
}

function toolResultText(result: AgentToolResult<unknown>): string {
  const text = result.content.find((item) => item.type === "text");
  return text?.type === "text" ? text.text : "";
}

/** Shared unavailable → running → latest-turn → idle status ladder for one subagent. */
export function subagentStatusLadder(agent: {
  readonly availability?: string;
  readonly state?: string;
  readonly latest_turn?: { readonly status?: string };
}): string {
  if (agent.availability === "unavailable") return "unavailable";
  if (agent.state === "running") return "running";
  return agent.latest_turn?.status ?? "idle";
}

function subagentStatusPresentation(status: string): SubagentStatusPresentation {
  // SAFETY: unknown statuses fall back to the idle presentation below.
  const known = status as keyof typeof SUBAGENT_STATUS_PRESENTATION;
  return SUBAGENT_STATUS_PRESENTATION[known] ?? SUBAGENT_STATUS_PRESENTATION.idle;
}

/** Render the shared semantic symbol and color for one subagent status. */
export function renderSubagentStatusSymbol(
  theme: MinimalSubagentsStatusTheme,
  status: string,
): string {
  const presentation = subagentStatusPresentation(status);
  return theme.fg(presentation.color, presentation.symbol);
}

/** Render a subagent status label with the same semantic color as its symbol. */
export function renderSubagentStatusLabel(
  theme: MinimalSubagentsStatusTheme,
  status: string,
): string {
  const presentation = subagentStatusPresentation(status);
  return theme.fg(presentation.color, status);
}

function renderSubagentSeparator(theme: MinimalSubagentsRenderTheme): string {
  return theme.fg("dim", "  ·  ");
}

function renderSubagentSummary(
  theme: MinimalSubagentsRenderTheme,
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

function renderLabelValue(theme: MinimalSubagentsRenderTheme, label: string, value: string): Text {
  return new Text(`${theme.fg("muted", `${label}:`)} ${value}`, 0, 0);
}

function appendSectionHeading(
  container: Container,
  theme: MinimalSubagentsRenderTheme,
  label: string,
): void {
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", theme.bold(label)), 0, 0));
}

function appendTextSection(
  container: Container,
  theme: MinimalSubagentsRenderTheme,
  label: string,
  content: string,
): void {
  appendSectionHeading(container, theme, label);
  container.addChild(new Text(content, 0, 0));
}

function appendComponentSection(
  container: Container,
  theme: MinimalSubagentsRenderTheme,
  label: string,
  content: Component,
): void {
  appendSectionHeading(container, theme, label);
  container.addChild(content);
}

function renderFallbackToolResult(
  result: AgentToolResult<unknown>,
  theme: MinimalSubagentsRenderTheme,
  isError: boolean,
): Component {
  const content = toolResultText(result) || "(no output)";
  return new Text(isError ? theme.fg("error", content) : content, 0, 0);
}

function collapsedExpansionHint(theme: MinimalSubagentsRenderTheme): string {
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
export function formatSubagentPreview(content: string | undefined, maxWidth = 72): string {
  const singleLine = (content ?? "").replace(/\s+/g, " ").trim();
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
  if (usage === undefined) return undefined;
  const values = [
    `input ${formatSubagentTokenCount(usage.input) ?? "0"}`,
    `output ${formatSubagentTokenCount(usage.output) ?? "0"}`,
    `cache read ${formatSubagentTokenCount(usage.cacheRead) ?? "0"}`,
    `cache write ${formatSubagentTokenCount(usage.cacheWrite) ?? "0"}`,
    `total ${formatSubagentTokenCount(usage.totalTokens) ?? "0"}`,
  ];
  if (usage.cost.total > 0) values.push(`cost $${usage.cost.total.toFixed(4)}`);
  return values.join(" · ");
}

function coordinatorToolCallTitle(theme: MinimalSubagentsRenderTheme, label: string): string {
  return theme.fg("toolTitle", theme.bold(label));
}

function coordinatorToolCallPreview(
  theme: MinimalSubagentsRenderTheme,
  value: string | undefined,
): string {
  return value && value.length > 0
    ? ` · ${theme.fg("dim", `“${formatSubagentPreview(value, currentSubagentPreviewWidth(36))}”`)}`
    : "";
}

function renderManagementToolCall(
  label: string,
  args: ManagementCallArguments,
  theme: MinimalSubagentsRenderTheme,
): Component {
  return new Text(
    `${coordinatorToolCallTitle(theme, label)} ${theme.fg("accent", args.agent_id ?? "agent")} ${theme.fg("dim", args.recursive === false ? "· target only" : "· recursive")}`,
    0,
    0,
  );
}

function renderSpawnResult(
  details: SpawnRenderDetails,
  options: ToolRenderResultOptions,
  theme: MinimalSubagentsRenderTheme,
  args: SpawnCallArguments,
): Component {
  const agentId = details.agent_id;
  const status = details.status;
  const agent = details.agent;
  const launchContract = agent?.launch_contract;
  if (!options.expanded) {
    return new Text(
      `${renderSubagentSummary(theme, status, agentId)}${collapsedExpansionHint(theme)}`,
      0,
      0,
    );
  }
  const container = new Container();
  container.addChild(new Text(renderSubagentSummary(theme, status, agentId), 0, 0));
  container.addChild(renderLabelValue(theme, "Turn", details.turn_id));
  appendTextSection(container, theme, "Task", args.task ?? "(task unavailable)");
  const resolvedModel = launchContract?.model ?? args.model;
  const resolvedThinking = launchContract?.thinking_level ?? args.thinking_level;
  const launch = [
    `delegation ${launchContract?.delegation ?? args.delegation ?? "none"}`,
    `session context ${launchContract?.session_context ?? args.session_context ?? "inherit"}`,
    `project context ${launchContract?.project_context ?? args.project_context ?? "inherit"}`,
    resolvedModel ? `model ${resolvedModel}` : undefined,
    resolvedThinking ? `thinking ${resolvedThinking}` : undefined,
  ].filter((value): value is string => value !== undefined);
  appendTextSection(container, theme, "Launch", launch.join(" · "));
  appendTextSection(
    container,
    theme,
    "Resolved tools",
    (launchContract?.ordinary_tools ?? agent?.tools ?? []).join(", ") || "none",
  );
  return container;
}

function messageDisposition(details: MessageRenderDetails): string {
  return "disposition" in details
    ? details.disposition
    : details.delivered
      ? "delivered"
      : "failed";
}

function renderMessageResult(
  details: MessageRenderDetails,
  options: ToolRenderResultOptions,
  theme: MinimalSubagentsRenderTheme,
  args: MessageCallArguments,
): Component {
  const agentId = details.agent_id ?? args.agent_id ?? "parent";
  const historicalBehavior = details.behavior ?? args.behavior;
  const metrics = historicalBehavior ? [historicalBehavior] : [];
  const disposition = messageDisposition(details);
  const summary = renderSubagentSummary(theme, disposition, agentId, metrics);
  if (!options.expanded) return new Text(`${summary}${collapsedExpansionHint(theme)}`, 0, 0);
  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  appendTextSection(container, theme, "Message", args.message ?? "(message unavailable)");
  appendTextSection(container, theme, "Recipient", agentId);
  appendTextSection(container, theme, "Disposition", disposition);
  if (details.error) appendTextSection(container, theme, "Error", details.error);
  return container;
}

function renderWaitResult(
  details: WaitRenderDetails,
  options: ToolRenderResultOptions,
  theme: MinimalSubagentsRenderTheme,
  args: WaitCallArguments,
): Component {
  const agentId = details.agent_id ?? args.agent_id ?? "agent";
  const status = options.isPartial
    ? "waiting"
    : details.event === "message"
      ? "message"
      : details.status;
  const duration = formatSubagentDuration(details.elapsed_ms);
  const tokens = formatSubagentTokenCount(details.usage?.totalTokens);
  const drainedMessageCount = details.event === "message" ? 0 : (details.messages?.length ?? 0);
  const metrics = [
    duration,
    tokens ? `${tokens} tokens` : undefined,
    drainedMessageCount > 0 ? `${drainedMessageCount} messages` : undefined,
  ].filter((metric): metric is string => metric !== undefined);
  const summary = renderSubagentSummary(theme, status, agentId, metrics);
  if (options.isPartial || !options.expanded) {
    return new Text(`${summary}${options.isPartial ? "" : collapsedExpansionHint(theme)}`, 0, 0);
  }
  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  container.addChild(renderLabelValue(theme, "Turn", details.turn_id ?? "unknown"));
  if (details.event === "message") {
    appendTextSection(container, theme, "Message", details.message);
    container.addChild(renderLabelValue(theme, "Message ID", details.message_id));
    return container;
  }
  if (details.messages && details.messages.length > 0) {
    appendTextSection(
      container,
      theme,
      "Messages",
      details.messages.map((message) => message.message).join("\n\n"),
    );
  }
  const output = details.output ?? "";
  if (status === "completed") {
    if (output.length > 0) {
      appendComponentSection(
        container,
        theme,
        "Output",
        new Markdown(output, 0, 0, getMarkdownTheme()),
      );
    } else {
      appendTextSection(container, theme, "Output", "(no output)");
    }
  } else {
    appendTextSection(container, theme, "Error", details.error ?? (output || "(no error detail)"));
    appendTextSection(container, theme, "Diagnostics", JSON.stringify(details, null, 2));
  }
  const usageText = formatSubagentUsage(details.usage);
  if (usageText) appendTextSection(container, theme, "Usage", usageText);
  return container;
}

interface DirectStatusCounts {
  children: number;
  running: number;
}

function countDirectStatusAgents(agents: readonly RenderStatusAgent[]): DirectStatusCounts {
  let running = 0;
  for (const agent of agents) {
    if (agent.state === "running") running++;
  }
  return { children: agents.length, running };
}

function statusAgentPresentation(agent: RenderStatusAgent): string {
  return subagentStatusLadder(agent);
}

function renderDirectStatusRows(
  agents: readonly RenderStatusAgent[],
  theme: MinimalSubagentsRenderTheme,
): string[] {
  return agents.map((agent) => {
    const duration = formatSubagentDuration(agent.elapsed_ms);
    const childCount = agent.child_count ?? 0;
    const metrics = [duration, childCount > 0 ? `${childCount} children` : undefined].filter(
      (metric): metric is string => metric !== undefined,
    );
    return renderSubagentSummary(
      theme,
      statusAgentPresentation(agent),
      agent.agent_id ?? "unknown",
      metrics,
    );
  });
}

type StatusLabelValue = { readonly label: string; readonly value: string | undefined };

function renderDetailedStatusAgent(
  agent: RenderStatusAgent,
  options: ToolRenderResultOptions,
  theme: MinimalSubagentsRenderTheme,
): Component {
  const availability = agent.availability ?? "available";
  const status = statusAgentPresentation(agent);
  const id = agent.agent_id ?? "agent";
  const childCount = agent.child_count ?? 0;
  const duration = formatSubagentDuration(agent.elapsed_ms);
  const metrics = [duration, `${childCount} children`].filter(
    (metric): metric is string => metric !== undefined,
  );
  const summary = renderSubagentSummary(theme, status, id, metrics);
  if (!options.expanded) return new Text(`${summary}${collapsedExpansionHint(theme)}`, 0, 0);
  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  const labels = [
    { label: "Parent", value: agent.parent_id },
    { label: "Availability", value: availability },
    { label: "Turn", value: agent.active_turn_id ?? agent.latest_turn?.turn_id },
    { label: "Duration", value: duration },
    { label: "Model", value: agent.model },
    { label: "Thinking", value: agent.thinking_level },
    { label: "Session", value: agent.session_file },
    { label: "Spawn entry", value: agent.spawn_entry_id },
  ] satisfies readonly StatusLabelValue[];
  for (const { label, value } of labels) {
    if (value !== undefined) container.addChild(renderLabelValue(theme, label, value));
  }
  if (agent.task) appendTextSection(container, theme, "Task", agent.task);
  const launchContract = agent.launch_contract;
  if (launchContract) {
    const launchValues = [
      `session context ${launchContract.session_context ?? "inherit"}`,
      `project context ${launchContract.project_context ?? "inherit"}`,
      `model ${launchContract.model ?? agent.model ?? "unknown"}`,
      `thinking ${launchContract.thinking_level ?? agent.thinking_level ?? "unknown"}`,
      `delegation ${launchContract.delegation ?? "none"}`,
    ];
    appendTextSection(container, theme, "Launch contract", launchValues.join(" · "));
  }
  appendTextSection(container, theme, "Tools", (agent.tools ?? []).join(", ") || "none");
  appendTextSection(
    container,
    theme,
    "Capability ceiling",
    (agent.capability_ceiling ?? []).join(", ") || "none",
  );
  const missing = agent.missing_dependencies ?? [];
  if (missing.length > 0) {
    appendTextSection(container, theme, "Missing dependencies", missing.join("\n"));
  }
  if (agent.unavailable_reason) {
    appendTextSection(container, theme, "Unavailable reason", agent.unavailable_reason);
  }
  const recentMessages = agent.recent_messages ?? [];
  if (recentMessages.length > 0) {
    appendTextSection(
      container,
      theme,
      "Recent messages",
      recentMessages
        .map((message) => `${message.source_agent_id ?? "unknown"}: ${message.content ?? ""}`)
        .join("\n"),
    );
  }
  const latestResult = agent.latest_result;
  if (latestResult) {
    const output = latestResult.output ?? "";
    if (latestResult.status === "completed" && output) {
      appendComponentSection(
        container,
        theme,
        "Latest result",
        new Markdown(output, 0, 0, getMarkdownTheme()),
      );
    } else {
      appendTextSection(
        container,
        theme,
        "Latest result",
        output || JSON.stringify(latestResult, null, 2),
      );
    }
  }
  const usageText = formatSubagentUsage(agent.usage);
  if (usageText) appendTextSection(container, theme, "Usage", usageText);
  return container;
}

function renderStatusResult(
  details: StatusRenderDetails,
  options: ToolRenderResultOptions,
  theme: MinimalSubagentsRenderTheme,
): Component {
  if ("agents" in details) {
    const counts = countDirectStatusAgents(details.agents);
    const summary = [
      theme.fg("muted", `${counts.children} children`),
      theme.fg(counts.running > 0 ? "accent" : "dim", `${counts.running} running`),
    ].join(renderSubagentSeparator(theme));
    if (!options.expanded) return new Text(`${summary}${collapsedExpansionHint(theme)}`, 0, 0);
    return new Text(
      `${summary}\n${renderDirectStatusRows(details.agents, theme).join("\n") || theme.fg("dim", "(no agents)")}`,
      0,
      0,
    );
  }
  return renderDetailedStatusAgent(details.agent, options, theme);
}

function renderCancelResult(
  details: CancelRenderDetails,
  options: ToolRenderResultOptions,
  theme: MinimalSubagentsRenderTheme,
): Component {
  const turns = details.cancelled_turn_ids;
  const summary =
    turns.length > 0
      ? renderSubagentSummary(theme, "cancelled", details.agent_id, [
          `${turns.length} turns cancelled`,
        ])
      : renderSubagentSummary(theme, "completed", details.agent_id, ["no active turns"]);
  if (!options.expanded) return new Text(`${summary}${collapsedExpansionHint(theme)}`, 0, 0);
  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  container.addChild(renderLabelValue(theme, "Requested target", details.agent_id));
  container.addChild(
    renderLabelValue(theme, "Mode", details.recursive ? "recursive" : "target only"),
  );
  appendTextSection(
    container,
    theme,
    "Affected agents",
    details.affected_agent_ids.join("\n") || "(none)",
  );
  appendTextSection(container, theme, "Cancelled turns", turns.join("\n") || "(none)");
  return container;
}

function renderDeleteResult(
  details: DeleteRenderDetails,
  options: ToolRenderResultOptions,
  theme: MinimalSubagentsRenderTheme,
): Component {
  const status = details.failures.length > 0 ? "failed" : "completed";
  const metrics = [
    `${details.deleted_agent_ids.length} agents deleted`,
    `${details.deleted_agent_ids.length} tombstones`,
    details.failures.length > 0 ? `${details.failures.length} failed` : undefined,
  ].filter((metric): metric is string => metric !== undefined);
  const summary = renderSubagentSummary(theme, status, details.agent_id, metrics);
  if (!options.expanded) return new Text(`${summary}${collapsedExpansionHint(theme)}`, 0, 0);
  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  container.addChild(renderLabelValue(theme, "Requested target", details.agent_id));
  container.addChild(
    renderLabelValue(theme, "Mode", details.recursive ? "recursive" : "target only"),
  );
  appendTextSection(
    container,
    theme,
    "Deleted agents",
    details.deleted_agent_ids.join("\n") || "(none)",
  );
  appendTextSection(
    container,
    theme,
    "Trashed sessions",
    details.trashed_session_files.join("\n") || "(none)",
  );
  if (details.failures.length > 0) {
    appendTextSection(
      container,
      theme,
      "Failures",
      theme.fg("error", JSON.stringify(details.failures, null, 2)),
    );
  }
  return container;
}

/** Render one of the six coordinator tool calls with a shared native Pi grammar. */
export function renderCoordinatorToolCall(
  toolName: CoordinatorToolName,
  args: CoordinatorToolCallInput,
  theme: MinimalSubagentsRenderTheme,
): Component {
  const parsed = parseCoordinatorToolCall(toolName, args);
  if (parsed === undefined) return new Text(coordinatorToolCallTitle(theme, toolName), 0, 0);
  switch (parsed.toolName) {
    case "subagent":
      return new Text(
        `${coordinatorToolCallTitle(theme, "Subagent")} ${theme.fg("accent", parsed.args.agent_id ?? "generated")}${coordinatorToolCallPreview(theme, parsed.args.task)}`,
        0,
        0,
      );
    case "agent_message":
      return new Text(
        `${coordinatorToolCallTitle(theme, "Message")} ${theme.fg("accent", parsed.args.agent_id ?? "parent")}${coordinatorToolCallPreview(theme, parsed.args.message)}`,
        0,
        0,
      );
    case "subagent_wait":
      return new Text(
        `${coordinatorToolCallTitle(theme, "Wait")} ${theme.fg("accent", parsed.args.agent_id ?? "agent")}`,
        0,
        0,
      );
    case "subagent_status":
      return new Text(
        `${coordinatorToolCallTitle(theme, "Status")} ${theme.fg("accent", parsed.args.agent_id ?? "children")}`,
        0,
        0,
      );
    case "subagent_cancel":
      return renderManagementToolCall("Cancel", parsed.args, theme);
    case "subagent_delete":
      return renderManagementToolCall("Delete", parsed.args, theme);
  }
}

/** Render one coordinator tool result in native collapsed, expanded, or partial mode. */
export function renderCoordinatorToolResult(
  toolName: CoordinatorToolName,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: MinimalSubagentsRenderTheme,
  args: CoordinatorToolCallInput,
  isError = false,
): Component {
  const parsedResult = parseCoordinatorToolResult(toolName, result.details);
  if (parsedResult === undefined) return renderFallbackToolResult(result, theme, isError);
  const parsedCall = parseCoordinatorToolCall(toolName, args);
  switch (parsedResult.toolName) {
    case "subagent":
      return renderSpawnResult(
        parsedResult.details,
        options,
        theme,
        parsedCall?.toolName === "subagent" ? parsedCall.args : {},
      );
    case "agent_message":
      return renderMessageResult(
        parsedResult.details,
        options,
        theme,
        parsedCall?.toolName === "agent_message" ? parsedCall.args : {},
      );
    case "subagent_wait":
      return renderWaitResult(
        parsedResult.details,
        options,
        theme,
        parsedCall?.toolName === "subagent_wait" ? parsedCall.args : {},
      );
    case "subagent_status":
      return renderStatusResult(parsedResult.details, options, theme);
    case "subagent_cancel":
      return renderCancelResult(parsedResult.details, options, theme);
    case "subagent_delete":
      return renderDeleteResult(parsedResult.details, options, theme);
  }
}

/** Render explicit agent messages with compact source/destination metadata. */
export function renderMinimalSubagentsMessage(
  message: RenderableCoordinatorMessage,
  options: MessageRenderOptions,
  theme: MinimalSubagentsRenderTheme,
): Component {
  return renderCoordinatorMessage("Agent message", "→", message, options, theme);
}

/** Render automatic successful agent results with expandable Markdown output. */
export function renderMinimalSubagentsResult(
  message: RenderableCoordinatorMessage,
  options: MessageRenderOptions,
  theme: MinimalSubagentsRenderTheme,
): Component {
  return renderCoordinatorMessage("Agent result", "✓", message, options, theme);
}

function messageSource(details: CoordinatorMessageRenderDetails | undefined): string {
  return details?.source_agent_id ?? details?.agent_id ?? "unknown";
}

function messageSourceTurn(
  details: CoordinatorMessageRenderDetails | undefined,
): string | undefined {
  return details?.source_turn_id ?? details?.turn_id;
}

function renderCoordinatorMessage(
  label: string,
  symbol: string,
  message: RenderableCoordinatorMessage,
  options: MessageRenderOptions,
  theme: MinimalSubagentsRenderTheme,
): Component {
  const details = parseCoordinatorMessageDetails(message.details);
  const content = coordinatorMessageText(message.content);
  const source = messageSource(details);
  const destination = details?.destination_agent_id ?? "recipient";
  const sourceTurn = messageSourceTurn(details);
  const route = `${theme.fg("accent", theme.bold(source))} ${theme.fg("dim", "→")} ${theme.fg("accent", theme.bold(destination))}`;
  const heading = [
    `${theme.fg(symbol === "✓" ? "success" : "accent", symbol)} ${theme.bold(label)}`,
    route,
    sourceTurn ? theme.fg("dim", `turn ${sourceTurn}`) : undefined,
    details?.status ? renderSubagentStatusLabel(theme, details.status) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
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
  if (sourceTurn) container.addChild(renderLabelValue(theme, "Source turn", sourceTurn));
  const duration = formatSubagentDuration(details?.elapsed_ms);
  if (duration) container.addChild(renderLabelValue(theme, "Duration", duration));
  container.addChild(new Spacer(1));
  container.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
  const usageText = formatSubagentUsage(details?.usage);
  if (usageText) appendTextSection(container, theme, "Usage", usageText);
  box.addChild(container);
  return box;
}
