import { type Static, type TSchema, Type } from "typebox";

/** Every LSP operation in registration order; each is registered as the Pi tool `lsp_<operation>`. */
export const LSP_OPERATION_NAMES = [
  "status",
  "capabilities",
  "restart",
  "diagnostics",
  "workspace_diagnostics",
  "completion",
  "hover",
  "signature_help",
  "declaration",
  "goto_definition",
  "goto_type_definition",
  "goto_implementation",
  "find_references",
  "document_highlights",
  "document_symbols",
  "workspace_symbols",
  "document_links",
  "call_hierarchy",
  "incoming_calls",
  "outgoing_calls",
  "type_hierarchy",
  "supertypes",
  "subtypes",
  "selection_ranges",
  "folding_ranges",
  "code_lenses",
  "inlay_hints",
  "document_colors",
  "format_document",
  "format_range",
  "format_on_type",
  "prepare_rename",
  "rename",
  "code_actions",
  "apply",
] as const;

/** One LSP operation, each registered as the Pi tool `lsp_<operation>`. */
export type LspOperationName = (typeof LSP_OPERATION_NAMES)[number];

const LspOperationNameSchema = Type.Unsafe<LspOperationName>({
  type: "string",
  enum: [...LSP_OPERATION_NAMES],
});

const MutationPreviewOperationNames = [
  "format_document",
  "format_range",
  "format_on_type",
  "rename",
  "code_actions",
] as const;

const MutationPreviewOperationNameSchema = Type.Unsafe<
  (typeof MutationPreviewOperationNames)[number]
>({
  type: "string",
  enum: [...MutationPreviewOperationNames],
});

/** One-based coordinates; described on the field so they reach the model with any system prompt. */
const LineSchema = Type.Integer({ minimum: 1, description: "1-based" });
const CharacterSchema = Type.Integer({ minimum: 1, description: "1-based Unicode code point" });

const OneBasedPositionSchema = Type.Object(
  { line: LineSchema, character: CharacterSchema },
  { additionalProperties: false },
);

const OneBasedRangeSchema = Type.Object(
  {
    start: OneBasedPositionSchema,
    end: OneBasedPositionSchema,
  },
  { additionalProperties: false },
);

const FilePathSchema = Type.String({ minLength: 1 });
/** A file that selects the Server Instance (and so the workspace root) for a workspace-wide call. */
const RootAnchorPathSchema = Type.String({
  minLength: 1,
  description: "Any file in the workspace; selects the server and its root",
});
const ServerIdSchema = Type.String({ minLength: 1 });
/** Items returned per server when a completion or workspace-symbol call names no `limit`. */
export const DEFAULT_LSP_ITEM_LIMIT = 50;
/** Most items each server returns to a completion or workspace-symbol call. */
const ItemLimitSchema = Type.Optional(
  Type.Integer({
    minimum: 1,
    description: `Most items per server (default ${DEFAULT_LSP_ITEM_LIMIT})`,
  }),
);
const OptionalServerIdSchema = Type.Optional(ServerIdSchema);
const FormattingOptionsSchema = {
  tab_size: Type.Integer({ minimum: 1 }),
  insert_spaces: Type.Boolean(),
  trim_trailing_whitespace: Type.Optional(Type.Boolean()),
  insert_final_newline: Type.Optional(Type.Boolean()),
  trim_final_newlines: Type.Optional(Type.Boolean()),
};

const AbsolutePathSchema = Type.String({
  minLength: 1,
  pattern: "^(?:/|[A-Za-z]:[\\\\/])",
});
/** One exact absolute-path file operation in a canonical Mutation Manifest. */
export const MutationManifestEntrySchema = Type.Union([
  Type.Object(
    {
      operation: Type.Literal("create"),
      path: AbsolutePathSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("modify"),
      path: AbsolutePathSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("delete"),
      path: AbsolutePathSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("rename"),
      path: AbsolutePathSchema,
      destination_path: AbsolutePathSchema,
    },
    { additionalProperties: false },
  ),
]);

/** Canonical absolute-path file operations prepared before an `lsp_apply` call. */
export const MutationManifestSchema = Type.Array(MutationManifestEntrySchema);

