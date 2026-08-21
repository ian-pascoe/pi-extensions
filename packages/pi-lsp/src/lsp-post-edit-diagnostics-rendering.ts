import { relative } from "node:path";
import { keyText, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  PostEditDiagnosticOutcomeSchema,
  type PostEditDiagnosticOutcome,
} from "./lsp-post-edit-diagnostics.js";

/** Custom session entry type used for model-invisible Post-edit Diagnostics presentation. */
export const POST_EDIT_DIAGNOSTICS_ENTRY_TYPE = "pi-lsp-post-edit-diagnostics";

/** Persisted data for one model-invisible Post-edit Diagnostics Entry. */
export const PostEditDiagnosticsEntryDataSchema = Type.Object(
  {
    cwd: Type.String({ minLength: 1 }),
    outcomes: Type.Array(PostEditDiagnosticOutcomeSchema),
  },
  { additionalProperties: false },
);

/** Validated data rendered by one model-invisible Post-edit Diagnostics Entry. */
export type PostEditDiagnosticsEntryData = Static<typeof PostEditDiagnosticsEntryDataSchema>;

/** Theme operations used by Post-edit Diagnostics Entry rendering. */
export type PostEditDiagnosticsEntryTheme = Pick<Theme, "bg" | "bold" | "fg">;

type ReportablePostEditDiagnosticOutcome = Exclude<
  PostEditDiagnosticOutcome,
  { kind: "no_diagnostics" | "no_configured_server" }
>;

type DiagnosticSeverity = "error" | "warning" | "information" | "hint" | "diagnostic";

function isReportablePostEditDiagnosticOutcome(
  outcome: PostEditDiagnosticOutcome,
): outcome is ReportablePostEditDiagnosticOutcome {
  return outcome.kind !== "no_diagnostics" && outcome.kind !== "no_configured_server";
}

function diagnosticSeverity(severity: number): DiagnosticSeverity {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "information";
    case 4:
      return "hint";
    default:
      return "diagnostic";
  }
}

function severityColor(severity: DiagnosticSeverity): ThemeColor {
  switch (severity) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "information":
      return "accent";
    case "hint":
    case "diagnostic":
      return "muted";
  }
}

/** Render one count with a pluralized noun, e.g. `3 files` or `1 file`. */
export function pluralizedCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function entrySummary(data: PostEditDiagnosticsEntryData, theme: PostEditDiagnosticsEntryTheme) {
  const counts = new Map<DiagnosticSeverity, number>();
  const files = new Set<string>();
  let adapterWarnings = 0;
  let timeouts = 0;
  let serverIssues = 0;
  for (const outcome of data.outcomes) {
    switch (outcome.kind) {
      case "diagnostic": {
        const severity = diagnosticSeverity(outcome.diagnostic.severity);
        counts.set(severity, (counts.get(severity) ?? 0) + 1);
        files.add(outcome.diagnostic.path);
        break;
      }
      case "timeout":
        timeouts++;
        files.add(outcome.path);
        break;
      case "unavailable_server":
        serverIssues++;
        files.add(outcome.path);
        break;
      case "warning":
        adapterWarnings++;
        break;
      case "no_diagnostics":
      case "no_configured_server":
        break;
    }
  }

  const warnings = (counts.get("warning") ?? 0) + adapterWarnings;
  const metrics = [
    [counts.get("error") ?? 0, "error", "errors", "error"],
    [warnings, "warning", "warnings", "warning"],
    [counts.get("information") ?? 0, "info", "info", "accent"],
    [counts.get("hint") ?? 0, "hint", "hints", "muted"],
    [counts.get("diagnostic") ?? 0, "diagnostic", "diagnostics", "muted"],
    [timeouts, "timeout", "timeouts", "warning"],
    [serverIssues, "server issue", "server issues", "warning"],
  ] as const;
  return [
    theme.fg("toolTitle", theme.bold("Post-edit diagnostics")),
    ...metrics
      .filter(([count]) => count > 0)
      .map(([count, singular, plural, color]) =>
        theme.fg(color, pluralizedCount(count, singular, plural)),
      ),
    theme.fg("muted", pluralizedCount(files.size, "file")),
  ].join(theme.fg("dim", "  ·  "));
}

function displayPath(cwd: string, path: string): string {
  const relativePath = relative(cwd, path);
  return relativePath !== "" && !relativePath.startsWith("..") ? relativePath : path;
}

function outcomePath(outcome: ReportablePostEditDiagnosticOutcome): string | undefined {
  return outcome.kind === "diagnostic"
    ? outcome.diagnostic.path
    : outcome.kind === "warning"
      ? undefined
      : outcome.path;
}

