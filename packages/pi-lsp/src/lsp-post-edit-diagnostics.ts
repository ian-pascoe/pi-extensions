import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { collapseLspWhitespace, lspDisplayPath, lspDisplayPosition } from "./lsp-location-text.js";
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
    { kind: Type.Literal("no_diagnostics"), path: Type.String({ minLength: 1 }) },
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

/** Name a protocol `DiagnosticSeverity`, or undefined for a number outside its four values. */
export function lspSeverityName(severity: number): string | undefined {
  return SEVERITY_NAMES.get(severity);
}

/** Outcomes shown to the model: a file no Server Definition covers is dropped before formatting. */
type ShownOutcome = Exclude<PostEditDiagnosticOutcome, { kind: "no_configured_server" }>;

/** Shown outcomes that take a line of their own; clean files are grouped instead. */
type ReportedOutcome = Exclude<ShownOutcome, { kind: "no_diagnostics" }>;

function isShownOutcome(outcome: PostEditDiagnosticOutcome): outcome is ShownOutcome {
  return outcome.kind !== "no_configured_server";
}

function formatOutcome(outcome: ReportedOutcome, cwd: string): string {
  switch (outcome.kind) {
    case "diagnostic": {
      const diagnostic = outcome.diagnostic;
      const severity = lspSeverityName(diagnostic.severity) ?? `severity ${diagnostic.severity}`;
      const message = collapseLspWhitespace(diagnostic.message);
      return `${lspDisplayPosition(cwd, diagnostic)} ${severity} [${diagnostic.serverId}]: ${message}`;
    }
    case "timeout":
      return `${lspDisplayPath(cwd, outcome.path)}: diagnostics timeout${outcome.serverId === undefined ? "" : ` (${outcome.serverId})`}`;
    case "unavailable_server":
      return `${lspDisplayPath(cwd, outcome.path)}: unavailable server${outcome.serverId === undefined ? "" : ` (${outcome.serverId})`}`;
    case "warning":
      return outcome.message;
  }
}

function compareOutcomes(left: ReportedOutcome, right: ReportedOutcome, cwd: string): number {
  if (left.kind === "diagnostic" && right.kind === "diagnostic") {
    const leftDiagnostic = left.diagnostic;
    const rightDiagnostic = right.diagnostic;
    return (
      leftDiagnostic.severity - rightDiagnostic.severity ||
      leftDiagnostic.path.localeCompare(rightDiagnostic.path) ||
      leftDiagnostic.line - rightDiagnostic.line ||
      leftDiagnostic.character - rightDiagnostic.character ||
      leftDiagnostic.serverId.localeCompare(rightDiagnostic.serverId)
    );
  }
  if (left.kind === "diagnostic") return -1;
  if (right.kind === "diagnostic") return 1;
  return formatOutcome(left, cwd).localeCompare(formatOutcome(right, cwd));
}

/** One line naming the clean files; a file some server reported a finding for is never listed as clean. */
function cleanPathsLine(
  paths: readonly string[],
  reported: readonly ReportedOutcome[],
  cwd: string,
): readonly string[] {
  const pathsWithFindings = new Set(
    reported.flatMap((outcome) =>
      outcome.kind === "diagnostic" ? [lspDisplayPath(cwd, outcome.diagnostic.path)] : [],
    ),
  );
  const displayed = [...new Set(paths.map((path) => lspDisplayPath(cwd, path)))]
    .filter((path) => !pathsWithFindings.has(path))
    .sort((left, right) => left.localeCompare(right));
  if (displayed.length === 0) return [];
  return [`no diagnostics: ${displayed.join(", ")}`];
}

/**
 * Render one compact deterministic LSP section without deduplicating independent server
 * diagnostics. Paths are relative to `cwd`. Findings and failures take one line each; clean files
 * are grouped on one line, leaving out a file any server reported a finding for, and when every
 * file is clean the section is a single line.
 */
export function formatPostEditDiagnostics(
  outcomes: readonly ShownOutcome[],
  cwd: string,
  omittedHints = 0,
): string {
  const omittedNote =
    omittedHints > 0 ? `${omittedHints} ${omittedHints === 1 ? "hint" : "hints"} omitted` : "";
  if (outcomes.every(({ kind }) => kind === "no_diagnostics")) {
    return `\n\nLSP diagnostics: no diagnostics${omittedNote === "" ? "" : ` (${omittedNote})`}`;
  }
  const clean: string[] = [];
  const reported: ReportedOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "no_diagnostics") clean.push(outcome.path);
    else reported.push(outcome);
  }
  const lines = [
    ...reported
      .sort((left, right) => compareOutcomes(left, right, cwd))
      .map((outcome) => formatOutcome(outcome, cwd)),
    ...cleanPathsLine(clean, reported, cwd),
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
 * Drop hint-severity findings and count them. A file left with no finding after the drop is
 * reported clean, so the omission never makes it disappear from the section.
 */
function omitHintOutcomes(outcomes: readonly ShownOutcome[]): HintFilterResult {
  const kept: ShownOutcome[] = [];
  const hintPaths = new Set<string>();
  let omittedHints = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === "diagnostic" && outcome.diagnostic.severity === HINT_SEVERITY) {
      omittedHints++;
      hintPaths.add(outcome.diagnostic.path);
    } else kept.push(outcome);
  }
  const accountedPaths = new Set(
    kept.flatMap((outcome) =>
      outcome.kind === "diagnostic"
        ? [outcome.diagnostic.path]
        : outcome.kind === "no_diagnostics"
          ? [outcome.path]
          : [],
    ),
  );
  for (const path of hintPaths) {
    if (!accountedPaths.has(path)) kept.push({ kind: "no_diagnostics", path });
  }
  return { outcomes: kept, omittedHints };
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
  // The one place a file no Server Definition covers is dropped: it is noise, not a finding.
  const shown = (await diagnostics(extracted.paths)).filter(isShownOutcome);
  const { outcomes: filtered, omittedHints } = options.includeHints
    ? { outcomes: shown, omittedHints: 0 }
    : omitHintOutcomes(shown);
  const outcomes: ShownOutcome[] = [
    ...extracted.warnings.map((message): ShownOutcome => ({
      kind: "warning",
      message,
    })),
    ...filtered,
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