function fileParametersSchema() {
  return Type.Object(
    { file_path: FilePathSchema, server_id: OptionalServerIdSchema },
    { additionalProperties: false },
  );
}

function positionParametersSchema() {
  return Type.Object(
    {
      file_path: FilePathSchema,
      line: LineSchema,
      character: CharacterSchema,
      server_id: OptionalServerIdSchema,
    },
    { additionalProperties: false },
  );
}

function serverParametersSchema() {
  return Type.Object(
    { server_id: ServerIdSchema, file_path: RootAnchorPathSchema },
    { additionalProperties: false },
  );
}

/**
 * Strict parameters of each `lsp_<operation>` tool, in registration order. Each tool's provider
 * schema is exactly its own object, so no per-operation requirement table is needed.
 * Coordinates are one-based Unicode code points.
 */
export const LspOperationParametersSchemas = {
  status: Type.Object({}, { additionalProperties: false }),
  capabilities: serverParametersSchema(),
  restart: serverParametersSchema(),
  diagnostics: fileParametersSchema(),
  workspace_diagnostics: serverParametersSchema(),
  completion: Type.Object(
    {
      file_path: FilePathSchema,
      line: LineSchema,
      character: CharacterSchema,
      prefix: Type.Optional(
        Type.String({
          description:
            'Keep items starting with this, ignoring case; defaults to the identifier before the position, and "" keeps all',
        }),
      ),
      limit: ItemLimitSchema,
      server_id: OptionalServerIdSchema,
    },
    { additionalProperties: false },
  ),
  hover: positionParametersSchema(),
  signature_help: positionParametersSchema(),
  declaration: positionParametersSchema(),
  goto_definition: positionParametersSchema(),
  goto_type_definition: positionParametersSchema(),
  goto_implementation: positionParametersSchema(),
  find_references: Type.Object(
    {
      file_path: FilePathSchema,
      line: LineSchema,
      character: CharacterSchema,
      include_declaration: Type.Optional(Type.Boolean()),
      server_id: OptionalServerIdSchema,
    },
    { additionalProperties: false },
  ),
  document_highlights: positionParametersSchema(),
  document_symbols: fileParametersSchema(),
  workspace_symbols: Type.Object(
    {
      query: Type.String(),
      file_path: RootAnchorPathSchema,
      limit: ItemLimitSchema,
      server_id: OptionalServerIdSchema,
    },
    { additionalProperties: false },
  ),
  document_links: fileParametersSchema(),
  call_hierarchy: positionParametersSchema(),
  incoming_calls: positionParametersSchema(),
  outgoing_calls: positionParametersSchema(),
  type_hierarchy: positionParametersSchema(),
  supertypes: positionParametersSchema(),
  subtypes: positionParametersSchema(),
  selection_ranges: Type.Object(
    {
      file_path: FilePathSchema,
      positions: Type.Array(OneBasedPositionSchema, { minItems: 1 }),
      server_id: OptionalServerIdSchema,
    },
    { additionalProperties: false },
  ),
  folding_ranges: fileParametersSchema(),
  code_lenses: fileParametersSchema(),
  inlay_hints: Type.Object(
    {
      file_path: FilePathSchema,
      range: OneBasedRangeSchema,
      server_id: OptionalServerIdSchema,
    },
    { additionalProperties: false },
  ),
  document_colors: fileParametersSchema(),
  format_document: Type.Object(
    {
      file_path: FilePathSchema,
      server_id: OptionalServerIdSchema,
      ...FormattingOptionsSchema,
    },
    { additionalProperties: false },
  ),
  format_range: Type.Object(
    {
      file_path: FilePathSchema,
      range: OneBasedRangeSchema,
      server_id: OptionalServerIdSchema,
      ...FormattingOptionsSchema,
    },
    { additionalProperties: false },
  ),
  format_on_type: Type.Object(
    {
      file_path: FilePathSchema,
      line: LineSchema,
      character: CharacterSchema,
      trigger_character: Type.String({ minLength: 1 }),
      server_id: OptionalServerIdSchema,
      ...FormattingOptionsSchema,
    },
    { additionalProperties: false },
  ),
  prepare_rename: positionParametersSchema(),
  rename: Type.Object(
    {
      file_path: FilePathSchema,
      line: LineSchema,
      character: CharacterSchema,
      new_name: Type.String({ minLength: 1 }),
      server_id: OptionalServerIdSchema,
    },
    { additionalProperties: false },
  ),
  code_actions: Type.Object(
    {
      file_path: FilePathSchema,
      range: OneBasedRangeSchema,
      only_kinds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
      server_id: OptionalServerIdSchema,
    },
    { additionalProperties: false },
  ),
  apply: Type.Object(
    {
      preview_id: Type.String({ minLength: 1 }),
      mutation_manifest: Type.Optional(
        Type.Array(MutationManifestEntrySchema, {
          description: "Set from the preview before the call runs; a supplied value is replaced",
        }),
      ),
    },
    { additionalProperties: false },
  ),
} as const satisfies Record<LspOperationName, TSchema>;

