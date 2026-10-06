import {
  getMarkdownTheme,
  keyHint,
  type MessageRenderOptions,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Text, type Component } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  advisorFindingSchema,
  advisorReviewCostSchema,
  advisorSeveritySchema,
  advisorStateSchema,
  type AdvisorReviewCost,
  type AdvisorSeverity,
  type AdvisorState,
} from "./advisor-contract.js";
import {
  advisorAppliedChangeSchema,
  advisorOptionKeys,
  advisorOptionsSchema,
  advisorSettingSourceSchema,
  type AdvisorOptions,
} from "./advisor-settings.js";

/** Theme operations used by Advisor transcript and footer renderers. */
export type AdvisorRenderTheme = Pick<Theme, "fg" | "bg" | "bold">;

const severityStyle = {
  nit: { symbol: "·", color: "muted" },
  concern: { symbol: "▲", color: "warning" },
  blocker: { symbol: "✖", color: "error" },
} as const satisfies Record<AdvisorSeverity, { symbol: string; color: ThemeColor }>;
const collapsedNitLines = 4;

const nullableString = Type.Union([Type.String(), Type.Null()]);
/** The minimum every historical status entry recorded. */
const minimalStatusSchema = Type.Object({
  state: advisorStateSchema,
  error: Type.Optional(nullableString),
});
const statusSchema = Type.Object({
  state: advisorStateSchema,
  changes: Type.Optional(Type.Array(advisorAppliedChangeSchema)),
  settings: Type.Optional(advisorOptionsSchema),
  sources: Type.Optional(Type.Record(Type.String(), advisorSettingSourceSchema)),
  backlog: Type.Optional(Type.Number()),
  effectiveModel: Type.Optional(nullableString),
  effectiveThinkingLevel: Type.Optional(nullableString),
  usage: Type.Optional(Type.Union([Type.Object({ total: Type.Number() }), Type.Null()])),
  cost: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  reviewCost: Type.Optional(Type.Union([advisorReviewCostSchema, Type.Null()])),
  unavailableTools: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  children: Type.Optional(
    Type.Array(
      Type.Object({
        agentId: Type.String(),
        state: Type.Optional(advisorStateSchema),
        backlog: Type.Optional(Type.Number()),
        reviewCost: Type.Optional(Type.Union([advisorReviewCostSchema, Type.Null()])),
      }),
    ),
  ),
  error: Type.Optional(nullableString),
  lastError: Type.Optional(nullableString),
});
/** Data recorded in a `pi-advisor-status` entry. */
export type AdvisorStatusEntry = Static<typeof statusSchema>;
const stateBadge = {
  disabled: { symbol: "○", color: "dim" },
  private: { symbol: "○", color: "dim" },
  armed: { symbol: "●", color: "success" },
  reviewing: { symbol: "●", color: "accent" },
  consulting: { symbol: "●", color: "accent" },
  paused: { symbol: "●", color: "error" },
} as const satisfies Record<AdvisorState, { symbol: string; color: ThemeColor }>;
const promptPreviewWidth = 40;

function expandHint(theme: Pick<Theme, "fg">): string {
  return theme.fg("dim", `… ${keyHint("app.tools.expand", "to expand")}`);
}

/** Render at most `limit` lines of a child, then an expansion hint. */
class Clipped implements Component {
  constructor(
    private readonly child: Component,
    private readonly limit: number,
    private readonly hint: string,
  ) {}
  render(width: number): string[] {
    const lines = this.child.render(width);
    return lines.length <= this.limit ? lines : [...lines.slice(0, this.limit), this.hint];
  }
  invalidate(): void {
    this.child.invalidate();
  }
}

/** Severity-styled, attributed Intervention; invalid details fall back to Pi's renderer. */
export function renderAdvisorIntervention(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Journaled custom-message details are validated by the finding schema below.
  details: unknown,
  options: MessageRenderOptions,
  theme: AdvisorRenderTheme,
  agentId?: string,
): Component | undefined {
  if (!Value.Check(advisorFindingSchema, details)) return undefined;
  const style = severityStyle[details.severity];
  const heading = joinDefined(
    [
      theme.fg(style.color, theme.bold(`${style.symbol} Advisor ${details.severity}`)),
      agentId ? theme.fg("accent", `↳ ${agentId}`) : undefined,
    ],
    "  ",
  );
  const body: Component = new Markdown(details.message, 0, 0, getMarkdownTheme());
  const container = new Container();
  container.addChild(new Text(heading, 0, 0));
  container.addChild(
    details.severity === "nit" && !options.expanded
      ? new Clipped(body, collapsedNitLines, expandHint(theme))
      : body,
  );
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(container);
  return box;
}

const childFindingSchema = Type.Object({
  agentId: Type.String(),
  severity: advisorSeveritySchema,
  message: Type.String(),
});
const childStateSchema = Type.Object({
  agentId: Type.String(),
  state: advisorStateSchema,
  error: Type.Optional(Type.String()),
});

