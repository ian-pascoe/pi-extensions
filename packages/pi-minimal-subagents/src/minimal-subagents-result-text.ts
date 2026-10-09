import type { Usage } from "@earendil-works/pi-ai";
import {
  formatSubagentCost,
  formatSubagentDuration,
  formatSubagentPreview,
  formatSubagentTokenCount,
  formatSubagentUsage,
} from "./minimal-subagents-rendering.js";
import type {
  AgentDetail,
  AgentMessageResult,
  AgentSummary,
  CancelResult,
  DeleteResult,
  SpawnResult,
  StatusResult,
  ToolSelection,
  WaitDeliveredTurnResult,
  WaitMessageResult,
  WaitResult,
  WaitTimeoutResult,
  WaitTurnResult,
} from "./minimal-subagents-types.js";

/*
 * Model-facing text for Coordinator Tool results. Each renderer states the facts a model acts on
 * in a few lines; `details` and `structuredContent` keep the complete record, so nothing dropped
 * here is lost to codemode scripts or the transcript renderer.
 */

/** Width of the one-line task preview in summaries. */
const TASK_PREVIEW_WIDTH = 120;
/** Width of the one-line latest-result preview in a non-verbose status. */
const RESULT_PREVIEW_WIDTH = 200;
/** Width of each one-line Recent Activity preview in a non-verbose status. */
const ACTIVITY_PREVIEW_WIDTH = 120;
/** Recent Activity items a non-verbose status previews, newest last. */
const STATUS_ACTIVITY_PREVIEW_COUNT = 3;

