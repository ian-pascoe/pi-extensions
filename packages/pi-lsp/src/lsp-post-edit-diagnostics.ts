import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  collapseLspWhitespace,
  lspDiagnosticOrigin,
  lspDisplayPath,
  lspDisplayRange,
} from "./lsp-location-text.js";
import type { DependentDiagnosticsReport } from "./lsp-dependent-diagnostics.js";
import { LSP_APPLY_RESULT_TOOL_NAMES, MutationManifestSchema } from "./lsp-tool-contract.js";

const NativeMutationInputSchema = Type.Object(
  { path: Type.String() },
  { additionalProperties: true },
);
const ApplyPatchDetailsSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("success"), Type.Literal("partial_failure")]),
    result: Type.Object(
      {
        changedFiles: Type.Array(Type.String()),
        createdFiles: Type.Array(Type.String()),
        deletedFiles: Type.Array(Type.String()),
        movedFiles: Type.Array(
          Type.Object({ from: Type.String(), to: Type.String() }, { additionalProperties: true }),
        ),
        fuzz: Type.Optional(Type.Number()),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);
const WorkspaceEditApplyDetailsSchema = Type.Object(
  {
    kind: Type.Literal("workspace_edit_apply"),
    state: Type.Union([Type.Literal("applied"), Type.Literal("partial_failure")]),
    changed_paths: Type.Array(Type.String()),
  },
  { additionalProperties: true },
);

type ApplyPatchDetails = Static<typeof ApplyPatchDetailsSchema>;

/** A path changed by a Supported Mutation Tool and eligible for document diagnostics. */
export interface PostEditDiagnosticPath {
  /** Absolute or tool-relative file path after the mutation. */
  readonly path: string;
}

/** Runtime schema for one normalized LSP Diagnostic appended to a mutation result. */
export const PostEditLspDiagnosticSchema = Type.Object(
  {
    serverId: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
    line: Type.Integer({ minimum: 1 }),
    character: Type.Integer({ minimum: 1 }),
    severity: Type.Number(),
    message: Type.String(),
    /** The server's name for the tool that found it, such as `ts` or `eslint`. */
    source: Type.Optional(Type.String()),
    /** The server's rule or error code, such as `2322` or `no-unused-vars`. */
    code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    /** One-based range end; absent in entries saved before ranges were recorded. */
    endLine: Type.Optional(Type.Integer({ minimum: 1 })),
    endCharacter: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Set on an error an edit caused in a dependent file rather than in a changed file. */
    dependent: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);

/** A normalized LSP Diagnostic appended to a mutation result. */
export type PostEditLspDiagnostic = Static<typeof PostEditLspDiagnosticSchema>;

/** Runtime schema for reportable and intentionally silent Post-edit Diagnostic outcomes. */
export const PostEditDiagnosticOutcomeSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("diagnostic"), diagnostic: PostEditLspDiagnosticSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("no_diagnostics"),
      path: Type.String({ minLength: 1 }),
      /** The Server Instance that found the file clean, when one did. */
      serverId: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  /** Findings of one severity a changed file already had in its Pre-edit Baseline. */
  Type.Object(
    {
      kind: Type.Literal("unchanged"),
      path: Type.String({ minLength: 1 }),
      severity: Type.Number(),
      count: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
  /** A server whose Pre-edit Baseline pull failed or timed out, so its findings for the file are all listed. */
  Type.Object(
    {
      kind: Type.Literal("no_baseline"),
      path: Type.String({ minLength: 1 }),
      serverId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("no_configured_server"), path: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("timeout"),
      path: Type.String({ minLength: 1 }),
      serverId: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("unavailable_server"),
      path: Type.String({ minLength: 1 }),
      serverId: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("warning"), message: Type.String() },
    { additionalProperties: false },
  ),
]);

/** An explicit outcome when fresh diagnostics cannot be represented as a diagnostic. */
export type PostEditDiagnosticOutcome = Static<typeof PostEditDiagnosticOutcomeSchema>;

/** Runs fresh Post-edit Diagnostics for changed paths after a Supported Mutation Tool result. */
export type PostEditDiagnosticsRunner = (
  paths: readonly PostEditDiagnosticPath[],
) => Promise<readonly PostEditDiagnosticOutcome[]>;

/** Tool-result fields returned by Post-edit Diagnostics middleware without changing mutation state. */
export interface PostEditDiagnosticsResultPatch {
  /** Original content with exactly one deterministic LSP section appended. */
  readonly content: ToolResultEvent["content"];
  /** Original details retained exactly for downstream middleware and session replay. */
  readonly details: ToolResultEvent["details"];
  /** Original structured result retained for programmatic callers; Pi drops it with replaced content otherwise. */
  readonly structuredContent: ToolResultEvent["structuredContent"];
  /** Original mutation error state retained exactly. */
  readonly isError: boolean;
  /** Original usage retained when Pi supplied it. */
  readonly usage?: ToolResultEvent["usage"];
  /** Fresh outcomes retained for model-invisible transcript presentation. */
  readonly outcomes: readonly PostEditDiagnosticOutcome[];
}

type ExtractedMutation = {
  readonly paths: readonly PostEditDiagnosticPath[];
  readonly warnings: readonly string[];
};

function mutationResult(details: ApplyPatchDetails) {
  return {
    changedPaths: [
      ...details.result.changedFiles,
      ...details.result.createdFiles,
      ...details.result.movedFiles.map(({ to }) => to),
    ],
    deletedPaths: details.result.deletedFiles,
  };
}

function manifestDestinationPaths(manifest: Static<typeof MutationManifestSchema>): string[] {
  const paths: string[] = [];
  for (const entry of manifest) {
    if (entry.operation === "delete") continue;
    if (entry.operation === "rename") {
      paths.push(entry.destination_path);
      continue;
    }
    paths.push(entry.path);
  }
  return paths;
}

function pathsAfterMutation(result: ReturnType<typeof mutationResult>): PostEditDiagnosticPath[] {
  const deletedPaths = new Set(result.deletedPaths);
  return [...new Set(result.changedPaths)]
    .filter((path) => !deletedPaths.has(path))
    .sort((left, right) => left.localeCompare(right))
    .map((path) => ({ path }));
}

/** Extract exact changed destination paths from one Supported Mutation Tool result. */
export function extractPostEditDiagnosticPaths(
  event: Pick<ToolResultEvent, "toolName" | "input" | "details" | "isError">,
): ExtractedMutation | undefined {
  if (event.toolName === "edit" || event.toolName === "write") {
    if (event.isError || !Value.Check(NativeMutationInputSchema, event.input)) return undefined;
    return { paths: [{ path: event.input.path }], warnings: [] };
  }

  if (event.toolName === "apply_patch") {
    if (!Value.Check(ApplyPatchDetailsSchema, event.details)) {
      return {
        paths: [],
        warnings: [
          "Pi LSP: apply_patch diagnostics adapter skipped an unknown Codex result shape.",
        ],
      };
    }
    return { paths: pathsAfterMutation(mutationResult(event.details)), warnings: [] };
  }

  // `lsp_apply` and the legacy `lsp` tool's apply operation both report `workspace_edit_apply` details.
  if (LSP_APPLY_RESULT_TOOL_NAMES.has(event.toolName)) {
    if (
      !Value.Check(MutationManifestSchema, event.input.mutation_manifest) ||
      !Value.Check(WorkspaceEditApplyDetailsSchema, event.details)
    ) {
      return undefined;
    }
    const verifiedManifestPaths = manifestDestinationPaths(event.input.mutation_manifest);
    const actualPaths = new Set(event.details.changed_paths);
    return {
      paths: verifiedManifestPaths
        .filter((path) => actualPaths.has(path))
        .sort((left, right) => left.localeCompare(right))
        .map((path) => ({ path })),
      warnings: [],
    };
  }

  return undefined;
}

/** `DiagnosticSeverity` names shared by the model-visible text and the transcript entry. */
const SEVERITY_NAMES: ReadonlyMap<number, string> = new Map([
  [1, "error"],
  [2, "warning"],
  [3, "info"],
  [4, "hint"],
]);

/** Plural `DiagnosticSeverity` names for counts; `info` is uncountable. */
const SEVERITY_PLURALS: ReadonlyMap<number, string> = new Map([
  [1, "errors"],
  [2, "warnings"],
  [3, "info"],
  [4, "hints"],
]);

/** Name a protocol `DiagnosticSeverity`, or undefined for a number outside its four values. */
export function lspSeverityName(severity: number): string | undefined {
  return SEVERITY_NAMES.get(severity);
}

/** Count findings per severity as `1 error, 12 warnings`, most severe first. */
export function lspSeverityCountsText(counts: ReadonlyMap<number, number>): string {
  return [...counts]
    .filter(([, count]) => count > 0)
    .toSorted(([left], [right]) => left - right)
    .map(([severity, count]) => {
      const name =
        (count === 1 ? SEVERITY_NAMES : SEVERITY_PLURALS).get(severity) ??
        `with severity ${severity}`;
      return `${count} ${name}`;
    })
    .join(", ");
}

/** Outcomes shown to the model: a file no Server Definition covers is dropped before formatting. */
type ShownOutcome = Exclude<PostEditDiagnosticOutcome, { kind: "no_configured_server" }>;

/**
 * Shown outcomes that take a line of their own; clean files are grouped, and unchanged findings
 * are counted per file instead.
 */
type ReportedOutcome = Exclude<ShownOutcome, { kind: "no_diagnostics" | "unchanged" }>;

type UnchangedOutcome = Extract<PostEditDiagnosticOutcome, { kind: "unchanged" }>;

function isShownOutcome(outcome: PostEditDiagnosticOutcome): outcome is ShownOutcome {
  return outcome.kind !== "no_configured_server";
}

/** Render one normalized finding as `path:line:col[-end] severity [server][ source(code)]: message`. */
function formatFinding(diagnostic: PostEditLspDiagnostic, cwd: string): string {
  const severity = lspSeverityName(diagnostic.severity) ?? `severity ${diagnostic.severity}`;
  const origin = lspDiagnosticOrigin(diagnostic.source, diagnostic.code);
  const message = collapseLspWhitespace(diagnostic.message);
  return `${lspDisplayRange(cwd, diagnostic)} ${severity} [${diagnostic.serverId}]${origin === undefined ? "" : ` ${origin}`}: ${message}`;
}

function formatOutcome(outcome: ReportedOutcome, cwd: string): string {
  switch (outcome.kind) {
    case "diagnostic":
      return formatFinding(outcome.diagnostic, cwd);
    case "timeout":
      return `${lspDisplayPath(cwd, outcome.path)}: diagnostics timeout${outcome.serverId === undefined ? "" : ` (${outcome.serverId})`}`;
    case "unavailable_server":
      return `${lspDisplayPath(cwd, outcome.path)}: unavailable server${outcome.serverId === undefined ? "" : ` (${outcome.serverId})`}`;
    case "no_baseline":
      return `${lspDisplayPath(cwd, outcome.path)}: no pre-edit baseline from ${outcome.serverId}, so all its findings are listed`;
    case "warning":
      return outcome.message;
  }
}

function compareFindings(left: PostEditLspDiagnostic, right: PostEditLspDiagnostic): number {
  return (
    left.severity - right.severity ||
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.character - right.character ||
    (left.endLine ?? left.line) - (right.endLine ?? right.line) ||
    (left.endCharacter ?? left.character) - (right.endCharacter ?? right.character) ||
    left.serverId.localeCompare(right.serverId)
  );
}

function compareOutcomes(left: ReportedOutcome, right: ReportedOutcome, cwd: string): number {
  if (left.kind === "diagnostic" && right.kind === "diagnostic") {
    return compareFindings(left.diagnostic, right.diagnostic);
  }
  if (left.kind === "diagnostic") return -1;
  if (right.kind === "diagnostic") return 1;
  return formatOutcome(left, cwd).localeCompare(formatOutcome(right, cwd));
}

/** Unchanged finding counts per severity, by absolute file path. */
function unchangedCountsByPath(
  outcomes: readonly ShownOutcome[],
): ReadonlyMap<string, ReadonlyMap<number, number>> {
  const byPath = new Map<string, Map<number, number>>();
  for (const outcome of outcomes) {
    if (outcome.kind !== "unchanged") continue;
    const counts = byPath.get(outcome.path) ?? new Map<number, number>();
    counts.set(outcome.severity, (counts.get(outcome.severity) ?? 0) + outcome.count);
    byPath.set(outcome.path, counts);
  }
  return byPath;
}

/**
 * One line per file with unchanged findings: `path: 2 new; unchanged: 1 error`, or
 * `path: no new diagnostics (unchanged: 1 error)` when the edit introduced none there.
 */
function unchangedSummaryLines(
  unchanged: ReadonlyMap<string, ReadonlyMap<number, number>>,
  reported: readonly ReportedOutcome[],
  cwd: string,
): string[] {
  return [...unchanged].map(([path, counts]) => {
    const listed = reported.filter(
      (outcome) => outcome.kind === "diagnostic" && outcome.diagnostic.path === path,
    ).length;
    const display = lspDisplayPath(cwd, path);
    const countsText = lspSeverityCountsText(counts);
    return listed === 0
      ? `${display}: no new diagnostics (unchanged: ${countsText})`
      : `${display}: ${listed} new; unchanged: ${countsText}`;
  });
}

/**
 * One line naming the clean files; a file some server reported a finding for, new or unchanged, is
 * never listed as clean.
 */
function cleanPathsLine(
  paths: readonly string[],
  reported: readonly ReportedOutcome[],
  unchangedPaths: Iterable<string>,
  cwd: string,
): readonly string[] {
  const pathsWithFindings = new Set([
    ...reported.flatMap((outcome) =>
      outcome.kind === "diagnostic" ? [lspDisplayPath(cwd, outcome.diagnostic.path)] : [],
    ),
    ...[...unchangedPaths].map((path) => lspDisplayPath(cwd, path)),
  ]);
  const displayed = [...new Set(paths.map((path) => lspDisplayPath(cwd, path)))]
    .filter((path) => !pathsWithFindings.has(path))
    .sort((left, right) => left.localeCompare(right));
  if (displayed.length === 0) return [];
  return [`no diagnostics: ${displayed.join(", ")}`];
}

/**
 * Render one compact deterministic LSP section without deduplicating independent server
 * diagnostics. Paths are relative to `cwd`. Findings and failures take one line each; findings a
 * changed file already had in its Pre-edit Baseline are counted per file instead of listed; clean
 * files are grouped on one line, leaving out a file any server reported a finding for. When no
 * finding or failure is listed, the section is a single line.
 */
export function formatPostEditDiagnostics(
  outcomes: readonly ShownOutcome[],
  cwd: string,
  omittedHints = 0,
): string {
  const omittedNote =
    omittedHints > 0 ? `${omittedHints} ${omittedHints === 1 ? "hint" : "hints"} omitted` : "";
  const clean: string[] = [];
  const reported: ReportedOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "no_diagnostics") clean.push(outcome.path);
    else if (outcome.kind !== "unchanged") reported.push(outcome);
  }
  const unchanged = unchangedCountsByPath(outcomes);
  if (reported.length === 0) {
    const total = new Map<number, number>();
    for (const counts of unchanged.values()) {
      for (const [severity, count] of counts)
        total.set(severity, (total.get(severity) ?? 0) + count);
    }
    const notes = [
      ...(total.size === 0 ? [] : [`unchanged: ${lspSeverityCountsText(total)}`]),
      ...(omittedNote === "" ? [] : [omittedNote]),
    ];
    const head = total.size === 0 ? "no diagnostics" : "no new diagnostics";
    return `\n\nLSP diagnostics: ${head}${notes.length === 0 ? "" : ` (${notes.join("; ")})`}`;
  }
  const findings = reported.filter((outcome) => outcome.kind === "diagnostic");
  const others = reported.filter((outcome) => outcome.kind !== "diagnostic");
  const lines = [
    ...findings
      .sort((left, right) => compareOutcomes(left, right, cwd))
      .map((outcome) => formatOutcome(outcome, cwd)),
    ...[
      ...others.map((outcome) => formatOutcome(outcome, cwd)),
      ...unchangedSummaryLines(unchanged, reported, cwd),
    ].sort((left, right) => left.localeCompare(right)),
    ...cleanPathsLine(clean, reported, unchanged.keys(), cwd),
    ...(omittedNote === "" ? [] : [omittedNote]),
  ];
  return `\n\nLSP diagnostics\n${lines.join("\n")}`;
}

