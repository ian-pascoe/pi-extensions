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
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  parseCoordinatorMessageDetails,
  parseCoordinatorToolCall,
  parseCoordinatorToolResult,
  parseWaitProgressDetails,
  type CancelRenderDetails,
  type CoordinatorMessageRenderDetails,
  type CoordinatorToolCallInput,
  type CoordinatorToolName,
  type DeleteRenderDetails,
  type ManagementCallArguments,
  type MessageCallArguments,
  type MessageRenderDetails,
  type RenderRecentActivity,
  type RenderStatusAgent,
  type SpawnCallArguments,
  type SpawnRenderDetails,
  type StatusRenderDetails,
  type WaitCallArguments,
  type WaitProgressRenderDetails,
  type WaitRenderDetails,
} from "./minimal-subagents-render-contract.js";
import { stripCoordinatorMessageEnvelope } from "./minimal-subagents-message-envelope.js";
import type { AgentSummary } from "./minimal-subagents-types.js";

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
  | "started-turn"
  | "message"
  | "timed out";

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
  "started-turn": { symbol: "◉", color: "accent" },
  message: { symbol: "→", color: "accent" },
  "timed out": { symbol: "!", color: "warning" },
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

/** Copy the hierarchy with active subtrees first, preserving sibling ties and ancestry. */
export function orderActiveAgentSubtrees(agents: readonly AgentSummary[]): AgentSummary[] {
  const orderSiblings = (
    siblings: readonly AgentSummary[],
  ): { agent: AgentSummary; active: boolean }[] =>
    siblings
      .map((agent) => {
        const children = orderSiblings(agent.children ?? []);
        return {
          agent: { ...agent, children: children.map((child) => child.agent) },
          active: agent.state === "running" || children.some((child) => child.active),
        };
      })
      .sort((left, right) => Number(right.active) - Number(left.active));
  return orderSiblings(agents).map(({ agent }) => agent);
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

/** Collapsed previews match Pi's built-in `read` output height. */
const COLLAPSED_PREVIEW_LINES = 10;

function isBlankRenderedLine(line: string): boolean {
  return visibleWidth(line.trim()) === 0;
}

function withoutTrailingBlankLines(lines: string[]): string[] {
  const end = lines.findLastIndex((line) => !isBlankRenderedLine(line));
  return lines.slice(0, end + 1);
}

/** Shows the first rendered lines of `content`, noting how many lines expanding would reveal. */
class CollapsedPreview implements Component {
  constructor(
    private readonly content: Component,
    private readonly theme: MinimalSubagentsRenderTheme,
  ) {}

  render(width: number): string[] {
    const lines = withoutTrailingBlankLines(this.content.render(width));
    if (lines.length <= COLLAPSED_PREVIEW_LINES) return lines;
    // A cut at a paragraph break would leave a blank line above the hint.
    const shown = withoutTrailingBlankLines(lines.slice(0, COLLAPSED_PREVIEW_LINES));
    const hidden = lines.length - shown.length;
    return [
      ...shown,
      // The result's first line already carries the expansion hint.
      this.theme.fg("muted", `... (${hidden} more lines)`),
    ];
  }

  invalidate(): void {
    this.content.invalidate();
  }
}

function collapsedMarkdownPreview(content: string, theme: MinimalSubagentsRenderTheme): Component {
  return new CollapsedPreview(new Markdown(content, 0, 0, getMarkdownTheme()), theme);
}

function collapsedTextPreview(content: string, theme: MinimalSubagentsRenderTheme): Component {
  return new CollapsedPreview(new Text(content, 0, 0), theme);
}

const ToolArgumentsSchema = Type.Record(Type.String(), Type.Unknown());
const ScalarArgumentSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);

/** Summarize tool-call arguments by their values, e.g. a path or command rather than its JSON. */
function toolArgumentSummary(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Recent Activity keeps the tail of long arguments, which is no longer valid JSON.
    return content;
  }
  if (!Value.Check(ToolArgumentsSchema, parsed)) return content;
  return Object.values(parsed)
    .filter((value) => value !== null && value !== undefined)
    .map((value) =>
      Value.Check(ScalarArgumentSchema, value) ? String(value) : JSON.stringify(value),
    )
    .join(" ");
}

function lastNonEmptyLine(content: string): string {
  return (
    content
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line.length > 0) ?? ""
  );
}

