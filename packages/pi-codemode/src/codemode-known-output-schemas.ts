import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { CodeModeToolSchema } from "./codemode-tool-catalog.js";

const ClosedObject = { additionalProperties: false } as const;
const OptionalUndefinedString = Type.Optional(Type.Union([Type.String(), Type.Undefined()]));
const OptionalUndefinedNumber = Type.Optional(Type.Union([Type.Number(), Type.Undefined()]));

const TruncationResultSchema = Type.Object(
  {
    content: Type.String(),
    truncated: Type.Boolean(),
    truncatedBy: Type.Union([Type.Literal("lines"), Type.Literal("bytes"), Type.Null()]),
    totalLines: Type.Number(),
    totalBytes: Type.Number(),
    outputLines: Type.Number(),
    outputBytes: Type.Number(),
    lastLinePartial: Type.Boolean(),
    firstLineExceedsLimit: Type.Boolean(),
    maxLines: Type.Number(),
    maxBytes: Type.Number(),
  },
  ClosedObject,
);
const ShellOutputSchema = Type.Object(
  {
    truncation: Type.Optional(TruncationResultSchema),
    fullOutputPath: Type.Optional(Type.String()),
  },
  ClosedObject,
);
const ReadOutputSchema = Type.Object(
  { truncation: Type.Optional(TruncationResultSchema) },
  ClosedObject,
);
const EditOutputSchema = Type.Object(
  {
    diff: Type.String(),
    patch: Type.String(),
    firstChangedLine: Type.Optional(Type.Number()),
  },
  ClosedObject,
);
const GrepOutputSchema = Type.Object(
  {
    truncation: Type.Optional(TruncationResultSchema),
    matchLimitReached: Type.Optional(Type.Number()),
    linesTruncated: Type.Optional(Type.Boolean()),
  },
  ClosedObject,
);
const FindOutputSchema = Type.Object(
  {
    truncation: Type.Optional(TruncationResultSchema),
    resultLimitReached: Type.Optional(Type.Number()),
  },
  ClosedObject,
);
const LsOutputSchema = Type.Object(
  {
    truncation: Type.Optional(TruncationResultSchema),
    entryLimitReached: Type.Optional(Type.Number()),
  },
  ClosedObject,
);

const ExecutePatchResultSchema = Type.Object(
  {
    changedFiles: Type.Array(Type.String()),
    createdFiles: Type.Array(Type.String()),
    deletedFiles: Type.Array(Type.String()),
    movedFiles: Type.Array(Type.String()),
    fuzz: Type.Number(),
  },
  ClosedObject,
);
const ApplyPatchOutputSchema = Type.Union([
  Type.Object({ status: Type.Literal("success"), result: ExecutePatchResultSchema }, ClosedObject),
  Type.Object(
    {
      status: Type.Literal("partial_failure"),
      result: ExecutePatchResultSchema,
      failedTargets: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
    },
    ClosedObject,
  ),
]);
const UnifiedExecOutputSchema = Type.Object(
  {
    chunk_id: Type.String(),
    wall_time_seconds: Type.Number(),
    output: Type.String(),
    exit_code: OptionalUndefinedNumber,
    session_id: OptionalUndefinedNumber,
    original_token_count: OptionalUndefinedNumber,
  },
  ClosedObject,
);
const ImagegenOutputSchema = Type.Object(
  {
    path: Type.String(),
    latest_path: Type.String(),
    images: Type.Array(
      Type.Object(
        {
          path: Type.String(),
          absolute_path: Type.String(),
          latest_path: Type.Optional(Type.String()),
          latest_absolute_path: Type.Optional(Type.String()),
        },
        ClosedObject,
      ),
    ),
    background: OptionalUndefinedString,
    quality: OptionalUndefinedString,
    size: OptionalUndefinedString,
  },
  ClosedObject,
);
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SAFETY: pi-codex-conversion intentionally exposes provider-defined web_run fields alongside these known text fields.
type CodexWebRunPayload = Record<string, unknown> & {
  encrypted_output?: string | undefined;
  output_text?: string | undefined;
  output?: string | undefined;
  text?: string | undefined;
};
const WebRunPayloadSchema = Type.Unsafe<CodexWebRunPayload>(
  Type.Object(
    {
      encrypted_output: OptionalUndefinedString,
      output_text: OptionalUndefinedString,
      output: OptionalUndefinedString,
      text: OptionalUndefinedString,
    },
    { additionalProperties: true },
  ),
);
const WebRunOutputSchema = Type.Object({ webRun: WebRunPayloadSchema }, ClosedObject);
const ViewImageContentSchema = Type.Object(
  {
    type: Type.Literal("image"),
    data: Type.String(),
    mimeType: Type.String(),
    detail: Type.Union([Type.Literal("high"), Type.Literal("original")]),
  },
  ClosedObject,
);
const ViewImageOutputSchema = Type.Union([
  Type.Object({ viewImage: Type.Literal(true) }, ClosedObject),
  Type.Object(
    {
      viewImageDescription: Type.Object(
        {
          image: ViewImageContentSchema,
          path: Type.String(),
          description: Type.String(),
        },
        ClosedObject,
      ),
    },
    ClosedObject,
  ),
]);

/** Source-gated fallback output schemas for Pi and pi-codex-conversion tool details. */
export const CodeModeKnownOutputSchemas = {
  builtin: {
    bash: ShellOutputSchema,
    powershell: ShellOutputSchema,
    read: ReadOutputSchema,
    edit: EditOutputSchema,
    write: Type.Undefined(),
    grep: GrepOutputSchema,
    find: FindOutputSchema,
    ls: LsOutputSchema,
  },
  codexConversion: {
    apply_patch: ApplyPatchOutputSchema,
    exec_command: UnifiedExecOutputSchema,
    write_stdin: UnifiedExecOutputSchema,
    view_image: ViewImageOutputSchema,
    web_run: WebRunOutputSchema,
    imagegen: ImagegenOutputSchema,
  },
} as const satisfies {
  readonly builtin: Readonly<Record<string, TSchema>>;
  readonly codexConversion: Readonly<Record<string, TSchema>>;
};

const CODEX_CONVERSION_SOURCE = "npm:@howaboua/pi-codex-conversion";

function schemaByName(
  schemas: Readonly<Record<string, TSchema>>,
  name: string,
): TSchema | undefined {
  return schemas[name];
}

function isCodexConversionSource(sourceInfo: ToolInfo["sourceInfo"]): boolean {
  return (
    sourceInfo.origin === "package" &&
    (sourceInfo.source === CODEX_CONVERSION_SOURCE ||
      sourceInfo.source.startsWith(`${CODEX_CONVERSION_SOURCE}@`))
  );
}

/** Returns a known output schema only when both the registered tool name and owner match. */
export function resolveKnownToolOutputSchema(
  tool: Pick<ToolInfo, "name" | "sourceInfo">,
): CodeModeToolSchema | undefined {
  if (
    tool.sourceInfo.source === "builtin" &&
    tool.sourceInfo.path === `<builtin:${tool.name}>` &&
    tool.sourceInfo.scope === "temporary" &&
    tool.sourceInfo.origin === "top-level"
  ) {
    return schemaByName(CodeModeKnownOutputSchemas.builtin, tool.name);
  }
  return isCodexConversionSource(tool.sourceInfo)
    ? schemaByName(CodeModeKnownOutputSchemas.codexConversion, tool.name)
    : undefined;
}