/** A Child Agent's Intervention or pause, attributed to that child. */
export function renderAdvisorChildEntry(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Journaled entry data is validated below; anything else renders raw.
  data: unknown,
  expanded: boolean,
  theme: AdvisorRenderTheme,
): Component {
  if (Value.Check(childFindingSchema, data)) {
    const finding = { severity: data.severity, message: data.message };
    const rendered = renderAdvisorIntervention(
      finding,
      { expanded, outputPad: 0 },
      theme,
      data.agentId,
    );
    if (rendered) return rendered;
  }
  if (Value.Check(childStateSchema, data)) {
    const line = `Advisor ↳ ${data.agentId} ${data.state}${data.error ? `: ${data.error}` : ""}`;
    return new Text(data.error ? theme.fg("error", `✖ ${line}`) : theme.fg("dim", line), 0, 0);
  }
  return new Text(`Advisor for Child Agent\n${JSON.stringify(data, null, 2)}`, 0, 0);
}

const collapsedAnswerLines = 8;

/** `advisor_ask` call: the question, first line only while collapsed. */
export function renderAdvisorAskCall(
  args: { message: string },
  expanded: boolean,
  theme: AdvisorRenderTheme,
): Component {
  const question = expanded ? args.message : (args.message.split("\n", 1)[0] ?? "");
  return new Text(`${theme.fg("toolTitle", theme.bold("Ask Advisor"))} ${question}`, 0, 0);
}

/** `advisor_ask` result: a Markdown answer, previewed while collapsed. */
export function renderAdvisorAskResult(
  answer: string,
  options: { expanded: boolean; isPartial: boolean; isError: boolean },
  theme: AdvisorRenderTheme,
): Component {
  if (options.isPartial) return new Text(theme.fg("dim", "Consulting…"), 0, 0);
  if (options.isError) return new Text(theme.fg("error", answer), 0, 0);
  const body = new Markdown(answer, 0, 0, getMarkdownTheme());
  return options.expanded ? body : new Clipped(body, collapsedAnswerLines, expandHint(theme));
}

function formatTokens(total: number): string {
  if (total < 1_000) return String(total);
  if (total < 1_000_000) return `${(total / 1_000).toFixed(1)}k`;
  return `${(total / 1_000_000).toFixed(1)}M`;
}