/** One activity entry as a single width-bounded line, truncating plain text before styling it. */
function formatActivityLine(
  activity: RenderRecentActivity,
  theme: MinimalSubagentsRenderTheme,
  width: number,
): string {
  const fit = (prefix: string, text: string) =>
    formatSubagentPreview(text, Math.max(1, width - visibleWidth(prefix)));
  if (activity.label.startsWith("tool call ")) {
    const name = activity.label.slice("tool call ".length);
    const prefix = `\u2192 ${name} `;
    return `${theme.fg("accent", "\u2192")} ${theme.fg("toolTitle", name)} ${theme.fg("dim", fit(prefix, toolArgumentSummary(activity.content)))}`;
  }
  if (activity.label.startsWith("tool result ")) {
    const failed = activity.label.endsWith(" (error)");
    const name = activity.label.slice("tool result ".length).replace(/ \(error\)$/, "");
    const prefix = `${failed ? "\u2717" : "\u2190"} ${name}: `;
    return theme.fg(failed ? "error" : "dim", `${prefix}${fit(prefix, activity.content)}`);
  }
  if (activity.label === "reasoning") {
    const prefix = "thinking: ";
    return theme.fg("dim", `${prefix}${fit(prefix, lastNonEmptyLine(activity.content))}`);
  }
  if (activity.label === "assistant message") {
    return theme.fg("muted", fit("", lastNonEmptyLine(activity.content)));
  }
  const prefix = `${activity.label}: `;
  return theme.fg("dim", `${prefix}${fit(prefix, activity.content)}`);
}

/** Columns the activity rail takes before each item's own lines. */
export const ACTIVITY_RAIL_WIDTH = 3;

/** Hang rendered items off a tree rail: `├─` opens each item, `│` continues it, `└─` opens the last. */
export function drawActivityRail(
  items: readonly (readonly string[])[],
  theme: MinimalSubagentsRenderTheme,
): string[] {
  return items.flatMap((lines, index) => {
    const last = index === items.length - 1;
    const [first = "", ...rest] = lines;
    return [
      `${theme.fg("dim", last ? "└─ " : "├─ ")}${first}`,
      ...rest.map((line) => `${theme.fg("dim", last ? "   " : "│  ")}${line}`),
    ];
  });
}

/** Width-aware rendering of recorded activity, one rail item per entry. */
class ActivityLines implements Component {
  constructor(
    private readonly activity: readonly RenderRecentActivity[],
    private readonly theme: MinimalSubagentsRenderTheme,
  ) {}

  render(width: number): string[] {
    const itemWidth = Math.max(1, width - ACTIVITY_RAIL_WIDTH);
    return drawActivityRail(
      this.activity.map((entry) => [formatActivityLine(entry, this.theme, itemWidth)]),
      this.theme,
    );
  }

  invalidate(): void {}
}

const COLLAPSED_ACTIVITY_LINES = 3;

/** Latest progress-relevant activity: model output and tool calls, plus only failed tool results. */
function latestProgressActivity(activity: readonly RenderRecentActivity[]): RenderRecentActivity[] {
  return activity
    .filter(
      (entry) =>
        entry.label === "assistant message" ||
        entry.label === "reasoning" ||
        entry.label.startsWith("tool call ") ||
        (entry.label.startsWith("tool result ") && entry.label.endsWith(" (error)")),
    )
    .slice(-COLLAPSED_ACTIVITY_LINES);
}

