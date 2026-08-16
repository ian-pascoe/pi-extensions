import { type Static, Type } from "typebox";

const LSP_OPERATION_NAMES = [
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

const MutationPreviewOperationNames = [
  "format_document",
  "format_range",
  "format_on_type",
  "rename",
  "code_actions",
] as const;

const LspOperationNameSchema = Type.Unsafe<(typeof LSP_OPERATION_NAMES)[number]>({
  type: "string",
  enum: [...LSP_OPERATION_NAMES],
});
const MutationPreviewOperationNameSchema = Type.Unsafe<
  (typeof MutationPreviewOperationNames)[number]
>({
  type: "string",
  enum: [...MutationPreviewOperationNames],
});

const OneBasedPositionSchema = Type.Object(
  {
    line: Type.Integer({ minimum: 1 }),
    character: Type.Integer({ minimum: 1 }),
  },
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
const ServerIdSchema = Type.String({ minLength: 1 });
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

/** Canonical absolute-path file operations prepared before an LSP `apply` call. */
export const MutationManifestSchema = Type.Array(MutationManifestEntrySchema);

function fileOperationSchema<const TOperation extends (typeof LSP_OPERATION_NAMES)[number]>(
  operation: TOperation,
) {
  return Type.Object(
    {
      operation: Type.Literal(operation),
      file_path: FilePathSchema,
      server_id: OptionalServerIdSchema,
    },
    { additionalProperties: false },
  );
}

function positionOperationSchema<const TOperation extends (typeof LSP_OPERATION_NAMES)[number]>(
  operation: TOperation,
) {
  return Type.Object(
    {
      operation: Type.Literal(operation),
      file_path: FilePathSchema,
      line: Type.Integer({ minimum: 1 }),
      character: Type.Integer({ minimum: 1 }),
      server_id: OptionalServerIdSchema,
    },
    { additionalProperties: false },
  );
}

/** Strict arguments accepted by the single Pi `lsp` tool. Coordinates are one-based Unicode code points. */
export const LspToolParametersSchema = Type.Union([
  Type.Object({ operation: Type.Literal("status") }, { additionalProperties: false }),
  Type.Object(
    {
      operation: Type.Literal("capabilities"),
      server_id: ServerIdSchema,
      file_path: FilePathSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("restart"),
      server_id: ServerIdSchema,
      file_path: FilePathSchema,
    },
    { additionalProperties: false },
  ),
  fileOperationSchema("diagnostics"),
  Type.Object(
    {
      operation: Type.Literal("workspace_diagnostics"),
      server_id: ServerIdSchema,
      file_path: FilePathSchema,
    },
    { additionalProperties: false },
  ),
  positionOperationSchema("completion"),
  positionOperationSchema("hover"),
  positionOperationSchema("signature_help"),
  positionOperationSchema("declaration"),
  positionOperationSchema("goto_definition"),
  positionOperationSchema("goto_type_definition"),
  positionOperationSchema("goto_implementation"),
  Type.Object(
    {
      operation: Type.Literal("find_references"),
      file_path: FilePathSchema,
      line: Type.Integer({ minimum: 1 }),
      character: Type.Integer({ minimum: 1 }),
      include_declaration: Type.Optional(Type.Boolean()),
      server_id: OptionalServerIdSchema,
    },
    { additionalProperties: false },
  ),
  positionOperationSchema("document_highlights"),
  fileOperationSchema("document_symbols"),
  Type.Object(
    {
      operation: Type.Literal("workspace_symbols"),
      query: Type.String(),
      file_path: FilePathSchema,
      server_id: OptionalServerIdSchema,
    },
    { additionalProperties: false },
  ),
  fileOperationSchema("document_links"),
  positionOperationSchema("call_hierarchy"),
  positionOperationSchema("incoming_calls"),
  positionOperationSchema("outgoing_calls"),
  positionOperationSchema("type_hierarchy"),
  positionOperationSchema("supertypes"),
  positionOperationSchema("subtypes"),
  Type.Object(
    {
      operation: Type.Literal("selection_ranges"),
      file_path: FilePathSchema,
      positions: Type.Array(OneBasedPositionSchema, { minItems: 1 }),
      server_id: OptionalServerIdSchema,
    },
    { additionalProperties: false },
  ),
  fileOperationSchema("folding_ranges"),
  fileOperationSchema("code_lenses"),
  Type.Object(
    {
      operation: Type.Literal("inlay_hints"),
      file_path: FilePathSchema,
      range: OneBasedRangeSchema,
      server_id: OptionalServerIdSchema,
    },
    { additionalProperties: false },
  ),
  fileOperationSchema("document_colors"),
  Type.Object(
    {
      operation: Type.Literal("format_document"),
      file_path: FilePathSchema,
      server_id: OptionalServerIdSchema,
      ...FormattingOptionsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("format_range"),
      file_path: FilePathSchema,
      range: OneBasedRangeSchema,
      server_id: OptionalServerIdSchema,
      ...FormattingOptionsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("format_on_type"),
      file_path: FilePathSchema,
      line: Type.Integer({ minimum: 1 }),
      character: Type.Integer({ minimum: 1 }),
      trigger_character: Type.String({ minLength: 1 }),
      server_id: OptionalServerIdSchema,
      ...FormattingOptionsSchema,
    },
    { additionalProperties: false },
  ),
  positionOperationSchema("prepare_rename"),
  Type.Object(
    {
      operation: Type.Literal("rename"),
      file_path: FilePathSchema,
      line: Type.Integer({ minimum: 1 }),
      character: Type.Integer({ minimum: 1 }),
      new_name: Type.String({ minLength: 1 }),
      server_id: OptionalServerIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("code_actions"),
      file_path: FilePathSchema,
      range: OneBasedRangeSchema,
      only_kinds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
      server_id: OptionalServerIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("apply"),
      preview_id: Type.String({ minLength: 1 }),
      mutation_manifest: Type.Optional(MutationManifestSchema),
    },
    { additionalProperties: false },
  ),
]);

/** One valid input branch for the Pi LSP tool after TypeBox validation. */
export type LspToolParameters = Static<typeof LspToolParametersSchema>;

/** One canonical Mutation Manifest operation exposed to pre-execution permission hooks. */
export type MutationManifestEntry = Static<typeof MutationManifestEntrySchema>;

/** The canonical absolute-path Mutation Manifest prepared for an LSP `apply` call. */
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
    hash: Type.String({ minLength: 64, maxLength: 64 }),
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
const FileSnapshotSchema = Type.Union([
  MissingFileSnapshotSchema,
  RegularFileSnapshotSchema,
  SymlinkSnapshotSchema,
]);
const ExistingFileSnapshotSchema = Type.Union([RegularFileSnapshotSchema, SymlinkSnapshotSchema]);
const WorkspaceEditOperationSchema = Type.Union([
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
    recovery_failure_paths: Type.Optional(Type.Array(AbsolutePathSchema)),
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

/** A persisted Workspace Edit Preview that can be rebuilt from the active session branch. */
export type WorkspaceEditPreviewDetails = Static<typeof WorkspaceEditPreviewDetailsSchema>;

/** The result of applying one guarded Workspace Edit Preview. */
export type WorkspaceEditApplyDetails = Static<typeof WorkspaceEditApplyDetailsSchema>;