function joinParts(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function profile(model: string, thinkingLevel: string): string {
  return `${model} (${thinkingLevel})`;
}

/** One `tokens · cost` total, or undefined when usage is unknown. */
function usageTotal(usage: Usage | undefined): string | undefined {
  if (!usage) return undefined;
  return joinParts([
    `${formatSubagentTokenCount(usage.totalTokens) ?? "0"} tokens`,
    formatSubagentCost(usage),
  ]);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function listOrNone(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function without(values: readonly string[], excluded: readonly string[]): string[] {
  const excludedSet = new Set(excluded);
  return values.filter((value) => !excludedSet.has(value));
}

/** Describe the granted tools relative to the requested selection, without repeating a preset's list. */
function spawnToolsSummary(
  granted: readonly string[],
  requested: ToolSelection | undefined,
): string {
  const count = plural(granted.length, "tool");
  if (requested === undefined) return `tools: inherited, ${count}`;
  if (!Array.isArray(requested)) return `tools: ${requested} preset, ${count}`;
  const added = without(granted, requested);
  const missing = without(requested, granted);
  const diff = [
    added.length > 0 ? `+${added.join(", +")}` : undefined,
    missing.length > 0 ? `-${missing.join(", -")}` : undefined,
  ].filter(Boolean);
  return `tools: your list, ${count}${diff.length > 0 ? ` (${diff.join("; ")})` : ""}`;
}

/** One launch line plus any tool-resolution warnings. */
export function formatSpawnResultText(
  result: SpawnResult,
  requestedTools: ToolSelection | undefined,
): string {
  const lines = [
    joinParts([
      `Spawned ${result.agent_id} (turn ${result.turn_id}, ${result.status})`,
      profile(result.model, result.thinking_level),
      spawnToolsSummary(result.tools, requestedTools),
      `delegation ${result.delegation}`,
    ]),
  ];
  for (const warning of result.warnings ?? []) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

/** One line naming how the message was delivered, or why it failed. */
export function formatAgentMessageResultText(result: AgentMessageResult): string {
  switch (result.disposition) {
    case "delivered-via-wait":
      return `Message delivered to ${result.agent_id} through its active wait.`;
    case "queued":
      return `Message queued into ${result.agent_id}'s active turn.`;
    case "started-turn":
      return `${result.agent_id} was idle; the message started turn ${result.turn_id ?? "(unknown)"}. Wait on it with subagent_wait.`;
    case "failed":
      return `Message to ${result.agent_id} failed: ${result.error ?? "unknown error"}`;
  }
}

function coordinationMessagesText(
  agentId: string,
  messages: readonly WaitMessageResult[] | undefined,
): string | undefined {
  if (!messages || messages.length === 0) return undefined;
  return messages.map((message) => `Message from ${agentId}: ${message.message}`).join("\n");
}

/**
 * One line saying an already-delivered result is not repeated and how to reread it, or that a
 * handed result is still to arrive as a separate message, followed by any Coordination Messages
 * the wait drained, which the parent has not seen yet.
 */
function formatWaitDeliveredText(result: WaitDeliveredTurnResult): string {
  const subject = `Result of ${result.agent_id} turn ${result.turn_id} (${result.status})`;
  const notice = result.delivery_pending
    ? `${subject} was handed to you automatically and arrives as a separate message; no reread is needed.`
    : `${subject} was already delivered automatically; call subagent_wait with turn_id "${result.turn_id}" to reread it.`;
  const messages = coordinationMessagesText(result.agent_id, result.messages);
  return messages ? `${notice}\n${messages}` : notice;
}

/** A Coordination Message returned before its source turn settled. */
function formatWaitMessageText(result: WaitMessageResult): string {
  return `Message from ${result.agent_id} (turn ${result.turn_id} still running):\n${result.message}`;
}

/** Status and elapsed time, one token/cost total, drained messages, then the turn's output. */
function formatWaitTurnText(result: WaitTurnResult): string {
  const header = joinParts([
    `${result.agent_id} turn ${result.turn_id} ${result.status}`,
    formatSubagentDuration(result.elapsed_ms),
  ]);
  const total = usageTotal(result.usage);
  const lines = [header];
  if (total) lines.push(`usage: ${total}`);
  if (result.error) lines.push(`error: ${result.error}`);
  const messages = coordinationMessagesText(result.agent_id, result.messages);
  if (messages) lines.push(messages);
  return `${lines.join("\n")}\n\n${result.output || "(no output)"}`;
}

/** The observational timeout snapshot; the wait never cancels the child. */
function formatWaitTimeoutText(result: WaitTimeoutResult): string {
  const lines = [
    `Wait timed out after ${formatSubagentDuration(result.timeout_ms) ?? `${result.timeout_ms}ms`}; ${result.agent_id} is ${result.state} on turn ${result.turn_id} and was not cancelled.`,
  ];
  const progress = joinParts([
    result.elapsed_ms === undefined
      ? undefined
      : `elapsed ${formatSubagentDuration(result.elapsed_ms)}`,
    result.latest_activity_at ? `last activity ${result.latest_activity_at}` : undefined,
    result.total_tokens === undefined
      ? undefined
      : `${formatSubagentTokenCount(result.total_tokens)} tokens`,
  ]);
  if (progress) lines.push(progress);
  if (result.recent_activity_labels.length > 0) {
    lines.push(`recent activity: ${result.recent_activity_labels.join(", ")}`);
  }
  return lines.join("\n");
}

/** Any Wait Event: a message, a settled or already-delivered turn, or a timeout. */
export function formatWaitResultText(result: WaitResult): string {
  if ("already_delivered" in result) return formatWaitDeliveredText(result);
  switch (result.event) {
    case "message":
      return formatWaitMessageText(result);
    case "turn":
      return formatWaitTurnText(result);
    case "timeout":
      return formatWaitTimeoutText(result);
  }
}

function turnSummary(agent: AgentSummary): string {
  if (agent.active_turn_id) return `turn ${agent.active_turn_id}`;
  if (agent.latest_turn)
    return `latest turn ${agent.latest_turn.turn_id} ${agent.latest_turn.status}`;
  return "no turns";
}

function stateSummary(agent: AgentSummary): string {
  return agent.availability === "unavailable" ? `${agent.state}, unavailable` : agent.state;
}

/** One line per direct child; nested summaries and tool lists stay in `details`. */
function formatStatusListText(parentId: string, agents: readonly AgentSummary[]): string {
  if (agents.length === 0) return `${parentId} has no children.`;
  const lines = [`${plural(agents.length, "child", "children")} of ${parentId}:`];
  for (const agent of agents) {
    lines.push(
      `- ${joinParts([
        `${agent.agent_id} ${stateSummary(agent)}`,
        turnSummary(agent),
        profile(agent.model, agent.thinking_level),
        formatSubagentDuration(agent.elapsed_ms),
        agent.child_count > 0 ? plural(agent.child_count, "child", "children") : undefined,
        agent.task ? `task: ${formatSubagentPreview(agent.task, TASK_PREVIEW_WIDTH)}` : undefined,
      ])}`,
    );
  }
  return lines.join("\n");
}

/**
 * Active tools, the Launch Contract grant, and the capability ceiling, each listed at most once:
 * the grant and ceiling are described relative to the list before them.
 */
function toolLines(agent: AgentDetail, verbose: boolean): string[] {
  const active = agent.tools;
  const granted = agent.launch_contract.ordinary_tools;
  const ceiling = agent.capability_ceiling;
  const lines = [`active tools (${active.length}): ${listOrNone(active)}`];

  const inactiveGrants = without(granted, active);
  const adapterTools = without(active, granted);
  if (inactiveGrants.length === 0 && adapterTools.length === 0) {
    lines.push("granted tools: same as active");
  } else {
    const differences = [
      inactiveGrants.length > 0
        ? `plus ${inactiveGrants.join(", ")} (granted but not active: codemode-only or undeclared)`
        : undefined,
      adapterTools.length > 0
        ? `minus ${adapterTools.join(", ")} (active from a runtime adapter, not granted)`
        : undefined,
    ].filter(Boolean);
    lines.push(`granted tools (${granted.length}): active ${differences.join("; ")}`);
  }

  const beyondGrant = without(ceiling, granted);
  if (beyondGrant.length === 0) {
    lines.push("capability ceiling: same as granted");
  } else if (verbose) {
    lines.push(`capability ceiling (${ceiling.length}): granted plus ${beyondGrant.join(", ")}`);
  } else {
    lines.push(
      `capability ceiling: ${ceiling.length} tools, ${beyondGrant.length} beyond the grant`,
    );
  }
  return lines;
}

function launchLine(agent: AgentDetail): string {
  const contract = agent.launch_contract;
  const tools =
    contract.tools === undefined
      ? "inherited tools"
      : Array.isArray(contract.tools)
        ? "explicit tool list"
        : `${contract.tools} preset`;
  const launchedProfile =
    contract.model !== agent.model || contract.thinking_level !== agent.thinking_level
      ? `launched as ${profile(contract.model, contract.thinking_level)}`
      : undefined;
  return `launch: ${joinParts([
    contract.role ? `role ${contract.role}` : undefined,
    launchedProfile,
    tools,
    `session context ${contract.session_context}`,
    `project context ${contract.project_context}`,
    `delegation ${contract.delegation ?? "none"}`,
  ])}`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/**
 * A summary line, then the Launch Contract, tools, latest result, and Recent Activity. Without
 * `verbose` the task, result, and activity are one-line previews and the ceiling is a count.
 */
function formatStatusDetailText(agent: AgentDetail, verbose: boolean): string {
  const lines = [
    joinParts([
      `${agent.agent_id} ${stateSummary(agent)}`,
      turnSummary(agent),
      profile(agent.model, agent.thinking_level),
      agent.elapsed_ms === undefined
        ? undefined
        : `elapsed ${formatSubagentDuration(agent.elapsed_ms)}`,
      agent.latest_activity_at ? `last activity ${agent.latest_activity_at}` : undefined,
      usageTotal(agent.usage),
    ]),
    joinParts([`parent ${agent.parent_id}`, plural(agent.child_count, "child", "children")]),
  ];
  if (agent.unavailable_reason) lines.push(`unavailable: ${agent.unavailable_reason}`);
  if (agent.missing_dependencies.length > 0) {
    lines.push(`missing dependencies: ${agent.missing_dependencies.join(", ")}`);
  }
  if (agent.task) {
    lines.push(
      verbose
        ? `task:\n${indent(agent.task)}`
        : `task: ${formatSubagentPreview(agent.task, TASK_PREVIEW_WIDTH)}`,
    );
  }
  lines.push(launchLine(agent), ...toolLines(agent, verbose));

  const latest = agent.latest_result;
  if (latest) {
    // The summary line already names an idle child's latest turn.
    const heading = joinParts([
      agent.active_turn_id
        ? `latest result: turn ${latest.turn_id} ${latest.status}`
        : "latest result",
      formatSubagentDuration(latest.elapsed_ms),
    ]);
    if (latest.error) lines.push(`${heading}\n  error: ${latest.error}`);
    else lines.push(heading);
    if (latest.output) {
      lines.push(
        verbose
          ? indent(latest.output)
          : `  ${formatSubagentPreview(latest.output, RESULT_PREVIEW_WIDTH)}`,
      );
    }
  }

  if (verbose) {
    const usage = formatSubagentUsage(agent.usage);
    if (usage) lines.push(`usage: ${usage}`);
    if (agent.session_file) lines.push(`session file: ${agent.session_file}`);
    lines.push(`spawn entry: ${agent.spawn_entry_id}`);
    if (agent.recent_messages.length > 0) {
      lines.push(`recent messages (${agent.recent_messages.length}):`);
      for (const message of agent.recent_messages) {
        lines.push(
          `- ${message.source_agent_id} (${message.turn_id}):\n${indent(message.content)}`,
        );
      }
    }
    if (agent.recent_activity.length > 0) {
      lines.push(`recent activity (${agent.recent_activity.length}):`);
      for (const activity of agent.recent_activity) {
        const label = `${activity.label}${activity.truncated ? " (truncated)" : ""}`;
        lines.push(`- ${label}:\n${indent(activity.content)}`);
      }
    }
    return lines.join("\n");
  }

  const activity = agent.recent_activity.slice(-STATUS_ACTIVITY_PREVIEW_COUNT);
  if (activity.length > 0) {
    lines.push(
      `recent activity (last ${activity.length} of ${agent.recent_activity.length}):`,
      ...activity.map(
        (item) => `- ${item.label}: ${formatSubagentPreview(item.content, ACTIVITY_PREVIEW_WIDTH)}`,
      ),
    );
  }
  lines.push(
    "Pass verbose: true for the full task, latest output, capability ceiling, recent messages, and recent activity.",
  );
  return lines.join("\n");
}

/** A direct-children list or one child's detail. */
export function formatStatusResultText(result: StatusResult, verbose = false): string {
  return "agent" in result
    ? formatStatusDetailText(result.agent, verbose)
    : formatStatusListText(result.parent_id, result.agents);
}

/** One line naming the cancelled turns, or that no turn was running. */
export function formatCancelResultText(result: CancelResult): string {
  if (result.cancelled_turn_ids.length === 0) {
    return `Nothing cancelled: ${result.agent_id} had no active turn${result.recursive ? ", nor did any descendant" : ""}.`;
  }
  return `Cancelled ${plural(result.cancelled_turn_ids.length, "active turn")}: ${result.cancelled_turn_ids.join(", ")}; sessions are kept.`;
}

/** One line naming the deleted agents, plus one line per failure. */
export function formatDeleteResultText(result: DeleteResult): string {
  const lines =
    result.deleted_agent_ids.length === 0
      ? [`Deleted no agents under ${result.agent_id}.`]
      : [
          `Deleted ${result.deleted_agent_ids.join(", ")}; ${plural(result.trashed_session_files.length, "session file")} moved to trash.`,
        ];
  for (const failure of result.failures) {
    lines.push(`failed: ${failure.agent_id}: ${failure.error}`);
  }
  return lines.join("\n");
}
