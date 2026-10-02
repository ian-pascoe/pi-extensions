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
  advisorOptionKey,
  advisorOptionKeys,
  advisorOptionsSchema,
  type AdvisorOptions,
} from "./advisor-settings.js";

/** Theme operations used by Advisor transcript and footer renderers. */
export type AdvisorRenderTheme = Pick<Theme, "fg" | "bg" | "bold">;

const severitySchema = Type.Union([
  Type.Literal("nit"),
  Type.Literal("concern"),
  Type.Literal("blocker"),
]);
const findingSchema = Type.Object({ severity: severitySchema, message: Type.String() });
const severityStyle = {
  nit: { symbol: "·", color: "muted" },
  concern: { symbol: "▲", color: "warning" },
  blocker: { symbol: "✖", color: "error" },
} as const satisfies Record<Static<typeof severitySchema>, { symbol: string; color: ThemeColor }>;
const collapsedNitLines = 4;

const stateSchema = Type.Union([
  Type.Literal("disabled"),
  Type.Literal("armed"),
  Type.Literal("reviewing"),
  Type.Literal("consulting"),
  Type.Literal("paused"),
  Type.Literal("private"),
]);
/** Advisor state shown in status entries and the footer. */
export type AdvisorState = Static<typeof stateSchema>;
const nullableString = Type.Union([Type.String(), Type.Null()]);
const sourceSchema = Type.Union([
  Type.Literal("default"),
  Type.Literal("global"),
  Type.Literal("project"),
  Type.Literal("session"),
]);
/** The minimum every historical status entry recorded. */
const minimalStatusSchema = Type.Object({
  state: stateSchema,
  error: Type.Optional(nullableString),
});
const statusSchema = Type.Object({
  state: stateSchema,
  change: Type.Optional(
    Type.Object({
      scope: Type.Union([Type.Literal("session"), Type.Literal("global"), Type.Literal("project")]),
      key: Type.KeyOf(advisorOptionsSchema),
      options: advisorOptionsSchema,
    }),
  ),
  settings: Type.Optional(advisorOptionsSchema),
  sources: Type.Optional(Type.Record(Type.String(), sourceSchema)),
  backlog: Type.Optional(Type.Number()),
  effectiveModel: Type.Optional(nullableString),
  effectiveThinkingLevel: Type.Optional(nullableString),
  usage: Type.Optional(Type.Union([Type.Object({ total: Type.Number() }), Type.Null()])),
  cost: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  unavailableTools: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  children: Type.Optional(
    Type.Array(
      Type.Object({
        agentId: Type.String(),
        state: Type.Optional(stateSchema),
        backlog: Type.Optional(Type.Number()),
      }),
    ),
  ),
  error: Type.Optional(nullableString),
  lastError: Type.Optional(nullableString),
});
type StatusEntry = Static<typeof statusSchema>;
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
  if (!Value.Check(findingSchema, details)) return undefined;
  const style = severityStyle[details.severity];
  const heading = [
    theme.fg(style.color, theme.bold(`${style.symbol} Advisor ${details.severity}`)),
    agentId ? theme.fg("accent", `↳ ${agentId}`) : undefined,
  ]
    .filter((part) => part !== undefined)
    .join("  ");
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
  severity: severitySchema,
  message: Type.String(),
});
const childPauseSchema = Type.Object({
  agentId: Type.String(),
  state: Type.Literal("paused"),
  error: Type.String(),
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
  if (Value.Check(childPauseSchema, data))
    return new Text(theme.fg("error", `✖ Advisor ↳ ${data.agentId} paused: ${data.error}`), 0, 0);
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

function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return "cost unknown";
  return `cost $${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
}

/** Human-readable option value; an absent value inherits. */
function formatOption(options: AdvisorOptions, key: keyof AdvisorOptions): string {
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

function summaryLines(entry: StatusEntry, theme: AdvisorRenderTheme): string[] {
  const lines: string[] = [];
  if (entry.change) {
    const { scope, key, options } = entry.change;
    lines.push(
      `${theme.fg("success", "✓")} ${key} → ${formatOption(options, key)} ${theme.fg("dim", `[${scope}]`)}`,
    );
  }
  const inherited = entry.settings && entry.settings.model === undefined;
  lines.push(
    joinDefined(
      [
        `${theme.bold("Advisor")} ${badge(entry.state, theme)}`,
        entry.effectiveModel
          ? `${entry.effectiveModel}${inherited ? theme.fg("dim", " (inherited)") : ""}`
          : undefined,
        entry.effectiveThinkingLevel ?? undefined,
        entry.backlog ? `backlog ${entry.backlog}` : undefined,
      ],
      theme.fg("dim", " · "),
    ),
  );
  const children = entry.children?.length ?? 0;
  const activity = joinDefined(
    [
      entry.usage ? `tokens ${formatTokens(entry.usage.total)}` : undefined,
      entry.usage ? formatCost(entry.cost) : undefined,
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

function detailLines(entry: StatusEntry, theme: AdvisorRenderTheme): string[] {
  const lines: string[] = [];
  if (entry.settings) {
    const settings = entry.settings;
    const keys = advisorOptionKeys.map(advisorOptionKey);
    const width = Math.max(...keys.map((key) => key.length));
    lines.push("");
    for (const key of keys) {
      const source = entry.sources?.[key] ?? "default";
      lines.push(
        `  ${key.padEnd(width)}  ${formatOption(settings, key)}  ${theme.fg(source === "default" ? "dim" : "accent", `[${source}]`)}`,
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
        ],
        "  ",
      ),
    );
  return lines;
}

/** Status snapshot: a compact summary, with every setting and child when expanded. */
export function renderAdvisorStatus(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Journaled entry data is validated below; older shapes keep their state and error, anything else renders raw.
  data: unknown,
  expanded: boolean,
  theme: AdvisorRenderTheme,
): Component {
  const entry: StatusEntry | undefined = Value.Check(statusSchema, data)
    ? data
    : Value.Check(minimalStatusSchema, data)
      ? { state: data.state, error: data.error ?? null }
      : undefined;
  if (!entry) return new Text(`Advisor\n${JSON.stringify(data, null, 2)}`, 0, 0);
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
  if (root.state === "reviewing" || root.state === "consulting") parts.push(root.state);
  if (root.backlog > 0) parts.push(`backlog ${root.backlog}`);
  const busy = children.filter(
    (child) => child.state === "reviewing" || child.state === "consulting",
  ).length;
  const paused = children.filter((child) => child.state === "paused").length;
  if (busy) parts.push(count(busy, "reviewing"));
  if (paused) parts.push(theme.fg("error", count(paused, "paused")));
  if (!parts.length) return theme.fg("dim", "advisor");
  return theme.fg("accent", `advisor: ${parts.join(" · ")}`);
}
