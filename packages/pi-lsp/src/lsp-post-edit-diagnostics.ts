import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { MutationManifestSchema } from "./lsp-tool-contract.js";

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

/** A normalized LSP Diagnostic appended to a mutation result. */
export interface PostEditLspDiagnostic {
  /** Language server that produced this independent diagnostic. */
  readonly serverId: string;
  /** File path reported by the language server. */
  readonly path: string;
  /** One-based source line. */
  readonly line: number;
  /** One-based Unicode-code-point character. */
  readonly character: number;
  /** LSP DiagnosticSeverity value; lower values are more severe. */
  readonly severity: number;
  /** User-readable language-server diagnostic message. */
  readonly message: string;
}

/** An explicit outcome when fresh diagnostics cannot be represented as a diagnostic. */
export type PostEditDiagnosticOutcome =
  | { readonly kind: "diagnostic"; readonly diagnostic: PostEditLspDiagnostic }
  | { readonly kind: "no_diagnostics"; readonly path: string }
  | { readonly kind: "no_configured_server"; readonly path: string }
  | { readonly kind: "timeout"; readonly path: string; readonly serverId?: string }
  | { readonly kind: "unavailable_server"; readonly path: string; readonly serverId?: string }
  | { readonly kind: "warning"; readonly message: string };

/** Runs fresh Post-edit Diagnostics for changed paths after a Supported Mutation Tool result. */
export interface PostEditDiagnosticsRunner {
  /** Return every fresh diagnostic and explicit non-diagnostic outcome for the supplied paths. */
  runPostEditDiagnostics(
    paths: readonly PostEditDiagnosticPath[],
  ): Promise<readonly PostEditDiagnosticOutcome[]>;
}

/** Minimal Tool Result shape accepted by the structural post-edit adapters. */
export interface PostEditToolResult {
  /** Tool name supplied by Pi's central tool-result event. */
  readonly toolName: string;
  /** Original tool arguments supplied to the central event. */
  readonly input: ToolResultEvent["input"];
  /** Tool-result details owned by the mutation implementation. */
  readonly details: ToolResultEvent["details"];
  /** Existing Pi content, retained verbatim before the appended LSP section. */
  readonly content: ToolResultEvent["content"];
  /** Existing tool failure state, which diagnostics must not change. */
  readonly isError: boolean;
  /** Existing usage accounting, which diagnostics must not change. */
  readonly usage?: ToolResultEvent["usage"];
}

/** Tool-result fields returned by Post-edit Diagnostics middleware without changing mutation state. */
export interface PostEditDiagnosticsResultPatch {
  /** Original content with exactly one deterministic LSP section appended. */
  readonly content: ToolResultEvent["content"];
  /** Original details retained exactly for downstream middleware and session replay. */
  readonly details: ToolResultEvent["details"];
  /** Original mutation error state retained exactly. */
  readonly isError: boolean;
  /** Original usage retained when Pi supplied it. */
  readonly usage?: ToolResultEvent["usage"];
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
  event: Pick<PostEditToolResult, "toolName" | "input" | "details" | "isError">,
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

  if (event.toolName === "lsp" && event.input.operation === "apply") {
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

function formatOutcome(outcome: PostEditDiagnosticOutcome): string {
  switch (outcome.kind) {
    case "diagnostic": {
      const diagnostic = outcome.diagnostic;
      return `${diagnostic.path}:${diagnostic.line}:${diagnostic.character} [${diagnostic.serverId}] severity ${diagnostic.severity}: ${diagnostic.message}`;
    }
    case "no_diagnostics":
      return `${outcome.path}: no diagnostics`;
    case "no_configured_server":
      return `${outcome.path}: no configured server`;
    case "timeout":
      return `${outcome.path}: diagnostics timeout${outcome.serverId === undefined ? "" : ` (${outcome.serverId})`}`;
    case "unavailable_server":
      return `${outcome.path}: unavailable server${outcome.serverId === undefined ? "" : ` (${outcome.serverId})`}`;
    case "warning":
      return outcome.message;
  }
}

function compareOutcomes(
  left: PostEditDiagnosticOutcome,
  right: PostEditDiagnosticOutcome,
): number {
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
  return formatOutcome(left).localeCompare(formatOutcome(right));
}

/** Render one compact deterministic LSP section without deduplicating independent server diagnostics. */
export function formatPostEditDiagnostics(outcomes: readonly PostEditDiagnosticOutcome[]): string {
  const lines = [...outcomes].sort(compareOutcomes).map(formatOutcome);
  return `\n\nLSP diagnostics\n${lines.length === 0 ? "no diagnostics" : lines.join("\n")}`;
}

/** Append fresh Post-edit Diagnostics while preserving every mutation-result field Pi already owns. */
export async function appendPostEditDiagnostics(
  event: PostEditToolResult,
  diagnostics: PostEditDiagnosticsRunner,
): Promise<PostEditDiagnosticsResultPatch | undefined> {
  const extracted = extractPostEditDiagnosticPaths(event);
  if (extracted === undefined) return undefined;
  const outcomes = [
    ...extracted.warnings.map((message): PostEditDiagnosticOutcome => ({
      kind: "warning",
      message,
    })),
    ...(await diagnostics.runPostEditDiagnostics(extracted.paths)),
  ];
  const patch: PostEditDiagnosticsResultPatch = {
    content: [...event.content, { type: "text", text: formatPostEditDiagnostics(outcomes) }],
    details: event.details,
    isError: event.isError,
  };
  return event.usage === undefined ? patch : { ...patch, usage: event.usage };
}

/** Adapt Pi's central ToolResultEvent shape to Post-edit Diagnostics middleware. */
export async function appendPiPostEditDiagnostics(
  event: ToolResultEvent,
  diagnostics: PostEditDiagnosticsRunner,
): Promise<PostEditDiagnosticsResultPatch | undefined> {
  return appendPostEditDiagnostics(event, diagnostics);
}