/** Heading of the section naming the new errors an edit caused in dependent files. */
const DEPENDENT_HEADING = "LSP diagnostics in dependent files (new errors only)";

/**
 * Render the new errors an edit caused in dependent files under their own heading, followed by the
 * count of dependent files left unchecked. Empty when there is nothing to report.
 */
export function formatDependentDiagnostics(
  report: DependentDiagnosticsReport,
  cwd: string,
): string {
  const errors = report.outcomes
    .filter((outcome) => outcome.kind === "diagnostic")
    .toSorted((left, right) => compareOutcomes(left, right, cwd))
    .map((outcome) => formatOutcome(outcome, cwd));
  const unchecked = report.scanTimedOut
    ? ["dependent files not checked: the scan ran out of time"]
    : report.omittedFiles > 0
      ? [
          `${report.omittedFiles} dependent ${report.omittedFiles === 1 ? "file" : "files"} not checked`,
        ]
      : [];
  const lines = [...errors, ...unchecked];
  return lines.length === 0 ? "" : `\n\n${DEPENDENT_HEADING}\n${lines.join("\n")}`;
}

/** Options for Post-edit Diagnostics feedback. */
export interface PostEditDiagnosticsOptions {
  /** Include hint-severity findings; they are omitted and counted by default. */
  readonly includeHints?: boolean;
  /**
   * Compare the fresh outcomes with the changed file's Pre-edit Baseline, replacing each finding
   * the baseline already had with an `unchanged` count and noting each server without a baseline.
   */
  readonly preEditBaseline?:
    | ((
        outcomes: readonly PostEditDiagnosticOutcome[],
      ) => Promise<readonly PostEditDiagnosticOutcome[]>)
    | undefined;
  /** Check dependent files of the changed paths for errors the edit caused. */
  readonly dependentDiagnostics?:
    | ((
        paths: readonly PostEditDiagnosticPath[],
      ) => Promise<DependentDiagnosticsReport | undefined>)
    | undefined;
}

