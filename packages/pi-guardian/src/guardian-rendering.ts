import { keyHint, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { reviewEntrySchema, reviewTotalsSchema, type ReviewOutcome } from "./guardian-audit.js";
import {
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
const outcomeStyle = {
  allowed: { symbol: "✓", color: "success" },
  rejected: { symbol: "✖", color: "error" },
  failed: { symbol: "⚠", color: "warning" },
  aborted: { symbol: "○", color: "dim" },
  unused: { symbol: "○", color: "dim" },
} as const satisfies Record<ReviewOutcome, { symbol: string; color: ThemeColor }>;
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
    case "tools": {
      if (options.tools === undefined) return "inherit";
      const entries = Object.entries(options.tools);
      return entries.length
        ? entries.map(([name, policy]) => `${name}=${policy ?? "default"}`).join(", ")
        : "none";
    }
    case "safeCommands":
      if (options.safeCommands === undefined) return "inherit";
      return options.safeCommands.length ? options.safeCommands.join(", ") : "none";
    case "reviewTimeoutMs":
      if (options.reviewTimeoutMs === undefined) return "inherit";
      return options.reviewTimeoutMs < 1_000
        ? `${options.reviewTimeoutMs}ms`
        : `${options.reviewTimeoutMs / 1_000}s`;
    case "enabled":
      return options.enabled === undefined ? "inherit" : options.enabled ? "on" : "off";
    default: {
      const value = options[key];
      return value === undefined ? "inherit" : String(value);
    }
  }
}

/** One Guardian Review in the transcript: outcome, tool, scores, and rationale. */
export function renderReviewEntry(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Journaled entry data is validated by the review schema below; anything else renders raw.
  data: unknown,
  expanded: boolean,
  theme: GuardianRenderTheme,
): Component {
  if (!Value.Check(reviewEntrySchema, data))
    return new Text(`Guardian Review\n${JSON.stringify(data, null, 2)}`, 0, 0);
  const style = outcomeStyle[data.outcome];
  const scores =
    data.risk && data.authorization
      ? `risk ${data.risk} · authorization ${data.authorization}`
      : undefined;
  const heading = [
    theme.fg(style.color, theme.bold(`${style.symbol} Guardian ${data.outcome}`)),
    theme.bold(data.toolName),
    scores ? theme.fg("muted", scores) : undefined,
    data.userOverride ? theme.fg("warning", "user override") : undefined,
    data.argumentDrift ? theme.fg("warning", "arguments changed after review") : undefined,
  ]
    .filter((part) => part !== undefined)
    .join("  ");
  const reason = data.rationale ?? data.failure;
  const lines = [heading];
  if (reason) lines.push(expanded ? reason : preview(reason));
  if (expanded) {
    lines.push(theme.fg("dim", `arguments ${data.arguments}`));
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
  if (entry.settings && entry.state === "enabled")
    parts.push(entry.settings.model ?? `session model${theme.fg("dim", " (inherited)")}`);
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