function formatMoney(cost: number): string {
  return `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
}

function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return "cost unknown";
  return `cost ${formatMoney(cost)}`;
}

/** Running Review total, then the last Review alone; unknown stays unknown. */
function formatReviewCost({ reviews, last, total }: AdvisorReviewCost) {
  const amount = (cost: number | null) => (cost === null ? "cost unknown" : formatMoney(cost));
  return `${reviews} ${reviews === 1 ? "Review" : "Reviews"} ${amount(total)} · last Review ${amount(last)}`;
}

/** Human-readable option value; an absent value inherits. */
export function formatAdvisorOption(options: AdvisorOptions, key: keyof AdvisorOptions): string {
  switch (key) {
    case "prompt": {
      if (options.prompt === undefined) return "inherit";
      const first = options.prompt.split("\n", 1)[0] ?? "";
      const preview =
        first.length > promptPreviewWidth ? `${first.slice(0, promptPreviewWidth - 1)}…` : first;
      return `${preview} (${options.prompt.length} chars)`;
    }
    case "allowedTools":
      if (options.allowedTools === undefined) return "inherit";
      return options.allowedTools.length ? options.allowedTools.join(", ") : "none";
    case "reviewTimeoutMs":
      if (options.reviewTimeoutMs === undefined) return "inherit";
      return options.reviewTimeoutMs < 1_000
        ? `${options.reviewTimeoutMs}ms`
        : `${options.reviewTimeoutMs / 1_000}s`;
    default: {
      const value = options[key];
      return value === undefined ? "inherit" : String(value);
    }
  }
}

function badge(state: AdvisorState, theme: AdvisorRenderTheme): string {
  const style = stateBadge[state];
  return theme.fg(style.color, `${style.symbol} ${state}`);
}

function joinDefined(parts: ReadonlyArray<string | undefined>, separator: string): string {
  return parts.filter((part) => part !== undefined).join(separator);
}

function stateLine(entry: AdvisorStatusEntry, theme: AdvisorRenderTheme): string {
  const inherited = entry.settings && entry.settings.model === undefined;
  return joinDefined(
    [
      `${theme.bold("Advisor")} ${badge(entry.state, theme)}`,
      entry.effectiveModel
        ? `${entry.effectiveModel}${inherited ? theme.fg("dim", " (inherited)") : ""}`
        : undefined,
      entry.effectiveThinkingLevel ?? undefined,
      entry.backlog ? `backlog ${entry.backlog}` : undefined,
    ],
    theme.fg("dim", " · "),
  );
}

/** Live state line plus any error, as shown at the top of the settings menu. */
export function advisorStatusHeadline(
  entry: AdvisorStatusEntry,
  theme: AdvisorRenderTheme,
): string[] {
  const error = entry.error ?? entry.lastError;
  return [stateLine(entry, theme), ...(error ? [theme.fg("error", `✖ ${error}`)] : [])];
}

function summaryLines(entry: AdvisorStatusEntry, theme: AdvisorRenderTheme): string[] {
  const lines: string[] = [];
  for (const { scope, key, options } of entry.changes ?? []) {
    lines.push(
      `${theme.fg("success", "✓")} ${key} → ${formatAdvisorOption(options, key)} ${theme.fg("dim", `[${scope}]`)}`,
    );
  }
  lines.push(stateLine(entry, theme));
  const children = entry.children?.length ?? 0;
  const activity = joinDefined(
    [
      entry.usage ? `tokens ${formatTokens(entry.usage.total)}` : undefined,
      entry.usage ? formatCost(entry.cost) : undefined,
      entry.reviewCost?.reviews ? formatReviewCost(entry.reviewCost) : undefined,
      children ? `${children} ${children === 1 ? "child" : "children"}` : undefined,
    ],
    " · ",
  );
  if (activity) lines.push(theme.fg("muted", activity));
  if (entry.unavailableTools?.length)
    lines.push(theme.fg("warning", `⚠ unavailable tools: ${entry.unavailableTools.join(", ")}`));
  const error = entry.error ?? entry.lastError;
  if (error) lines.push(theme.fg("error", `✖ ${error}`));
  return lines;
}

function detailLines(entry: AdvisorStatusEntry, theme: AdvisorRenderTheme): string[] {
  const lines: string[] = [];
  if (entry.settings) {
    const settings = entry.settings;
    const width = Math.max(...advisorOptionKeys.map((key) => key.length));
    lines.push("");
    for (const key of advisorOptionKeys) {
      const source = entry.sources?.[key] ?? "default";
      lines.push(
        `  ${key.padEnd(width)}  ${formatAdvisorOption(settings, key)}  ${theme.fg(source === "default" ? "dim" : "accent", `[${source}]`)}`,
      );
    }
  }
  if (entry.children?.length) lines.push("");
  for (const child of entry.children ?? [])
    lines.push(
      joinDefined(
        [
          `  ${theme.fg("accent", `↳ ${child.agentId}`)}`,
          child.state ? badge(child.state, theme) : undefined,
          child.backlog ? `backlog ${child.backlog}` : undefined,
          child.reviewCost?.reviews ? formatReviewCost(child.reviewCost) : undefined,
        ],
        "  ",
      ),
    );
  return lines;
}

/** Drop top-level fields that no longer match, so older entries keep what they can show. */
function salvageStatus(data: Static<typeof minimalStatusSchema>): AdvisorStatusEntry {
  // Runtime copy keeps every recorded field; only mismatching ones are removed below.
  const candidate = structuredClone(data);
  for (const issue of Value.Errors(statusSchema, candidate)) {
    const field = issue.instancePath.split("/")[1];
    if (field && field !== "state") Reflect.deleteProperty(candidate, field);
  }
  return Value.Check(statusSchema, candidate)
    ? candidate
    : { state: data.state, error: data.error ?? null };
}

/** Status snapshot: a compact summary, with every setting and child when expanded. */
export function renderAdvisorStatus(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Journaled entry data is validated below; older shapes keep their state and error, anything else renders raw.
  data: unknown,
  expanded: boolean,
  theme: AdvisorRenderTheme,
): Component {
  if (!Value.Check(minimalStatusSchema, data))
    return new Text(`Advisor\n${JSON.stringify(data, null, 2)}`, 0, 0);
  const entry = salvageStatus(data);
  const lines = summaryLines(entry, theme);
  const details = detailLines(entry, theme);
  if (expanded) lines.push(...details);
  else if (details.length) lines.push(expandHint(theme));
  return new Text(lines.join("\n"), 0, 0);
}

/** The live fields the footer summarizes for one watched agent. */
export interface AdvisorActivity {
  state: AdvisorState;
  backlog: number;
}

function count(amount: number, what: string): string {
  return `${amount} ${amount === 1 ? "child" : "children"} ${what}`;
}

/** Compact footer status; `undefined` clears it. Pause reasons stay in `/advisor status`. */
export function advisorFooterText(
  root: AdvisorActivity | undefined,
  children: readonly AdvisorActivity[],
  theme: Pick<Theme, "fg">,
): string | undefined {
  if (!root || root.state === "disabled" || root.state === "private") return undefined;
  if (root.state === "paused") return theme.fg("error", "advisor: paused");
  const parts: string[] = [];
  if (root.state === "reviewing" || root.state === "consulting") {
    parts.push(root.state);
    if (root.backlog > 0) parts.push(`backlog ${root.backlog}`);
  }
  // Consultations come only from the main agent, so a child segment shows Reviews and pauses.
  const busy = children.filter((child) => child.state === "reviewing").length;
  const paused = children.filter((child) => child.state === "paused").length;
  if (busy) parts.push(count(busy, "reviewing"));
  if (paused) parts.push(theme.fg("error", count(paused, "paused")));
  if (!parts.length) return theme.fg("dim", "advisor");
  return theme.fg("accent", `advisor: ${parts.join(" · ")}`);
}
