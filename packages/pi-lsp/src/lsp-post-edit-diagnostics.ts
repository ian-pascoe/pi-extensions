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

/** Runtime schema for one normalized LSP Diagnostic appended to a mutation result. */
export const PostEditLspDiagnosticSchema = Type.Object(
  {
    serverId: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
    line: Type.Integer({ minimum: 1 }),
    character: Type.Integer({ minimum: 1 }),
    severity: Type.Number(),
    message: Type.String(),
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
  event: ToolResultEvent,
  diagnostics: PostEditDiagnosticsRunner,
): Promise<PostEditDiagnosticsResultPatch | undefined> {
  const extracted = extractPostEditDiagnosticPaths(event);
  if (extracted === undefined) return undefined;
  const outcomes = [
    ...extracted.warnings.map((message): PostEditDiagnosticOutcome => ({
      kind: "warning",
      message,
    })),
    ...(await diagnostics(extracted.paths)),
  ];
  if (outcomes.length === 0) return undefined;
  const patch: PostEditDiagnosticsResultPatch = {
    content: [...event.content, { type: "text", text: formatPostEditDiagnostics(outcomes) }],
    details: event.details,
    isError: event.isError,
    outcomes,
  };
  return event.usage === undefined ? patch : { ...patch, usage: event.usage };
}