/** Arguments of one `lsp_<operation>` tool after TypeBox validation. */
export type LspOperationParameters<TOperation extends LspOperationName> = Static<
  (typeof LspOperationParametersSchemas)[TOperation]
>;

/** One operation call: the operation name plus that tool's validated arguments. */
export type LspToolParameters = {
  [TOperation in LspOperationName]: {
    readonly operation: TOperation;
  } & LspOperationParameters<TOperation>;
}[LspOperationName];

/** The Pi tool name registered for one LSP operation. */
export function lspToolName(operation: LspOperationName): string {
  return `lsp_${operation}`;
}

/** The removed single tool whose results remain in session history (ADR-0003). */
export const LEGACY_LSP_TOOL_NAME = "lsp";

/** Tool names whose results Pi LSP recognizes in session history: the legacy tool and every current tool. */
export const LSP_RESULT_TOOL_NAMES: ReadonlySet<string> = new Set([
  LEGACY_LSP_TOOL_NAME,
  ...LSP_OPERATION_NAMES.map(lspToolName),
]);

/** Tool names whose results report a guarded Workspace Edit application. */
export const LSP_APPLY_RESULT_TOOL_NAMES: ReadonlySet<string> = new Set([
  LEGACY_LSP_TOOL_NAME,
  lspToolName("apply"),
]);

/** One canonical Mutation Manifest operation exposed to pre-execution permission hooks. */
export type MutationManifestEntry = Static<typeof MutationManifestEntrySchema>;

/** The canonical absolute-path Mutation Manifest prepared for an `lsp_apply` call. */
export type MutationManifest = Static<typeof MutationManifestSchema>;