const HINT_SEVERITY = 4;

interface HintFilterResult {
  readonly outcomes: ShownOutcome[];
  readonly omittedHints: number;
}

/**
 * Drop hint-severity findings and count the new ones; unchanged hints are dropped uncounted. A file
 * left with no finding after the drop is reported clean, so the omission never makes it disappear
 * from the section.
 */
function omitHintOutcomes(outcomes: readonly ShownOutcome[]): HintFilterResult {
  const kept: ShownOutcome[] = [];
  const hintPaths = new Set<string>();
  let omittedHints = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === "diagnostic" && outcome.diagnostic.severity === HINT_SEVERITY) {
      omittedHints++;
      hintPaths.add(outcome.diagnostic.path);
    } else if (outcome.kind === "unchanged" && outcome.severity === HINT_SEVERITY) {
      hintPaths.add(outcome.path);
    } else kept.push(outcome);
  }
  const accountedPaths = new Set(
    kept.flatMap((outcome) =>
      outcome.kind === "diagnostic"
        ? [outcome.diagnostic.path]
        : outcome.kind === "no_diagnostics" || outcome.kind === "unchanged"
          ? [outcome.path]
          : [],
    ),
  );
  for (const path of hintPaths) {
    if (!accountedPaths.has(path)) kept.push({ kind: "no_diagnostics", path });
  }
  return { outcomes: kept, omittedHints };
}

