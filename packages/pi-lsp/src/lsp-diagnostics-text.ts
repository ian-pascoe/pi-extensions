import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  assembleLspReadText,
  collapseLspWhitespace,
  lspDisplayPath,
  lspDisplayPosition,
  LspNormalizedPositionSchema,
  type LspRead,
  type LspReadTextBlock,
} from "./lsp-location-text.js";
import { pluralizedCount } from "./lsp-post-edit-diagnostics-rendering.js";
import { lspSeverityName } from "./lsp-post-edit-diagnostics.js";
import type { LspOperationName } from "./lsp-tool-contract.js";
import { formatLspToolValue } from "./lsp-tool-output.js";

const DIAGNOSTICS_OPERATIONS = [
  "diagnostics",
  "workspace_diagnostics",
] as const satisfies readonly LspOperationName[];

/** Read operations whose model-visible text lists LSP Diagnostics (ADR-0003: derived from the Structured Result). */
export type LspDiagnosticsOperation = (typeof DIAGNOSTICS_OPERATIONS)[number];

const DIAGNOSTICS_OPERATION_SET: ReadonlySet<LspOperationName> = new Set(DIAGNOSTICS_OPERATIONS);

/** Report whether an operation's model-visible text uses the readable diagnostics format. */
export function isLspDiagnosticsOperation(
  operation: LspOperationName,
): operation is LspDiagnosticsOperation {
  return DIAGNOSTICS_OPERATION_SET.has(operation);
}

/** Servers send `null` for optional fields they leave out, so `null` reads as an omitted field. */
const DiagnosticSchema = Type.Object({
  range: Type.Object({ start: LspNormalizedPositionSchema }),
  message: Type.String(),
  severity: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  source: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  code: Type.Optional(Type.Union([Type.String(), Type.Integer(), Type.Null()])),
});
/** Diagnostics stay opaque per item, so one malformed diagnostic does not hide the others. */
const DiagnosticListSchema = Type.Array(Type.Unknown());
const DocumentDiagnosticsSchema = Type.Union([
  Type.Object({ status: Type.Literal("fresh"), diagnostics: DiagnosticListSchema }),
  Type.Object({
    status: Type.Literal("timeout"),
    diagnostics: DiagnosticListSchema,
    waitedMs: Type.Number({ minimum: 0 }),
    remembered: Type.Boolean(),
  }),
]);
const WorkspaceDiagnosticsSchema = Type.Union([
  Type.Object({
    status: Type.Union([Type.Literal("fresh"), Type.Literal("timeout")]),
    diagnosticsByUri: Type.Array(Type.Object({ uri: Type.String(), value: DiagnosticListSchema })),
    message: Type.Optional(Type.String()),
  }),
  Type.Object({ status: Type.Literal("unsupported"), message: Type.String() }),
]);

/** The inputs of one diagnostics read's model-visible text. */
export interface LspDiagnosticsReadTextInput {
  readonly operation: LspDiagnosticsOperation;
  /** Pi's working directory; paths inside it are shown relative to it. */
  readonly cwd: string;
  /** Absolute path of the queried document, which its LSP Diagnostics refer to. */
  readonly documentPath: string;
  readonly reads: readonly LspRead[];
  readonly warnings: readonly string[];
}

/**
 * Render `path:line:col[ severity][ source(code)]: message` on one line, or a diagnostic that does
 * not match the protocol's shape as compact JSON.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- One diagnostic is opaque until it matches the diagnostic schema.
function diagnosticLine(path: string, diagnostic: unknown, cwd: string): string {
  if (!Value.Check(DiagnosticSchema, diagnostic)) return formatLspToolValue(diagnostic);
  const { severity, source, code } = diagnostic;
  const origin = code === undefined || code === null ? source : `${source ?? ""}(${code})`;
  const head = [
    lspDisplayPosition(cwd, { path, ...diagnostic.range.start }),
    severity === undefined || severity === null
      ? undefined
      : (lspSeverityName(severity) ?? `severity ${severity}`),
    origin,
  ]
    .filter((part) => part !== undefined && part !== null && part !== "")
    .join(" ");
  return `${head}: ${collapseLspWhitespace(diagnostic.message)}`;
}

/** Render a wait in whole milliseconds under a second, otherwise in seconds with at most one decimal. */
function waitText(waitedMs: number): string {
  return waitedMs < 1000 ? `${Math.round(waitedMs)}ms` : `${Number((waitedMs / 1000).toFixed(1))}s`;
}

