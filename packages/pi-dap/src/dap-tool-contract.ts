import { type Static, Type } from "typebox";

const NonEmptyStringSchema = Type.String({ minLength: 1 });
const DapIdSchema = Type.Integer({ minimum: 0 });
const DapPresentationStringSchema = Type.String({ maxLength: 500 });
const EmptyOperationSchema = <TOperation extends string>(operation: TOperation) =>
  Type.Object({ operation: Type.Literal(operation) }, { additionalProperties: false });

const LaunchParametersSchema = Type.Object(
  {
    operation: Type.Literal("launch"),
    profile: Type.Optional(NonEmptyStringSchema),
    program: Type.Optional(NonEmptyStringSchema),
    args: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);
const SetBreakpointsParametersSchema = Type.Object(
  {
    operation: Type.Literal("set_breakpoints"),
    file_path: NonEmptyStringSchema,
    breakpoints: Type.Array(
      Type.Object(
        { line: Type.Integer({ minimum: 1 }), condition: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const StackParametersSchema = Type.Object(
  {
    operation: Type.Literal("stack"),
    thread_id: Type.Optional(DapIdSchema),
    start: Type.Optional(Type.Integer({ minimum: 0 })),
    count: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
const VariablesPageSchema = {
  start: Type.Optional(Type.Integer({ minimum: 0 })),
  count: Type.Optional(Type.Integer({ minimum: 1 })),
};
const VariablesParametersSchema = Type.Union([
  Type.Object(
    { operation: Type.Literal("variables"), frame_id: DapIdSchema, ...VariablesPageSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("variables"),
      variables_reference: DapIdSchema,
      ...VariablesPageSchema,
    },
    { additionalProperties: false },
  ),
]);
const EvaluateParametersSchema = Type.Object(
  {
    operation: Type.Literal("evaluate"),
    expression: NonEmptyStringSchema,
    frame_id: Type.Optional(DapIdSchema),
  },
  { additionalProperties: false },
);

/** Strict model-facing contract for the package's twelve DAP operations. */
export const DapToolParametersSchema = Type.Union([
  LaunchParametersSchema,
  SetBreakpointsParametersSchema,
  EmptyOperationSchema("continue"),
  EmptyOperationSchema("next"),
  EmptyOperationSchema("step_in"),
  EmptyOperationSchema("step_out"),
  EmptyOperationSchema("pause"),
  StackParametersSchema,
  VariablesParametersSchema,
  EvaluateParametersSchema,
  EmptyOperationSchema("status"),
  EmptyOperationSchema("stop"),
]);

/** Parsed input for one invocation of the strict `dap` tool. */
export type DapToolParameters = Static<typeof DapToolParametersSchema>;

const DapStateSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("launching"),
  Type.Literal("running"),
  Type.Literal("stopped"),
  Type.Literal("terminated"),
]);
const DapOperationSchema = Type.Union([
  Type.Literal("launch"),
  Type.Literal("set_breakpoints"),
  Type.Literal("continue"),
  Type.Literal("next"),
  Type.Literal("step_in"),
  Type.Literal("step_out"),
  Type.Literal("pause"),
  Type.Literal("stack"),
  Type.Literal("variables"),
  Type.Literal("evaluate"),
  Type.Literal("status"),
  Type.Literal("stop"),
]);
const DapSourceFields = {
  source_name: Type.Optional(DapPresentationStringSchema),
  source_path: Type.Optional(DapPresentationStringSchema),
};
const BreakpointsPresentationSchema = Type.Object(
  {
    kind: Type.Literal("breakpoints"),
    rows: Type.Array(
      Type.Object(
        {
          id: Type.Optional(DapIdSchema),
          verified: Type.Boolean(),
          message: Type.Optional(DapPresentationStringSchema),
          line: Type.Optional(Type.Integer()),
          ...DapSourceFields,
        },
        { additionalProperties: false },
      ),
      { maxItems: 20 },
    ),
    omitted_count: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const StackPresentationSchema = Type.Object(
  {
    kind: Type.Literal("stack_frames"),
    rows: Type.Array(
      Type.Object(
        {
          id: DapIdSchema,
          name: DapPresentationStringSchema,
          line: Type.Integer(),
          column: Type.Integer(),
          ...DapSourceFields,
        },
        { additionalProperties: false },
      ),
      { maxItems: 20 },
    ),
    total_count: Type.Integer({ minimum: 0 }),
    omitted_count: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const VariableRowSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("group"),
      name: DapPresentationStringSchema,
      variables_reference: DapIdSchema,
      expensive: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("variable"),
      group: Type.Optional(DapPresentationStringSchema),
      name: DapPresentationStringSchema,
      value: DapPresentationStringSchema,
      type: Type.Optional(DapPresentationStringSchema),
      variables_reference: DapIdSchema,
    },
    { additionalProperties: false },
  ),
]);
const VariablesPresentationSchema = Type.Object(
  {
    kind: Type.Literal("variables"),
    rows: Type.Array(VariableRowSchema, { maxItems: 20 }),
    omitted_count: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const EvaluationPresentationSchema = Type.Object(
  {
    kind: Type.Literal("evaluation"),
    value: DapPresentationStringSchema,
    type: Type.Optional(DapPresentationStringSchema),
    variables_reference: DapIdSchema,
  },
  { additionalProperties: false },
);
const DapExecutionWaitOperationSchema = Type.Union([
  Type.Literal("launch"),
  Type.Literal("continue"),
  Type.Literal("next"),
  Type.Literal("step_in"),
  Type.Literal("step_out"),
]);
const ExecutionWaitPresentationSchema = Type.Object(
  {
    kind: Type.Literal("execution_wait"),
    operation: DapExecutionWaitOperationSchema,
    cancelled: Type.Literal(true),
  },
  { additionalProperties: false },
);

/** Bounded operation-specific data used only by the Observer UI. */
export const DapPresentationDetailsSchema = Type.Union([
  BreakpointsPresentationSchema,
  StackPresentationSchema,
  VariablesPresentationSchema,
  EvaluationPresentationSchema,
  ExecutionWaitPresentationSchema,
]);

/** Bounded operation-specific data used only by the Observer UI. */
export type DapPresentationDetails = Static<typeof DapPresentationDetailsSchema>;

/** Structured, runtime-validated details returned with every successful DAP operation. */
export const DapToolResultDetailsSchema = Type.Object(
  {
    operation: DapOperationSchema,
    state: DapStateSchema,
    adapter_id: Type.Optional(NonEmptyStringSchema),
    profile_id: Type.Optional(NonEmptyStringSchema),
    stop_reason: Type.Optional(Type.String()),
    thread_id: Type.Optional(DapIdSchema),
    stack_frame_ids: Type.Optional(Type.Array(DapIdSchema)),
    exit_code: Type.Optional(Type.Integer()),
    termination_reason: Type.Optional(Type.String()),
    output_discarded_bytes: Type.Integer({ minimum: 0 }),
    output_truncated: Type.Boolean(),
    spill_path: Type.Optional(NonEmptyStringSchema),
    presentation: Type.Optional(DapPresentationDetailsSchema),
  },
  { additionalProperties: false },
);

/** Validated metadata accompanying one successful DAP tool result. */
export type DapToolResultDetails = Static<typeof DapToolResultDetailsSchema>;

/** One bounded elapsed-time update shown while an execution operation waits. */
export const DapToolProgressDetailsSchema = Type.Object(
  {
    kind: Type.Literal("progress"),
    operation: DapExecutionWaitOperationSchema,
    elapsed_ms: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** One bounded elapsed-time update shown while an execution operation waits. */
export type DapToolProgressDetails = Static<typeof DapToolProgressDetailsSchema>;

/** Final or partial details accepted by the DAP transcript renderer. */
export const DapToolRenderDetailsSchema = Type.Union([
  DapToolResultDetailsSchema,
  DapToolProgressDetailsSchema,
]);

/** Final or partial details accepted by the DAP transcript renderer. */
export type DapToolRenderDetails = Static<typeof DapToolRenderDetailsSchema>;
