import { type Static, Type } from "typebox";

const NonEmptyStringSchema = Type.String({ minLength: 1 });
const DapIdSchema = Type.Integer({ minimum: 0 });
const DapPresentationStringSchema = Type.String({ maxLength: 500 });

/** Every DAP operation, in registration order; each is one `dap_<operation>` Pi tool. */
export const DAP_OPERATIONS = [
  "launch",
  "set_breakpoints",
  "continue",
  "next",
  "step_in",
  "step_out",
  "pause",
  "stack",
  "variables",
  "evaluate",
  "status",
  "stop",
] as const;

/** One DAP operation acting on the single model-facing Debug Session. */
export type DapOperation = (typeof DAP_OPERATIONS)[number];

/** Arguments of operations that take none. */
export const DapNoParametersSchema = Type.Object({}, { additionalProperties: false });

/** `dap_launch` arguments. */
export const DapLaunchParametersSchema = Type.Object(
  {
    profile: Type.Optional(NonEmptyStringSchema),
    program: Type.Optional(NonEmptyStringSchema),
    args: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

/** `dap_set_breakpoints` arguments. */
export const DapSetBreakpointsParametersSchema = Type.Object(
  {
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

/** `dap_stack` arguments. */
export const DapStackParametersSchema = Type.Object(
  {
    thread_id: Type.Optional(DapIdSchema),
    start: Type.Optional(Type.Integer({ minimum: 0 })),
    count: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const VariablesPageFields = {
  start: Type.Optional(Type.Integer({ minimum: 0 })),
  count: Type.Optional(Type.Integer({ minimum: 1 })),
};

/**
 * Provider-facing `dap_variables` arguments. Strict function-calling providers reject a top-level
 * union, so the exclusive selector is enforced by {@link DapVariablesStrictParametersSchema}.
 */
export const DapVariablesParametersSchema = Type.Object(
  {
    frame_id: Type.Optional(DapIdSchema),
    variables_reference: Type.Optional(DapIdSchema),
    ...VariablesPageFields,
  },
  { additionalProperties: false },
);

/** Strict `dap_variables` ingress contract: exactly one of `frame_id` or `variables_reference`. */
export const DapVariablesStrictParametersSchema = Type.Union([
  Type.Object({ frame_id: DapIdSchema, ...VariablesPageFields }, { additionalProperties: false }),
  Type.Object(
    { variables_reference: DapIdSchema, ...VariablesPageFields },
    { additionalProperties: false },
  ),
]);

/** `dap_evaluate` arguments. */
export const DapEvaluateParametersSchema = Type.Object(
  {
    expression: NonEmptyStringSchema,
    frame_id: Type.Optional(DapIdSchema),
  },
  { additionalProperties: false },
);

/** Validated arguments of each operation. */
interface DapOperationArguments {
  readonly launch: Static<typeof DapLaunchParametersSchema>;
  readonly set_breakpoints: Static<typeof DapSetBreakpointsParametersSchema>;
  readonly continue: Static<typeof DapNoParametersSchema>;
  readonly next: Static<typeof DapNoParametersSchema>;
  readonly step_in: Static<typeof DapNoParametersSchema>;
  readonly step_out: Static<typeof DapNoParametersSchema>;
  readonly pause: Static<typeof DapNoParametersSchema>;
  readonly stack: Static<typeof DapStackParametersSchema>;
  readonly variables: Static<typeof DapVariablesStrictParametersSchema>;
  readonly evaluate: Static<typeof DapEvaluateParametersSchema>;
  readonly status: Static<typeof DapNoParametersSchema>;
  readonly stop: Static<typeof DapNoParametersSchema>;
}

/** One validated tool call, tagged with the operation its tool performs. */
export type DapToolParameters = {
  [Operation in DapOperation]: { readonly operation: Operation } & DapOperationArguments[Operation];
}[DapOperation];

/** Unvalidated, possibly incomplete call arguments used by Pi's call renderer. */
export interface DapToolCallArguments {
  readonly operation: DapOperation;
  readonly profile?: string;
  readonly program?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly file_path?: string;
  readonly breakpoints?: readonly { readonly line: number; readonly condition?: string }[];
  readonly thread_id?: number;
  readonly start?: number;
  readonly count?: number;
  readonly frame_id?: number;
  readonly variables_reference?: number;
  readonly expression?: string;
}

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
const DapPresentationSourceFields = {
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
          ...DapPresentationSourceFields,
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
          ...DapPresentationSourceFields,
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

/** Operations that wait for the Debuggee to stop, exit, or time out. */
export type DapExecutionWaitOperation = Static<typeof DapExecutionWaitOperationSchema>;

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

/**
 * Bounded, runtime-validated details stored with every successful DAP result for the Observer UI.
 * They are not the script-facing result: see {@link DapToolOutputSchemas}.
 */
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

const DapSourceFields = {
  source_name: Type.Optional(Type.String()),
  source_path: Type.Optional(Type.String()),
};
const DapBreakpointSchema = Type.Object(
  {
    id: Type.Optional(DapIdSchema),
    verified: Type.Boolean(),
    message: Type.Optional(Type.String()),
    line: Type.Optional(Type.Integer()),
    column: Type.Optional(Type.Integer()),
    ...DapSourceFields,
  },
  { additionalProperties: false },
);
const DapStackFrameSchema = Type.Object(
  {
    id: DapIdSchema,
    name: Type.String(),
    line: Type.Integer(),
    column: Type.Integer(),
    ...DapSourceFields,
  },
  { additionalProperties: false },
);
const DapVariableSchema = Type.Object(
  {
    name: Type.String(),
    value: Type.String(),
    type: Type.Optional(Type.String()),
    variables_reference: Type.Integer({
      minimum: 0,
      description: "Pass to dap_variables to list children; 0 has none.",
    }),
    evaluate_name: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const DapScopeSchema = Type.Object(
  {
    name: Type.String(),
    variables_reference: DapIdSchema,
    expensive: Type.Boolean(),
    variables: Type.Array(DapVariableSchema),
  },
  { additionalProperties: false },
);
const DapEvaluationSchema = Type.Object(
  {
    result: Type.String(),
    type: Type.Optional(Type.String()),
    variables_reference: DapIdSchema,
  },
  { additionalProperties: false },
);
const DapDesiredBreakpointFileSchema = Type.Object(
  {
    file_path: Type.String(),
    breakpoints: Type.Array(
      Type.Object(
        { line: Type.Integer({ minimum: 1 }), condition: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** Fields of every script-facing result, successful or failed. */
const DapOutputBaseFields = {
  state: DapStateSchema,
  adapter_id: Type.Optional(Type.String()),
  profile_id: Type.Optional(Type.String()),
  stop_reason: Type.Optional(Type.String()),
  thread_id: Type.Optional(DapIdSchema),
  exit_code: Type.Optional(Type.Integer()),
  termination_reason: Type.Optional(Type.String()),
  output: Type.Optional(
    Type.String({ description: "Complete unread Debuggee output this call drained." }),
  ),
  output_discarded_bytes: Type.Optional(Type.Integer({ minimum: 0 })),
  desired_breakpoints: Type.Optional(Type.Array(DapDesiredBreakpointFileSchema)),
  error: Type.Optional(
    Type.String({ description: "Set when the call failed; the other fields are current state." }),
  ),
};
const DapExecutionOutputFields = {
  execution_wait_cancelled: Type.Optional(Type.Boolean()),
};

const DapBaseOutputSchema = Type.Object(DapOutputBaseFields, { additionalProperties: false });
const DapExecutionOutputSchema = Type.Object(
  { ...DapOutputBaseFields, ...DapExecutionOutputFields },
  { additionalProperties: false },
);

/**
 * Complete script-facing result of each tool, returned as `structuredContent`. Unlike the bounded
 * Observer UI details, it carries every row, full values, and all drained Debuggee output.
 */
export const DapToolOutputSchemas = {
  launch: DapExecutionOutputSchema,
  set_breakpoints: Type.Object(
    { ...DapOutputBaseFields, breakpoints: Type.Optional(Type.Array(DapBreakpointSchema)) },
    { additionalProperties: false },
  ),
  continue: DapExecutionOutputSchema,
  next: DapExecutionOutputSchema,
  step_in: DapExecutionOutputSchema,
  step_out: DapExecutionOutputSchema,
  pause: DapBaseOutputSchema,
  stack: Type.Object(
    {
      ...DapOutputBaseFields,
      stack_frames: Type.Optional(Type.Array(DapStackFrameSchema)),
      total_frames: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  variables: Type.Object(
    {
      ...DapOutputBaseFields,
      scopes: Type.Optional(Type.Array(DapScopeSchema, { description: "Set for frame_id." })),
      variables: Type.Optional(
        Type.Array(DapVariableSchema, { description: "Set for variables_reference." }),
      ),
    },
    { additionalProperties: false },
  ),
  evaluate: Type.Object(
    { ...DapOutputBaseFields, evaluation: Type.Optional(DapEvaluationSchema) },
    { additionalProperties: false },
  ),
  status: DapBaseOutputSchema,
  stop: DapBaseOutputSchema,
} as const;

/** Every field a script-facing DAP result can carry. */
export type DapToolOutput = Static<typeof DapExecutionOutputSchema> &
  Static<(typeof DapToolOutputSchemas)["set_breakpoints"]> &
  Static<(typeof DapToolOutputSchemas)["stack"]> &
  Static<(typeof DapToolOutputSchemas)["variables"]> &
  Static<(typeof DapToolOutputSchemas)["evaluate"]>;
