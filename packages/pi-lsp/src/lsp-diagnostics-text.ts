import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  assembleLspReadText,
  lspDisplayPath,
  lspDisplayPosition,
  LspNormalizedPositionSchema,
  type LspRead,
  type LspReadTextBlock,
} from "./lsp-location-text.js";
import { lspSeverityName } from "./lsp-post-edit-diagnostics.js";
import { formatLspToolValue } from "./lsp-tool-output.js";

const DiagnosticSchema = Type.Object({
  range: Type.Object({ start: LspNormalizedPositionSchema }),
  message: Type.String(),
  severity: Type.Optional(Type.Integer()),
  source: Type.Optional(Type.String()),
  code: Type.Optional(Type.Union([Type.String(), Type.Integer()])),
});
const DocumentDiagnosticsSchema = Type.Object({
  status: Type.Union([Type.Literal("fresh"), Type.Literal("timeout")]),
  diagnostics: Type.Array(DiagnosticSchema),
});

const WorkspaceDiagnosticsSchema = Type.Union([
  Type.Object({
    status: Type.Union([Type.Literal("fresh"), Type.Literal("timeout")]),
    diagnosticsByUri: Type.Array(
      Type.Object({ uri: Type.String(), value: Type.Array(DiagnosticSchema) }),
    ),
    message: Type.Optional(Type.String()),
  }),
  Type.Object({ status: Type.Literal("unsupported"), message: Type.String() }),
]);

type LspTextDiagnostic = Static<typeof DiagnosticSchema>;

/** The inputs of one diagnostics read's model-visible text. */
export interface LspDiagnosticsReadTextInput {
  readonly operation: "diagnostics" | "workspace_diagnostics";
  /** Pi's working directory; paths inside it are shown relative to it. */
  readonly cwd: string;
  /** Absolute path of the queried document, which its LSP Diagnostics refer to. */
  readonly documentPath: string;
  readonly reads: readonly LspRead[];
  readonly warnings: readonly string[];
}

/** Render `path:line:col[ severity][ source(code)]: message` on one line. */
function diagnosticLine(path: string, diagnostic: LspTextDiagnostic, cwd: string): string {
  const { severity, source, code } = diagnostic;
  const origin = code === undefined ? source : `${source ?? ""}(${code})`;
  const head = [
    lspDisplayPosition(cwd, { path, ...diagnostic.range.start }),
    severity === undefined ? undefined : (lspSeverityName(severity) ?? `severity ${severity}`),
    origin,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return `${head}: ${diagnostic.message.replaceAll(/\s+/gu, " ").trim()}`;
}

/** One file's lines: a line per LSP Diagnostic, or one line saying it has none. */
function fileLines(
  path: string,
  diagnostics: readonly LspTextDiagnostic[],
  cwd: string,
): readonly string[] {
  if (diagnostics.length === 0) return [`${lspDisplayPath(cwd, path)}: no diagnostics`];
  return diagnostics.map((diagnostic) => diagnosticLine(path, diagnostic, cwd));
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A server's normalized response is opaque until it matches the diagnostics schema.
function documentLines(value: unknown, input: LspDiagnosticsReadTextInput): readonly string[] {
  if (!Value.Check(DocumentDiagnosticsSchema, value)) return [formatLspToolValue(value)];
  if (value.status === "timeout") {
    return [`${lspDisplayPath(input.cwd, input.documentPath)}: diagnostics timeout`];
  }
  return fileLines(input.documentPath, value.diagnostics, input.cwd);
}

/**
 * A workspace read's lines: the server's coverage message, if any, then every file's lines. A
 * server that publishes no workspace diagnostics shows only why.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A server's normalized response is opaque until it matches the workspace diagnostics schema.
function workspaceLines(value: unknown, cwd: string): readonly string[] {
  if (!Value.Check(WorkspaceDiagnosticsSchema, value)) return [formatLspToolValue(value)];
  if (value.status === "unsupported") return [value.message];
  const files = value.diagnosticsByUri.flatMap((file) => fileLines(file.uri, file.value, cwd));
  let status: readonly string[] = [];
  if (value.status === "timeout") status = ["Workspace diagnostics timeout"];
  else if (value.message === undefined && files.length === 0) status = ["No diagnostics."];
  return [...(value.message === undefined ? [] : [value.message]), ...status, ...files];
}

/**
 * Render a diagnostics read as one `path:line:col severity source(code): message` line per LSP
 * Diagnostic, with one-based positions and paths relative to Pi's working directory. A file with
 * none is one `path: no diagnostics` line. Results are grouped by server only when more than one
 * server answered, and server failures follow as warnings. A workspace read also shows the
 * server's coverage message. A response that does not match the diagnostics shape is shown as
 * compact JSON instead.
 */
export function formatLspDiagnosticsReadText(input: LspDiagnosticsReadTextInput): string {
  const blocks = input.reads.map((read): LspReadTextBlock => ({
    server_id: read.server_id,
    lines:
      input.operation === "diagnostics"
        ? documentLines(read.value, input)
        : workspaceLines(read.value, input.cwd),
  }));
  return assembleLspReadText({ blocks, warnings: input.warnings });
}