/**
 * Merge unchanged counts per file and severity, and keep a server's no-baseline note only while it
 * still lists a finding for that file, so the note never stands alone.
 */
function settleBaselineOutcomes(outcomes: readonly ShownOutcome[]): ShownOutcome[] {
  const listed = new Set(
    outcomes.flatMap((outcome) =>
      outcome.kind === "diagnostic"
        ? [`${outcome.diagnostic.path}\u0000${outcome.diagnostic.serverId}`]
        : [],
    ),
  );
  const unchanged = new Map<string, UnchangedOutcome>();
  const settled: ShownOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "no_baseline") {
      if (listed.has(`${outcome.path}\u0000${outcome.serverId}`)) settled.push(outcome);
    } else if (outcome.kind === "unchanged") {
      const key = `${outcome.path}\u0000${outcome.severity}`;
      const merged = unchanged.get(key);
      unchanged.set(
        key,
        merged === undefined ? outcome : { ...merged, count: merged.count + outcome.count },
      );
    } else settled.push(outcome);
  }
  return [...settled, ...unchanged.values()];
}

/** Append fresh Post-edit Diagnostics while preserving every mutation-result field Pi already owns. */
export async function appendPostEditDiagnostics(
  event: ToolResultEvent,
  diagnostics: PostEditDiagnosticsRunner,
  cwd: string,
  options: PostEditDiagnosticsOptions = {},
): Promise<PostEditDiagnosticsResultPatch | undefined> {
  const extracted = extractPostEditDiagnosticPaths(event);
  if (extracted === undefined) return undefined;
  const fresh = await diagnostics(extracted.paths);
  const compared =
    options.preEditBaseline === undefined ? fresh : await options.preEditBaseline(fresh);
  // The one place a file no Server Definition covers is dropped: it is noise, not a finding.
  const shown = compared.filter(isShownOutcome);
  const { outcomes: filtered, omittedHints } = options.includeHints
    ? { outcomes: shown, omittedHints: 0 }
    : omitHintOutcomes(shown);
  const outcomes: ShownOutcome[] = [
    ...extracted.warnings.map((message): ShownOutcome => ({
      kind: "warning",
      message,
    })),
    ...settleBaselineOutcomes(filtered),
  ];
  const dependents = await options.dependentDiagnostics?.(extracted.paths);
  const dependentText = dependents === undefined ? "" : formatDependentDiagnostics(dependents, cwd);
  if (outcomes.length === 0 && dependentText === "") return undefined;
  const mainText =
    outcomes.length === 0 ? "" : formatPostEditDiagnostics(outcomes, cwd, omittedHints);
  const patch: PostEditDiagnosticsResultPatch = {
    content: [...event.content, { type: "text", text: `${mainText}${dependentText}` }],
    details: event.details,
    structuredContent: event.structuredContent,
    isError: event.isError,
    outcomes: [...outcomes, ...(dependentText === "" ? [] : (dependents?.outcomes ?? []))],
  };
  return event.usage === undefined ? patch : { ...patch, usage: event.usage };
}
