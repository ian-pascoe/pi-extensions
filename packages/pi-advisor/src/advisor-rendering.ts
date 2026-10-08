import {
  getMarkdownTheme,
  type MessageRenderOptions,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import {
  callDurationFooter,
  COLLAPSED_LINES,
  appendDurationFooter,
  CollapsedPreview,
  customMessageBox,
  footerStatus,
  joinInline,
  previewBody,
  statusMark,
  summaryExpandHint,
  toolHeader,
  treePrefix,
  type DurationContext,
  type StatusKind,
} from "@ian-pascoe/pi-utils/ui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  advisorFindingSchema,
  advisorDroppedFindingsSchema,
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

/** The registered name of the consultation tool. */
export const advisorAskToolName = "advisor_ask";

/** Severity Labels: a coloured word, never a Status Mark. */
const severityColor = {
  nit: "dim",
  concern: "warning",
  blocker: "error",
} as const satisfies Record<AdvisorSeverity, ThemeColor>;

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
  deferredFindings: Type.Optional(Type.Number()),
  droppedFindings: Type.Optional(
    // Entries recorded before a reason existed omit its count.
    Type.Partial(advisorDroppedFindingsSchema),
  ),
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
const stateMarkKind = {
  disabled: "idle",
  private: "idle",
  armed: "active",
  reviewing: "active",
  consulting: "active",
  paused: "warning",
} as const satisfies Record<AdvisorState, StatusKind>;
const promptPreviewWidth = 40;

/** Styles a plain piece of text; messages use `customMessageText`, menus leave it as is. */
type Paint = (text: string) => string;
const unpainted: Paint = (text) => text;
const messagePaint =
  (theme: Pick<Theme, "fg">): Paint =>
  (text) =>
    theme.fg("customMessageText", text);

const messageLabel = (theme: Pick<Theme, "fg" | "bold">) =>
  theme.fg("customMessageLabel", theme.bold("Advisor"));

/** Severity-labelled, attributed Intervention; invalid details fall back to Pi's renderer. */
export function renderAdvisorIntervention(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Journaled custom-message details are validated by the finding schema below.
  details: unknown,
  options: MessageRenderOptions,
  theme: AdvisorRenderTheme,
  agentId?: string,
): Component | undefined {
  if (!Value.Check(advisorFindingSchema, details)) return undefined;
  const heading = joinInline(theme, [
    `${messageLabel(theme)} ${theme.fg(severityColor[details.severity], details.severity)}`,
    agentId ? theme.fg("accent", agentId) : undefined,
  ]);
  const body = new Markdown(details.message, 0, 0, getMarkdownTheme(), {
    color: messagePaint(theme),
  });
  // The heading carries the Severity Label beside Pi's label, so it is not the box's own label.
  return customMessageBox(theme, { outputPad: options.outputPad }, [
    new Text(heading, 0, 0),
    new Spacer(1),
    details.severity === "nit"
      ? new CollapsedPreview(theme, body, {
          limit: COLLAPSED_LINES.fallback,
          expanded: options.expanded,
        })
      : body,
  ]);
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

/** Pi's entry renderers get no `outputPad`, so entries use Pi's default of one column. */
const entryOutputPad = 1;

/** A Child Agent's Intervention or pause, attributed to that child. */
export function renderAdvisorChildEntry(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Journaled entry data is validated below; anything else renders raw.
  data: unknown,
  expanded: boolean,
  theme: AdvisorRenderTheme,
  outputPad = entryOutputPad,
): Component {
  if (Value.Check(childFindingSchema, data)) {
    const finding = { severity: data.severity, message: data.message };
    const rendered = renderAdvisorIntervention(
      finding,
      { expanded, outputPad },
      theme,
      data.agentId,
    );
    if (rendered) return rendered;
  }
  if (Value.Check(childStateSchema, data)) {
    const heading = joinInline(theme, [
      messageLabel(theme),
      theme.fg("accent", data.agentId),
      badge(data.state, theme, messagePaint(theme)),
    ]);
    return customMessageBox(theme, { outputPad }, [
      new Text(heading, 0, 0),
      ...(data.error ? [new Text(theme.fg("error", data.error), 0, 0)] : []),
    ]);
  }
  return new Text(`Advisor for Child Agent\n${JSON.stringify(data, null, 2)}`, 0, 0);
}

/** `advisor_ask` call: the question, first line only while collapsed. */
export function renderAdvisorAskCall(
  args: { message: string },
  expanded: boolean,
  theme: AdvisorRenderTheme,
  context: DurationContext,
): Component {
  const [first = "", ...rest] = args.message.split("\n");
  const hidden = rest.length > 0 && !expanded;
  const heading = toolHeader(theme, advisorAskToolName, expanded ? undefined : first);
  const container = new Container();
  container.addChild(new Text(hidden ? `${heading}${summaryExpandHint(theme)}` : heading, 0, 0));
  if (expanded) container.addChild(new Text(theme.fg("muted", `message: ${args.message}`), 0, 0));
  container.addChild(callDurationFooter(theme, context));
  return container;
}

/** `advisor_ask` result: a Markdown answer, previewed while collapsed, then Pi's duration footer. */
export function renderAdvisorAskResult(
  answer: string,
  options: { expanded: boolean; isPartial: boolean; isError: boolean },
  theme: AdvisorRenderTheme,
  context: DurationContext,
): Component {
  const container = new Container();
  if (answer) {
    container.addChild(new Spacer(1));
    if (options.isError) {
      const lines = previewBody(theme, answer.split("\n"), {
        limit: COLLAPSED_LINES.fallback,
        expanded: options.expanded,
        color: "error",
      });
      container.addChild(new Text(lines.join("\n"), 0, 0));
    } else {
      const body = new Markdown(answer, 0, 0, getMarkdownTheme(), {
        color: (text) => theme.fg("toolOutput", text),
      });
      container.addChild(
        new CollapsedPreview(theme, body, {
          limit: COLLAPSED_LINES.fallback,
          expanded: options.expanded,
        }),
      );
    }
  }
  appendDurationFooter(container, theme, context, { isPartial: options.isPartial });
  return container;
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

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Findings withheld for re-validation and findings dropped, when there are any. */
function findingCounts(entry: AdvisorStatusEntry): string[] {
  const { deferredFindings: deferred, droppedFindings: dropped } = entry;
  return [
    deferred ? `${plural(deferred, "finding", "findings")} awaiting re-validation` : "",
    dropped?.overNitCap
      ? `${plural(dropped.overNitCap, "Nit", "Nits")} over the request cap dropped`
      : "",
    dropped?.unsupported
      ? `${plural(dropped.unsupported, "finding", "findings")} without valid evidence dropped`
      : "",
    dropped?.superseded
      ? `${plural(dropped.superseded, "Nit", "Nits")} from a superseded re-validating Review dropped`
      : "",
    dropped?.invalidReviews
      ? `${plural(dropped.invalidReviews, "Review", "Reviews")} ended by invalid reports`
      : "",
  ].filter(Boolean);
}

/** Human-readable option value; an absent value inherits. */
export function formatAdvisorOption(options: AdvisorOptions, key: keyof AdvisorOptions): string {
  switch (key) {
    case "prompt": {
      if (options.prompt === undefined) return "inherit";
      const first = options.prompt.split("\n", 1)[0] ?? "";
      const preview =
        first.length > promptPreviewWidth ? `${first.slice(0, promptPreviewWidth - 3)}...` : first;
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

/** The word shown for a state. Guardian says `on` when idle, so an armed Advisor does too; `armed` stays the stored state. */
function stateWord(state: AdvisorState): string {
  return state === "armed" ? "on" : state;
}

function badge(state: AdvisorState, theme: AdvisorRenderTheme, paint: Paint): string {
  return `${statusMark(theme, stateMarkKind[state])} ${paint(stateWord(state))}`;
}

function joinDefined(parts: ReadonlyArray<string | undefined>, separator: string): string {
  return parts.filter((part) => part !== undefined).join(separator);
}

function stateLine(
  entry: AdvisorStatusEntry,
  theme: AdvisorRenderTheme,
  label: string,
  paint: Paint,
): string {
  const inherited = entry.settings && entry.settings.model === undefined;
  return joinInline(theme, [
    `${label} ${badge(entry.state, theme, paint)}`,
    entry.effectiveModel
      ? `${paint(entry.effectiveModel)}${inherited ? theme.fg("dim", " (inherited)") : ""}`
      : undefined,
    entry.effectiveThinkingLevel ? paint(entry.effectiveThinkingLevel) : undefined,
    entry.backlog ? paint(`backlog ${entry.backlog}`) : undefined,
  ]);
}

function errorLine(theme: AdvisorRenderTheme, error: string): string {
  return `${statusMark(theme, "failed")} ${theme.fg("error", error)}`;
}

/** Live state line plus any error, as shown at the top of the settings menu. */
export function advisorStatusHeadline(
  entry: AdvisorStatusEntry,
  theme: AdvisorRenderTheme,
): string[] {
  const error = entry.error ?? entry.lastError;
  return [
    stateLine(entry, theme, theme.bold("Advisor"), unpainted),
    ...(error ? [errorLine(theme, error)] : []),
  ];
}

function summaryLines(entry: AdvisorStatusEntry, theme: AdvisorRenderTheme): string[] {
  const paint = messagePaint(theme);
  const lines: string[] = [stateLine(entry, theme, messageLabel(theme), paint)];
  for (const { scope, key, options } of entry.changes ?? []) {
    lines.push(
      `${statusMark(theme, "done")} ${paint(`${key} → ${formatAdvisorOption(options, key)}`)} ${theme.fg("dim", `[${scope}]`)}`,
    );
  }
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
  const counts = findingCounts(entry);
  if (counts.length) lines.push(theme.fg("muted", counts.join(" · ")));
  if (entry.unavailableTools?.length)
    lines.push(
      `${statusMark(theme, "warning")} ${theme.fg("warning", `unavailable tools: ${entry.unavailableTools.join(", ")}`)}`,
    );
  const error = entry.error ?? entry.lastError;
  if (error) lines.push(errorLine(theme, error));
  return lines;
}

function detailLines(entry: AdvisorStatusEntry, theme: AdvisorRenderTheme): string[] {
  const paint = messagePaint(theme);
  const lines: string[] = [];
  if (entry.settings) {
    const settings = entry.settings;
    const width = Math.max(...advisorOptionKeys.map((key) => key.length));
    lines.push("");
    for (const key of advisorOptionKeys) {
      const source = entry.sources?.[key] ?? "default";
      lines.push(
        `  ${paint(key.padEnd(width))}  ${paint(formatAdvisorOption(settings, key))}  ${theme.fg(source === "default" ? "dim" : "accent", `[${source}]`)}`,
      );
    }
  }
  const children = entry.children ?? [];
  if (children.length) lines.push("");
  for (const [index, child] of children.entries())
    lines.push(
      `${theme.fg("dim", treePrefix([], index === children.length - 1))}${joinDefined(
        [
          theme.fg("accent", child.agentId),
          child.state ? badge(child.state, theme, paint) : undefined,
          child.backlog ? paint(`backlog ${child.backlog}`) : undefined,
          child.reviewCost?.reviews ? paint(formatReviewCost(child.reviewCost)) : undefined,
        ],
        "  ",
      )}`,
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

/**
 * Status snapshot in Pi's custom-message look: a ten-line summary, with every setting and child
 * when expanded.
 */
export function renderAdvisorStatus(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Journaled entry data is validated below; older shapes keep their state and error, anything else renders raw.
  data: unknown,
  expanded: boolean,
  theme: AdvisorRenderTheme,
  outputPad = entryOutputPad,
): Component {
  if (!Value.Check(minimalStatusSchema, data))
    return customMessageBox(theme, { outputPad, label: "Advisor" }, [
      new Text(JSON.stringify(data, null, 2), 0, 0),
    ]);
  const entry = salvageStatus(data);
  const summary = summaryLines(entry, theme);
  const details = detailLines(entry, theme);
  const body = new Text([...summary, ...details].join("\n"), 0, 0);
  return customMessageBox(theme, { outputPad }, [
    new CollapsedPreview(theme, body, { limit: COLLAPSED_LINES.fallback, expanded }),
  ]);
}

/** The live fields the footer summarizes for one watched agent. */
export interface AdvisorActivity {
  state: AdvisorState;
  backlog: number;
}

function count(amount: number, what: string): string {
  return `${amount} ${amount === 1 ? "child" : "children"} ${what}`;
}

/** Footer status entry; `undefined` clears it. Pause reasons stay in `/advisor status`. */
export function advisorFooterText(
  root: AdvisorActivity | undefined,
  children: readonly AdvisorActivity[],
  theme: Pick<Theme, "fg">,
): string | undefined {
  if (!root || root.state === "disabled" || root.state === "private") return undefined;
  if (root.state === "paused")
    return footerStatus(theme, {
      mark: "warning",
      name: "advisor",
      value: theme.fg("warning", "paused"),
    });
  const parts: string[] = [stateWord(root.state)];
  if ((root.state === "reviewing" || root.state === "consulting") && root.backlog > 0)
    parts.push(`backlog ${root.backlog}`);
  // Consultations come only from the main agent, so a child segment shows Reviews and pauses.
  const busy = children.filter((child) => child.state === "reviewing").length;
  const paused = children.filter((child) => child.state === "paused").length;
  if (busy) parts.push(count(busy, "reviewing"));
  if (paused) parts.push(theme.fg("warning", count(paused, "paused")));
  return footerStatus(theme, { mark: "active", name: "advisor", value: joinInline(theme, parts) });
}