/** Format a turn's cost for summary rows; sub-cent costs keep enough precision to be non-zero. */
function formatSubagentCost(usage: Usage | undefined): string | undefined {
  const total = usage?.cost.total;
  if (total === undefined || !(total > 0)) return undefined;
  return `$${total.toFixed(total < 0.01 ? 4 : 2)}`;
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

/** Launch settings the caller chose explicitly; defaults are omitted to keep the header short. */
function spawnCallLaunchSummary(args: SpawnCallArguments): string[] {
  const profile = args.model
    ? `${args.model}${args.thinking_level ? `:${args.thinking_level}` : ""}`
    : args.thinking_level
      ? `thinking ${args.thinking_level}`
      : undefined;
  const tools =
    args.tools === undefined
      ? undefined
      : `tools ${Array.isArray(args.tools) ? args.tools.join(", ") || "none" : args.tools}`;
  return [
    args.role ? `role ${args.role}` : undefined,
    profile,
    tools,
    args.session_context && args.session_context !== "omit"
      ? `context ${args.session_context}`
      : undefined,
    args.project_context === "omit" ? "no project context" : undefined,
    args.delegation && args.delegation !== "none" ? args.delegation : undefined,
  ].filter((part): part is string => part !== undefined);
}

/** A call header followed by its long text argument, previewed when collapsed. */
function renderCallWithText(
  header: string,
  text: string | undefined,
  theme: MinimalSubagentsRenderTheme,
  expanded: boolean,
): Component {
  if (!text) return new Text(header, 0, 0);
  const container = new Container();
  container.addChild(new Text(header, 0, 0));
  container.addChild(expanded ? new Text(text, 0, 0) : collapsedTextPreview(text, theme));
  return container;
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
  const resolvedModel = launchContract?.model ?? args.model;
  const resolvedThinking = launchContract?.thinking_level ?? args.thinking_level;
  const launch = [
    `delegation ${launchContract?.delegation ?? args.delegation ?? "none"}`,
    `session context ${launchContract?.session_context ?? args.session_context ?? "omit"}`,
    `project context ${launchContract?.project_context ?? args.project_context ?? "inherit"}`,
    launchContract?.role ? `role ${launchContract.role}` : undefined,
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
  appendTextSection(container, theme, "Recipient", agentId);
  appendTextSection(container, theme, "Disposition", disposition);
  if ("turn_id" in details && details.turn_id) {
    appendTextSection(container, theme, "Started turn", details.turn_id);
  }
  if (details.error) appendTextSection(container, theme, "Error", details.error);
  return container;
}

/** Renders a running child's turn for a waiting parent; returns nothing when the turn is not live. */
export type LiveTurnRenderer = (
  agentId: string,
  turnId: string | undefined,
  expanded: boolean,
) => Component | undefined;

function renderWaitProgress(
  details: WaitProgressRenderDetails,
  options: ToolRenderResultOptions,
  theme: MinimalSubagentsRenderTheme,
  renderLiveTurn: LiveTurnRenderer | undefined,
): Component {
  const toolCalls = details.tool_calls ?? 0;
  const metrics = [
    formatSubagentDuration(details.elapsed_ms),
    toolCalls > 0 ? `${toolCalls} tool ${toolCalls === 1 ? "call" : "calls"}` : undefined,
  ].filter((metric): metric is string => metric !== undefined);
  const summary = renderSubagentSummary(theme, "waiting", details.agent_id, metrics);
  const liveTurn = renderLiveTurn?.(details.agent_id, details.turn_id, options.expanded);
  if (!liveTurn) return new Text(summary, 0, 0);
  const container = new Container();
  container.addChild(
    new Text(options.expanded ? summary : `${summary}${collapsedExpansionHint(theme)}`, 0, 0),
  );
  container.addChild(liveTurn);
  return container;
}

/** The collapsed body of a settled wait: what the child said, or why it stopped. */
function collapsedWaitBody(
  details: WaitRenderDetails,
  status: string,
  theme: MinimalSubagentsRenderTheme,
): Component | undefined {
  if (details.event === "message") return collapsedTextPreview(details.message, theme);
  if (details.event === "timeout") {
    const activity = latestProgressActivity(details.agent.recent_activity ?? []);
    return activity.length > 0 ? new ActivityLines(activity, theme) : undefined;
  }
  const output = details.output ?? "";
  if (status === "completed") {
    return output ? collapsedMarkdownPreview(output, theme) : undefined;
  }
  return collapsedTextPreview(
    theme.fg("error", details.error ?? (output || "(no error detail)")),
    theme,
  );
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
      : details.event === "timeout"
        ? "timed out"
        : details.status;
  const duration = formatSubagentDuration(
    details.event === "timeout" ? details.timeout_ms : details.elapsed_ms,
  );
  const usage = details.event === "timeout" ? undefined : details.usage;
  const tokens = formatSubagentTokenCount(usage?.totalTokens);
  const drainedMessageCount =
    details.event === "message" || details.event === "timeout"
      ? 0
      : (details.messages?.length ?? 0);
  const metrics = [
    duration,
    tokens ? `${tokens} tokens` : undefined,
    formatSubagentCost(usage),
    drainedMessageCount > 0 ? `${drainedMessageCount} messages` : undefined,
  ].filter((metric): metric is string => metric !== undefined);
  const summary = renderSubagentSummary(theme, status, agentId, metrics);
  if (options.isPartial) return new Text(summary, 0, 0);
  if (!options.expanded) {
    const body = collapsedWaitBody(details, status, theme);
    const heading = `${summary}${collapsedExpansionHint(theme)}`;
    if (!body) return new Text(heading, 0, 0);
    const container = new Container();
    container.addChild(new Text(heading, 0, 0));
    container.addChild(body);
    return container;
  }
  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  container.addChild(renderLabelValue(theme, "Turn", details.turn_id ?? "unknown"));
  if (details.event === "message") {
    appendTextSection(container, theme, "Message", details.message);
    container.addChild(renderLabelValue(theme, "Message ID", details.message_id));
    return container;
  }
  if (details.event === "timeout") {
    appendComponentSection(
      container,
      theme,
      "Child status",
      renderDetailedStatusAgent(details.agent, options, theme),
    );
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
    const metrics = [
      duration,
      childCount > 0 ? `${childCount} ${childCount === 1 ? "child" : "children"}` : undefined,
    ].filter((metric): metric is string => metric !== undefined);
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
  const metrics = [duration, `${childCount} ${childCount === 1 ? "child" : "children"}`].filter(
    (metric): metric is string => metric !== undefined,
  );
  const summary = renderSubagentSummary(theme, status, id, metrics);
  if (!options.expanded) {
    const activity = latestProgressActivity(agent.recent_activity ?? []);
    const heading = `${summary}${collapsedExpansionHint(theme)}`;
    if (activity.length === 0) return new Text(heading, 0, 0);
    const collapsed = new Container();
    collapsed.addChild(new Text(heading, 0, 0));
    collapsed.addChild(new ActivityLines(activity, theme));
    return collapsed;
  }
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
      ...(launchContract.role ? [`role ${launchContract.role}`] : []),
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
  const recentActivity = agent.recent_activity ?? [];
  if (recentActivity.length > 0) {
    appendTextSection(
      container,
      theme,
      "Recent activity",
      recentActivity
        .map(
          (activity) =>
            `${activity.label}${activity.truncated ? " (truncated)" : ""}\n${activity.content}`,
        )
        .join("\n\n"),
    );
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
    const rows =
      renderDirectStatusRows(details.agents, theme).join("\n") || theme.fg("dim", "(no agents)");
    const container = new Container();
    container.addChild(
      new Text(options.expanded ? summary : `${summary}${collapsedExpansionHint(theme)}`, 0, 0),
    );
    container.addChild(options.expanded ? new Text(rows, 0, 0) : collapsedTextPreview(rows, theme));
    return container;
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
          `${turns.length} ${turns.length === 1 ? "turn" : "turns"} cancelled`,
          details.affected_agent_ids.join(", "),
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
  const deletedCount = details.deleted_agent_ids.length;
  const metrics = [
    `${deletedCount} ${deletedCount === 1 ? "agent" : "agents"} deleted`,
    deletedCount > 0 ? details.deleted_agent_ids.join(", ") : undefined,
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
  expanded = false,
): Component {
  const parsed = parseCoordinatorToolCall(toolName, args);
  if (parsed === undefined) return new Text(coordinatorToolCallTitle(theme, toolName), 0, 0);
  switch (parsed.toolName) {
    case "subagent": {
      const header = [
        `${coordinatorToolCallTitle(theme, "Subagent")} ${theme.fg("accent", parsed.args.agent_id ?? "generated")}`,
        ...spawnCallLaunchSummary(parsed.args).map((part) => theme.fg("dim", part)),
      ].join(theme.fg("dim", " · "));
      return renderCallWithText(header, parsed.args.task, theme, expanded);
    }
    case "agent_message":
      return renderCallWithText(
        `${coordinatorToolCallTitle(theme, "Message")} ${theme.fg("accent", parsed.args.agent_id ?? "parent")}`,
        parsed.args.message,
        theme,
        expanded,
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
  renderLiveTurn?: LiveTurnRenderer,
): Component {
  if (toolName === "subagent_wait" && options.isPartial) {
    const progress = parseWaitProgressDetails(result.details);
    if (progress) return renderWaitProgress(progress, options, theme, renderLiveTurn);
  }
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
  const metrics = [formatSubagentDuration(details?.elapsed_ms), formatSubagentCost(details?.usage)];
  const heading = [
    `${theme.fg(symbol === "✓" ? "success" : "accent", symbol)} ${theme.bold(label)}`,
    route,
    details?.status ? renderSubagentStatusLabel(theme, details.status) : undefined,
    ...metrics.map((metric) => (metric ? theme.fg("muted", metric) : undefined)),
  ]
    .filter((part): part is string => part !== undefined)
    .join(renderSubagentSeparator(theme));
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  if (!options.expanded) {
    box.addChild(new Text(`${heading}${collapsedExpansionHint(theme)}`, 0, 0));
    box.addChild(collapsedMarkdownPreview(content, theme));
    return box;
  }
  const container = new Container();
  container.addChild(new Text(heading, 0, 0));
  if (sourceTurn) container.addChild(renderLabelValue(theme, "Source turn", sourceTurn));
  container.addChild(new Spacer(1));
  container.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
  const usageText = formatSubagentUsage(details?.usage);
  if (usageText) appendTextSection(container, theme, "Usage", usageText);
  box.addChild(container);
  return box;
}