/**
 * State what a silent wait established: the server published nothing, which for a push-only
 * server is how a clean file looks. It is not a failure, and a remembered silence is not waited
 * for again until the file changes.
 */
function silenceText(serverId: string, waitedMs: number, remembered: boolean): string {
  const wait = waitText(waitedMs);
  return remembered
    ? `no diagnostics published by ${serverId} for this unchanged file (an earlier wait of ${wait} saw none; not a failure, the file may be clean; edit the file to wait again)`
    : `no diagnostics published by ${serverId} within ${wait} (not a failure; a server that only pushes diagnostics stays silent for a clean file, so the file may be clean)`;
}

/** The lines of the queried document's read: one per LSP Diagnostic, or one saying it has none. */
function documentDiagnosticLines(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A server's normalized response is opaque until it matches the diagnostics schema.
  value: unknown,
  serverId: string,
  input: LspDiagnosticsReadTextInput,
): readonly string[] {
  if (!Value.Check(DocumentDiagnosticsSchema, value)) return [formatLspToolValue(value)];
  const path = lspDisplayPath(input.cwd, input.documentPath);
  if (value.status === "timeout") {
    return [`${path}: ${silenceText(serverId, value.waitedMs, value.remembered)}`];
  }
  if (value.diagnostics.length === 0) return [`${path}: no diagnostics`];
  return value.diagnostics.map((diagnostic) =>
    diagnosticLine(input.documentPath, diagnostic, input.cwd),
  );
}

/**
 * A workspace read's lines: the server's coverage message, if any, then one line per LSP
 * Diagnostic, then the count of files without any. A server that publishes no workspace
 * diagnostics shows only why.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A server's normalized response is opaque until it matches the workspace diagnostics schema.
function workspaceDiagnosticLines(value: unknown, cwd: string): readonly string[] {
  if (!Value.Check(WorkspaceDiagnosticsSchema, value)) return [formatLspToolValue(value)];
  if (value.status === "unsupported") return [value.message];
  const findings = value.diagnosticsByUri.flatMap((file) =>
    file.value.map((diagnostic) => diagnosticLine(file.uri, diagnostic, cwd)),
  );
  const clean = value.diagnosticsByUri.filter((file) => file.value.length === 0).length;
  let status: readonly string[] = [];
  if (value.status === "timeout") status = ["Workspace diagnostics timeout"];
  else if (value.message === undefined && value.diagnosticsByUri.length === 0) {
    status = ["No diagnostics."];
  }
  return [
    ...(value.message === undefined ? [] : [value.message]),
    ...status,
    ...findings,
    ...(clean === 0 ? [] : [`${pluralizedCount(clean, "file")}: no diagnostics`]),
  ];
}

/**
 * Render a diagnostics read as one `path:line:col severity source(code): message` line per LSP
 * Diagnostic, with one-based positions and paths relative to Pi's working directory. A queried
 * file with none is one `path: no diagnostics` line; a workspace read counts its clean files on
 * one line and starts with the server's coverage message. Results are grouped by server only when
 * more than one server answered, and server failures follow as warnings. A response or single
 * diagnostic that does not match the diagnostics shape is shown as compact JSON instead.
 */
export function formatLspDiagnosticsReadText(input: LspDiagnosticsReadTextInput): string {
  const blocks = input.reads.map((read): LspReadTextBlock => ({
    server_id: read.server_id,
    lines:
      input.operation === "diagnostics"
        ? documentDiagnosticLines(read.value, read.server_id, input)
        : workspaceDiagnosticLines(read.value, input.cwd),
  }));
  return assembleLspReadText({ blocks, warnings: input.warnings });
}