function compareReportableOutcomes(
  left: ReportablePostEditDiagnosticOutcome,
  right: ReportablePostEditDiagnosticOutcome,
): number {
  const leftPath = outcomePath(left) ?? "";
  const rightPath = outcomePath(right) ?? "";
  if (leftPath !== rightPath) return leftPath.localeCompare(rightPath);
  if (left.kind === "diagnostic" && right.kind === "diagnostic") {
    return (
      left.diagnostic.severity - right.diagnostic.severity ||
      left.diagnostic.line - right.diagnostic.line ||
      left.diagnostic.character - right.diagnostic.character ||
      left.diagnostic.serverId.localeCompare(right.diagnostic.serverId)
    );
  }
  if (left.kind === "diagnostic") return -1;
  if (right.kind === "diagnostic") return 1;
  return left.kind.localeCompare(right.kind);
}

function diagnosticLine(
  outcome: Extract<ReportablePostEditDiagnosticOutcome, { kind: "diagnostic" }>,
  theme: PostEditDiagnosticsEntryTheme,
): string {
  const diagnostic = outcome.diagnostic;
  const severity = diagnosticSeverity(diagnostic.severity);
  return `${theme.fg(severityColor(severity), `${diagnostic.line}:${diagnostic.character}`)}  ${diagnostic.message}  ${theme.fg("muted", diagnostic.serverId)}`;
}

function unavailableLine(
  outcome: Extract<ReportablePostEditDiagnosticOutcome, { kind: "timeout" | "unavailable_server" }>,
  theme: PostEditDiagnosticsEntryTheme,
): string {
  const label = outcome.kind === "timeout" ? "Diagnostics timed out" : "Server unavailable";
  return `${theme.fg("warning", label)}${outcome.serverId === undefined ? "" : `  ${theme.fg("muted", outcome.serverId)}`}`;
}

function appendExpandedOutcomes(
  container: Container,
  data: PostEditDiagnosticsEntryData,
  theme: PostEditDiagnosticsEntryTheme,
): void {
  const reportable = data.outcomes
    .filter(isReportablePostEditDiagnosticOutcome)
    .sort(compareReportableOutcomes);
  const outcomesByPath = new Map<string, ReportablePostEditDiagnosticOutcome[]>();
  const warnings: Extract<ReportablePostEditDiagnosticOutcome, { kind: "warning" }>[] = [];
  for (const outcome of reportable) {
    if (outcome.kind === "warning") {
      warnings.push(outcome);
      continue;
    }
    const path = outcomePath(outcome);
    if (path === undefined) continue;
    const entries = outcomesByPath.get(path) ?? [];
    entries.push(outcome);
    outcomesByPath.set(path, entries);
  }

  for (const [path, outcomes] of outcomesByPath) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("accent", theme.bold(displayPath(data.cwd, path))), 0, 0));
    for (const outcome of outcomes) {
      if (outcome.kind === "warning") continue;
      container.addChild(
        new Text(
          outcome.kind === "diagnostic"
            ? diagnosticLine(outcome, theme)
            : unavailableLine(outcome, theme),
          0,
          0,
        ),
      );
    }
  }
  if (warnings.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("warning", theme.bold("Warnings")), 0, 0));
    for (const warning of warnings) container.addChild(new Text(warning.message, 0, 0));
  }
}

/** Create a Post-edit Diagnostics Entry only when outcomes deserve transcript attention. */
export function createPostEditDiagnosticsEntryData(
  cwd: string,
  outcomes: readonly PostEditDiagnosticOutcome[],
): PostEditDiagnosticsEntryData | undefined {
  const reportable = outcomes.filter(isReportablePostEditDiagnosticOutcome);
  return reportable.length === 0
    ? undefined
    : Value.Parse(PostEditDiagnosticsEntryDataSchema, { cwd, outcomes: reportable });
}

/** Render one model-invisible Post-edit Diagnostics Entry with native Pi expansion and theming. */
export function renderPostEditDiagnosticsEntry(
  data: PostEditDiagnosticsEntryData,
  expanded: boolean,
  theme: PostEditDiagnosticsEntryTheme,
): Component {
  const container = new Container();
  const hint = expanded
    ? ""
    : `${theme.fg("dim", `  ·  ${keyText("app.tools.expand")}`)}${theme.fg("muted", " to expand")}`;
  container.addChild(new Text(`${entrySummary(data, theme)}${hint}`, 0, 0));
  if (expanded) appendExpandedOutcomes(container, data, theme);

  const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
  box.addChild(container);
  return box;
}
