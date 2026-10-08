import { keyHint, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { riskLabel } from "./guardian-assessment.js";
import {
  reviewEntrySchema,
  reviewTotalsSchema,
  type AuditResult,
  type EscalationRecord,
} from "./guardian-audit.js";
import {
  configuredClassifier,
  escalationThinkingLevel,
  guardianDefaults,
  guardianAppliedChangeSchema,
  guardianOptionKeys,
  guardianOptionsSchema,
  guardianSettingSourceSchema,
  type GuardianOptions,
} from "./guardian-settings.js";

/** Theme operations used by Guardian renderers. */
export type GuardianRenderTheme = Pick<Theme, "fg" | "bg" | "bold">;

/** Custom session entry recording `/guardian status` and applied changes. */
export const statusEntryType = "pi-guardian-status";

const nullableString = Type.Union([Type.String(), Type.Null()]);
export const guardianStateSchema = Type.Union([
  Type.Literal("enabled"),
  Type.Literal("disabled"),
  Type.Literal("error"),
]);
export type GuardianState = Static<typeof guardianStateSchema>;
export const statusEntrySchema = Type.Object({
  state: guardianStateSchema,
  changes: Type.Optional(Type.Array(guardianAppliedChangeSchema)),
  /** Effective settings in authored form: `tools` lists the merged Tool Policies. */
  settings: Type.Optional(guardianOptionsSchema),
  sources: Type.Optional(Type.Record(Type.String(), guardianSettingSourceSchema)),
  /** Root session whose settings this Child Agent or Advisor follows. */
  followsRoot: Type.Optional(nullableString),
  totals: Type.Optional(reviewTotalsSchema),
  error: Type.Optional(nullableString),
});
/** Data recorded in a `pi-guardian-status` entry. */
export type GuardianStatusEntry = Static<typeof statusEntrySchema>;

const stateBadge = {
  enabled: { symbol: "●", color: "success" },
  disabled: { symbol: "○", color: "dim" },
  error: { symbol: "●", color: "error" },
} as const satisfies Record<GuardianState, { symbol: string; color: ThemeColor }>;
const resultStyle = {
  allowed: { symbol: "✓", color: "success" },
  rejected: { symbol: "✖", color: "error" },
  failed: { symbol: "⚠", color: "warning" },
  aborted: { symbol: "○", color: "dim" },
  unused: { symbol: "○", color: "dim" },
} as const satisfies Record<AuditResult, { symbol: string; color: ThemeColor }>;
const previewWidth = 40;

function expandHint(theme: Pick<Theme, "fg">): string {
  return theme.fg("dim", `… ${keyHint("app.tools.expand", "to expand")}`);
}

function preview(text: string): string {
  const first = text.split("\n", 1)[0] ?? "";
  return first.length > previewWidth ? `${first.slice(0, previewWidth - 1)}…` : first;
}

function formatMoney(cost: number): string {
  return `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
}

/** Human-readable option value; an absent value inherits. */
export function formatGuardianOption(options: GuardianOptions, key: keyof GuardianOptions): string {
  switch (key) {
    case "policy":
      if (options.policy === undefined) return "inherit";
      return options.policy.trim()
        ? `${preview(options.policy)} (${options.policy.length} chars)`
        : "none";
    case "tools":
    case "commands": {
      const value = options[key];
      if (value === undefined) return "inherit";
      const entries = Object.entries(value);
      return entries.length
        ? entries.map(([name, policy]) => `${name}=${policy ?? "default"}`).join(", ")
        : "none";
    }
    case "reviewTimeoutMs":
      if (options.reviewTimeoutMs === undefined) return "inherit";
      return options.reviewTimeoutMs < 1_000
        ? `${options.reviewTimeoutMs}ms`
        : `${options.reviewTimeoutMs / 1_000}s`;
    case "enabled":
    case "verbose": {
      const value = options[key];
      return value === undefined ? "inherit" : value ? "on" : "off";
    }
    default: {
      const value = options[key];
      return value === undefined ? "inherit" : String(value);
    }
  }
}

/** What an Escalation Pass did to a review's First Pass. */
function escalationLabel(escalation: EscalationRecord): string {
  const first = escalation.firstPass;
  const scores = first
    ? `${riskLabel({ risk: first.risk, category: first.riskCategory })}/${first.authorization}`
    : undefined;
  const was = {
    rejected: `first pass ${scores ?? "rejected"}`,
    uncertain: `classifier unsure: ${scores ?? "no assessment"}`,
    uncategorized: `classifier gave no Risk Category: ${scores ?? "no assessment"}`,
    failed: "classifier failed",
  }[escalation.trigger];
  if (escalation.result === "assessed") return `escalated (${was})`;
  if (escalation.result === "aborted") return `escalation aborted (${was})`;
  if (escalation.trigger === "rejected") return `escalation failed, first pass stands (${was})`;
  return `escalation failed (${was})`;
}

/**
 * Whether a review's escalation needs attention even when its call was allowed: one that
 * overturned a would-be Rejection or followed a failed classifier does, while a classifier's
 * doubt that the Escalation Pass resolved does not.
 */
function notableEscalation(escalation: EscalationRecord | undefined): boolean {
  return escalation?.trigger === "rejected" || escalation?.trigger === "failed";
}

/**
 * One Guardian Review in the transcript: result, tool, scores, and rationale. Unless `verbose`
 * is on, a review that let its call run unremarkably renders nothing: an allowed or unused review
 * without a User Override or argument drift. Rejections, Review Failures, aborts, and User
 * Overrides always show.
 */
export function renderReviewEntry(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Journaled entry data is validated by the review schema below; anything else renders raw.
  data: unknown,
  expanded: boolean,
  theme: GuardianRenderTheme,
  verbose = false,
): Component | undefined {
  if (!Value.Check(reviewEntrySchema, data))
    return new Text(`Guardian Review\n${JSON.stringify(data, null, 2)}`, 0, 0);
  // Downgraded reviews and escalations that overturned a Rejection or followed a failed
  // classifier always show: they mean the First Pass was doubtful or missing.
  const quiet =
    (data.result === "allowed" || data.result === "unused") &&
    !data.userOverride &&
    !data.argumentDrift &&
    !data.downgraded &&
    !notableEscalation(data.escalation);
  if (quiet && !verbose) return undefined;
  const style = resultStyle[data.result];
  const scores =
    data.risk && data.authorization
      ? `risk ${riskLabel({ risk: data.risk, category: data.riskCategory })} · authorization ${data.authorization}`
      : undefined;
  const heading = [
    theme.fg(style.color, theme.bold(`${style.symbol} Guardian ${data.result}`)),
    theme.bold(data.toolName),
    scores ? theme.fg("muted", scores) : undefined,
    data.userOverride ? theme.fg("warning", "user override") : undefined,
    data.argumentDrift ? theme.fg("warning", "arguments changed after review") : undefined,
    data.downgraded ? theme.fg("muted", "decided as medium: no Risk Category") : undefined,
    data.escalation ? theme.fg("accent", escalationLabel(data.escalation)) : undefined,
  ]
    .filter((part) => part !== undefined)
    .join("  ");
  const reason = data.rationale ?? data.failure;
  const lines = [heading];
  if (reason) lines.push(expanded ? reason : preview(reason));
  if (expanded) {
    lines.push(theme.fg("dim", `arguments ${data.arguments}`));
    if (data.escalation) {
      const { escalation } = data;
      if (escalation.firstPass?.rationale)
        lines.push(theme.fg("dim", `first pass: ${escalation.firstPass.rationale}`));
      if (data.classification?.failure)
        lines.push(theme.fg("dim", `classifier: ${data.classification.failure}`));
      if (escalation.failure) lines.push(theme.fg("dim", `escalation: ${escalation.failure}`));
      lines.push(
        theme.fg(
          "dim",
          `escalation ${[
            escalation.model ?? "no model",
            `${(escalation.durationMs / 1_000).toFixed(1)}s`,
            escalation.cost === null ? "cost unknown" : formatMoney(escalation.cost),
          ].join(" \u00b7 ")}`,
        ),
      );
    }
    const meta = [
      data.model ?? undefined,
      `${(data.durationMs / 1_000).toFixed(1)}s`,
      data.usage ? `${data.usage.total} tokens` : undefined,
      data.cost === null ? "cost unknown" : formatMoney(data.cost),
      data.parentToolCallId ? `issued by ${data.parentToolCallId}` : undefined,
    ].filter((part) => part !== undefined);
    lines.push(theme.fg("dim", meta.join(" · ")));
  } else if (reason && reason !== preview(reason)) lines.push(expandHint(theme));
  return new Text(lines.join("\n"), 0, 0);
}

/** Escalations by trigger, such as ` (2 rejected, 1 uncertain)`; empty without a breakdown. */
function escalationBreakdown(by: Record<string, number> | undefined): string {
  const parts = Object.entries(by ?? {}).map(([trigger, count]) => `${count} ${trigger}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function badge(state: GuardianState, theme: GuardianRenderTheme): string {
  const style = stateBadge[state];
  return theme.fg(style.color, `${style.symbol} ${state}`);
}

/** State line, totals, and any error, as shown atop the settings menu and in status entries. */
export function guardianStatusHeadline(
  entry: GuardianStatusEntry,
  theme: GuardianRenderTheme,
): string[] {
  const parts = [`${theme.bold("Guardian")} ${badge(entry.state, theme)}`];
  const classifier = entry.settings ? configuredClassifier(entry.settings) : undefined;
  if (entry.settings && entry.state === "enabled")
    parts.push(
      classifier !== undefined
        ? `classifier ${classifier}${theme.fg("dim", ` (escalates at Rejection Probability ${entry.settings.escalationThreshold ?? guardianDefaults.escalationThreshold})`)}`
        : (entry.settings.model ??
            `session model${theme.fg("dim", " (inherited from the session; choose a small, fast model in /guardian)")}`),
    );
  if (entry.settings && entry.state === "enabled")
    parts.push(
      theme.fg(
        "dim",
        `escalates to ${entry.settings.escalationModel ?? (classifier === undefined ? "the Guardian model" : (entry.settings.model ?? "the session model"))} (${escalationThinkingLevel(entry.settings)} thinking)`,
      ),
    );
  if (entry.followsRoot) parts.push(theme.fg("dim", `follows root ${entry.followsRoot}`));
  const lines = [parts.join(theme.fg("dim", " · "))];
  const totals = entry.totals;
  if (totals?.reviews) {
    lines.push(
      theme.fg(
        "muted",
        [
          `${totals.reviews} ${totals.reviews === 1 ? "review" : "reviews"}`,
          `${totals.allowed} allowed`,
          `${totals.rejected} rejected`,
          `${totals.failed} failed`,
          totals.aborted ? `${totals.aborted} aborted` : undefined,
          `${totals.overrides} ${totals.overrides === 1 ? "override" : "overrides"}`,
          totals.escalated
            ? `${totals.escalated} escalated${escalationBreakdown(totals.escalatedBy)}`
            : undefined,
          totals.drift ? `${totals.drift} argument drift` : undefined,
          totals.cost === null ? "cost unknown" : `cost ${formatMoney(totals.cost)}`,
        ]
          .filter((part) => part !== undefined)
          .join(" · "),
      ),
    );
    if (totals.lastError) lines.push(theme.fg("warning", `last failure: ${totals.lastError}`));
  }
  if (entry.error) lines.push(theme.fg("error", `✖ ${entry.error}`));
  return lines;
}

/** Status snapshot: changes and headline, with every setting and its source when expanded. */
export function renderStatusEntry(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Journaled entry data is validated by the status schema below; anything else renders raw.
  data: unknown,
  expanded: boolean,
  theme: GuardianRenderTheme,
): Component {
  if (!Value.Check(statusEntrySchema, data))
    return new Text(`Guardian\n${JSON.stringify(data, null, 2)}`, 0, 0);
  const lines: string[] = [];
  for (const { scope, key, options } of data.changes ?? [])
    lines.push(
      `${theme.fg("success", "✓")} ${key} → ${formatGuardianOption(options, key)} ${theme.fg("dim", `[${scope}]`)}`,
    );
  lines.push(...guardianStatusHeadline(data, theme));
  const settings = data.settings;
  if (settings && expanded) {
    const width = Math.max(...guardianOptionKeys.map((key) => key.length));
    lines.push("");
    for (const key of guardianOptionKeys) {
      const source = data.sources?.[key] ?? "default";
      lines.push(
        `  ${key.padEnd(width)}  ${formatGuardianOption(settings, key)}  ${theme.fg(source === "default" ? "dim" : "accent", `[${source}]`)}`,
      );
    }
  } else if (settings) lines.push(expandHint(theme));
  return new Text(lines.join("\n"), 0, 0);
}

/** Compact footer status: idle, or the tools under review; `undefined` clears it. */
export function guardianFooterText(
  enabled: boolean,
  reviewing: readonly string[],
  theme: Pick<Theme, "fg">,
): string | undefined {
  if (!enabled) return undefined;
  if (!reviewing.length) return theme.fg("dim", "guardian");
  const tools = [...new Set(reviewing)];
  const extra = reviewing.length - 1;
  return theme.fg(
    "accent",
    `guardian: reviewing ${tools.length === 1 ? (tools[0] ?? "") : tools.join(", ")}${tools.length === 1 && extra ? ` ×${reviewing.length}` : ""}`,
  );
}