const ServerOperationOutcomeSchema = Type.Object(
  {
    server_id: ServerIdSchema,
    outcome: Type.Union([
      Type.Literal("success"),
      Type.Literal("unavailable"),
      Type.Literal("timeout"),
      Type.Literal("unsupported"),
      Type.Literal("error"),
    ]),
    message: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const MissingFileSnapshotSchema = Type.Object(
  { kind: Type.Literal("missing") },
  { additionalProperties: false },
);
const RegularFileSnapshotSchema = Type.Object(
  {
    kind: Type.Literal("file"),
    content_base64: Type.String(),
    mode: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const SymlinkSnapshotSchema = Type.Object(
  {
    kind: Type.Literal("symlink"),
    link_target: Type.String(),
    mode: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
/** Canonical pre-mutation snapshot of one filesystem path used by guarded rollback. */
export const FileSnapshotSchema = Type.Union([
  MissingFileSnapshotSchema,
  RegularFileSnapshotSchema,
  SymlinkSnapshotSchema,
]);
export const ExistingFileSnapshotSchema = Type.Union([
  RegularFileSnapshotSchema,
  SymlinkSnapshotSchema,
]);
export const WorkspaceEditOperationSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("modify"),
      named_path: AbsolutePathSchema,
      path: AbsolutePathSchema,
      named_before: FileSnapshotSchema,
      before: ExistingFileSnapshotSchema,
      after_base64: Type.String(),
      mode: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("create"),
      named_path: AbsolutePathSchema,
      before: FileSnapshotSchema,
      after_base64: Type.String(),
      mode: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("delete"),
      named_path: AbsolutePathSchema,
      before: ExistingFileSnapshotSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("rename"),
      named_path: AbsolutePathSchema,
      destination_path: AbsolutePathSchema,
      before: ExistingFileSnapshotSchema,
      destination_before: FileSnapshotSchema,
    },
    { additionalProperties: false },
  ),
]);

/** Persisted branch-local Workspace Edit Preview state required for guarded replay. */
export const LspWorkspaceEditPreviewRecordSchema = Type.Object(
  {
    kind: Type.Literal("workspace_edit_preview"),
    preview_id: Type.String({ minLength: 1 }),
    server_id: ServerIdSchema,
    summary: Type.String(),
    state: Type.Union([Type.Literal("available"), Type.Literal("applied")]),
    operations: Type.Array(WorkspaceEditOperationSchema),
  },
  { additionalProperties: false },
);

const LspToolOperationDetailsSchema = Type.Object(
  {
    kind: Type.Literal("operation"),
    operation: LspOperationNameSchema,
    server_outcomes: Type.Array(ServerOperationOutcomeSchema),
    preview_records: Type.Optional(Type.Array(LspWorkspaceEditPreviewRecordSchema)),
    spill_path: Type.Optional(AbsolutePathSchema),
    /** Item count for transcript rendering when the model-visible text is not JSON. */
    result_count: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const WorkspaceEditPreviewDetailsSchema = Type.Object(
  {
    kind: Type.Literal("workspace_edit_preview"),
    preview_id: Type.String({ minLength: 1 }),
    operation: MutationPreviewOperationNameSchema,
    summary: Type.String(),
    mutation_manifest: MutationManifestSchema,
    preview_record: LspWorkspaceEditPreviewRecordSchema,
    preview_records: Type.Optional(Type.Array(LspWorkspaceEditPreviewRecordSchema)),
    state: Type.Union([Type.Literal("available"), Type.Literal("applied")]),
  },
  { additionalProperties: false },
);

const WorkspaceEditApplyDetailsSchema = Type.Object(
  {
    kind: Type.Literal("workspace_edit_apply"),
    preview_id: Type.String({ minLength: 1 }),
    mutation_manifest: MutationManifestSchema,
    changed_paths: Type.Array(AbsolutePathSchema),
    preview_records: Type.Optional(Type.Array(LspWorkspaceEditPreviewRecordSchema)),
    state: Type.Union([Type.Literal("applied"), Type.Literal("partial_failure")]),
  },
  { additionalProperties: false },
);

/** Normalized tool-result details retained for rendering, session replay, and guarded application. */
export const LspToolResultDetailsSchema = Type.Union([
  LspToolOperationDetailsSchema,
  WorkspaceEditPreviewDetailsSchema,
  WorkspaceEditApplyDetailsSchema,
]);

/** One schema-validated LSP tool result detail shape with no raw protocol payload. */
export type LspToolResultDetails = Static<typeof LspToolResultDetailsSchema>;

/** One schema-validated Workspace Edit Preview replay record. */
export type LspWorkspaceEditPreviewRecord = Static<typeof LspWorkspaceEditPreviewRecordSchema>;

/** A normalized per-server outcome used when rendering an LSP read operation. */
export type ServerOperationOutcome = Static<typeof ServerOperationOutcomeSchema>;

/**
 * Fields every structured LSP result carries. Pi keeps the structured result out of model context
 * and session history, so the model-facing output limit does not apply; it has its own 1 MiB cap,
 * beyond which the result is bounded. `truncated` reports that the model-visible text was cut or
 * the structured result was bounded, `structured_truncated` reports that the structured data itself is incomplete, not just the
 * model-visible text, and `spill_path` names the Result Spill holding the complete output (the complete
 * structured data when it was bounded, otherwise the complete text).
 */
const StructuredResultEnvelope = {
  truncated: Type.Boolean(),
  structured_truncated: Type.Boolean(),
  spill_path: Type.Optional(Type.String()),
  server_preview_ids: Type.Optional(Type.Array(Type.String())),
};

/** Compact output shape of a Mutation Manifest entry; the strict input schema is a union. */
const MutationManifestOutputSchema = Type.Array(
  Type.Object({
    operation: Type.Union([
      Type.Literal("create"),
      Type.Literal("modify"),
      Type.Literal("delete"),
      Type.Literal("rename"),
    ]),
    path: Type.String(),
    destination_path: Type.Optional(Type.String()),
  }),
);

/**
 * Structured result of every read query: each answering server's normalized protocol value.
 * Completion and workspace-symbol values hold only the items kept by the prefix and limit.
 */
export const LspReadOutputSchema = Type.Object({
  results: Type.Array(
    Type.Object({
      server_id: Type.String(),
      root_path: Type.String(),
      value: Type.Unknown(),
      prefix: Type.Optional(
        Type.String({ description: "The prefix completions were filtered by" }),
      ),
      omitted: Type.Optional(
        Type.Integer({ minimum: 0, description: "Matching items left out by the limit" }),
      ),
    }),
  ),
  warnings: Type.Array(Type.String()),
  ...StructuredResultEnvelope,
});

/** Structured result of `lsp_status`. */
export const LspStatusOutputSchema = Type.Object({
  servers: Type.Array(
    Type.Object({
      server_id: Type.String(),
      state: Type.Union([
        Type.Literal("configured"),
        Type.Literal("disabled"),
        Type.Literal("running"),
        Type.Literal("starting"),
        Type.Literal("stopped"),
        Type.Literal("unavailable"),
      ]),
      root_path: Type.Optional(Type.String()),
      error: Type.Optional(Type.String()),
      languages: Type.Record(Type.String(), Type.Array(Type.String()), {
        description:
          "Language ID to the file extensions and exact filenames the Server Definition handles",
      }),
    }),
  ),
  warnings: Type.Array(Type.String()),
  ...StructuredResultEnvelope,
});

/** Structured result of `lsp_capabilities` and `lsp_restart`. */
export const LspServerOutputSchema = Type.Object({
  server_id: Type.String(),
  root_path: Type.String(),
  capabilities: Type.Unknown(),
  ...StructuredResultEnvelope,
});

/** Structured result of a tool that creates one Workspace Edit Preview. */
export const LspPreviewOutputSchema = Type.Object({
  preview_id: Type.String(),
  server_id: Type.String(),
  root_path: Type.String(),
  summary: Type.String(),
  warnings: Type.Array(Type.String()),
  mutation_manifest: MutationManifestOutputSchema,
  ...StructuredResultEnvelope,
});

/**
 * Structured result of `lsp_code_actions`: the actions of every answering server, each naming its
 * server, and labeled failures of the others. Edit-bearing actions carry a preview.
 */
export const LspCodeActionsOutputSchema = Type.Object({
  actions: Type.Array(
    Type.Object({
      server_id: Type.String(),
      title: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      applicable: Type.Boolean(),
      preview_id: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String()),
      mutation_manifest: Type.Optional(MutationManifestOutputSchema),
      command: Type.Optional(Type.Unknown()),
    }),
  ),
  warnings: Type.Array(Type.String()),
  ...StructuredResultEnvelope,
});

/** Structured result of `lsp_apply`, including a partial failure reported with `isError`. */
export const LspApplyOutputSchema = Type.Object({
  preview_id: Type.String(),
  state: Type.Union([Type.Literal("applied"), Type.Literal("partial_failure")]),
  changed_paths: Type.Array(Type.String()),
  mutation_manifest: MutationManifestOutputSchema,
  changed_files: Type.Optional(Type.Array(Type.String())),
  created_files: Type.Optional(Type.Array(Type.String())),
  deleted_files: Type.Optional(Type.Array(Type.String())),
  moved_files: Type.Optional(Type.Array(Type.Object({ from: Type.String(), to: Type.String() }))),
  message: Type.Optional(Type.String()),
  ...StructuredResultEnvelope,
});
