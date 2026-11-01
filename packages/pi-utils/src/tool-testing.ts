/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- SAFETY: Test helpers over arbitrary tool definitions and their untyped JSON arguments; they only compare and serialize values. */
import { validateToolArguments, type JsonValue, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/** The part of a Pi tool definition these test helpers read. */
export interface ToolUnderTest {
  readonly name: string;
  readonly parameters: TSchema;
  readonly prepareArguments?: (args: unknown) => unknown;
}

export interface ToolRecorder {
  readonly pi: ExtensionAPI;
  readonly tools: ToolUnderTest[];
}

/**
 * A stand-in for the `ExtensionAPI` handed to an extension factory that records every
 * `registerTool` call in order. Any other `pi.*` method is a no-op that returns `undefined`, so the
 * factory can run without a Pi session.
 */
export function recordToolRegistrations(): ToolRecorder {
  const tools: ToolUnderTest[] = [];
  const pi = new Proxy(
    {},
    {
      get: (_target, property) =>
        property === "registerTool"
          ? (tool: ToolUnderTest) => {
              tools.push(tool);
            }
          : () => undefined,
    },
  );
  // SAFETY: The proxy answers every method a factory may call, which a structural type cannot express.
  return { pi: pi as ExtensionAPI, tools };
}

/**
 * `factory` registering every tool without its `prepareArguments`: the extension as it was before
 * it accepted `null` for optional parameters. A test loads both into real Pi sessions and compares
 * what each declares to the model, since only `prepareArguments` may differ.
 */
export function withoutPreparedArguments(factory: ExtensionFactory): ExtensionFactory {
  return (pi) => {
    const plain: ExtensionAPI = Object.create(pi);
    Object.defineProperty(plain, "registerTool", {
      value: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
        const { prepareArguments: _omitted, ...rest } = tool;
        pi.registerTool(rest);
      },
    });
    return factory(plain);
  };
}

function isEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Top-level optional parameters of `schema` that reject `null`, in declaration order. */
export function optionalParametersRejectingNull(schema: TSchema): string[] {
  // SAFETY: Tool parameters are JSON Schema objects; each field is narrowed below before use.
  const { properties, required } = schema as { properties?: unknown; required?: unknown };
  if (!isEntry(properties)) return [];
  const requiredNames = new Set(Array.isArray(required) ? required : []);
  return Object.entries(properties)
    .filter(
      ([name, property]) =>
        !requiredNames.has(name) &&
        !Value.Check(
          // SAFETY: Each property of a tool's parameter schema is itself a schema.
          property as TSchema,
          null,
        ),
    )
    .map(([name]) => name);
}

/** A schema's own value, which JSON Schema keywords such as `const` and `enum` hold as JSON. */
function json(value: unknown): JsonValue {
  // SAFETY: Only called with `const`/`enum` members and values built here, all of them JSON.
  return value as JsonValue;
}

function sample(schema: unknown): JsonValue {
  if (!isEntry(schema)) return null;
  if ("const" in schema) return json(schema.const);
  if (Array.isArray(schema.enum)) return json(schema.enum[0]);
  for (const union of [schema.anyOf, schema.oneOf]) {
    if (Array.isArray(union) && union.length > 0) return sample(union[0]);
  }
  if (Array.isArray(schema.allOf)) {
    return Object.assign({}, ...schema.allOf.map((member) => sample(member)));
  }
  switch (schema.type) {
    case "string":
      return "x".repeat(typeof schema.minLength === "number" ? Math.max(1, schema.minLength) : 1);
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "boolean":
      return true;
    case "array":
      return typeof schema.minItems === "number" && schema.minItems > 0
        ? Array.from({ length: schema.minItems }, () => sample(schema.items))
        : [];
    case "object":
      // SAFETY: The schema declares `type: "object"`, so it is a JSON Schema object.
      return sampleRequiredArguments(schema as TSchema);
    default:
      return null;
  }
}

/**
 * A call that sets only the required parameters of `schema`, each to a minimal valid value, so a
 * table over every tool needs no hand-written arguments. Throws when the result does not satisfy
 * the schema; pass explicit arguments for such a tool.
 */
export function sampleRequiredArguments(schema: TSchema): ToolCall["arguments"] {
  // SAFETY: Tool parameters are JSON Schema objects; each field is narrowed below before use.
  const { properties, required } = schema as { properties?: unknown; required?: unknown };
  const result: ToolCall["arguments"] = {};
  if (isEntry(properties) && Array.isArray(required)) {
    for (const name of required) {
      if (typeof name === "string") result[name] = sample(properties[name]);
    }
  }
  return result;
}

function prepared(tool: ToolUnderTest, args: ToolCall["arguments"]): string {
  const input = structuredClone(args);
  const prepare = tool.prepareArguments?.(input) ?? input;
  const validated = validateToolArguments(
    { name: tool.name, description: "", parameters: tool.parameters },
    {
      type: "toolCall",
      id: "tool-testing",
      name: tool.name,
      // SAFETY: A tool's prepared arguments are a JSON object, as Pi requires of prepareArguments.
      arguments: prepare as ToolCall["arguments"],
    },
  );
  return JSON.stringify({ prepare, validated });
}

/**
 * Throw unless `tool` treats `null` for each of its optional parameters that reject `null` exactly
 * like omitting it: the same `prepareArguments` output and the same validated arguments. `args`
 * must be a valid call that sets only required parameters; by default it is sampled from the schema.
 * `skip` names optional parameters the call cannot do without, such as one of two exclusive selectors. Returns the parameters it proved, so a
 * test can assert the tool had optional parameters to prove.
 */
export function expectNullOptionalArgumentsOmitted(
  tool: ToolUnderTest,
  args: ToolCall["arguments"] = sampleRequiredArguments(tool.parameters),
  skip: readonly string[] = [],
): string[] {
  if (!Value.Check(tool.parameters, args))
    throw new Error(`${tool.name}: ${JSON.stringify(args)} is not a valid call; pass arguments`);
  const names = optionalParametersRejectingNull(tool.parameters).filter(
    (name) => !skip.includes(name),
  );
  const omitted = prepared(tool, args);
  for (const name of names) {
    const withNull = prepared(tool, { ...args, [name]: null });
    if (withNull !== omitted)
      throw new Error(
        `${tool.name}: null for optional "${name}" differs from omitting it:\n  null:    ${withNull}\n  omitted: ${omitted}`,
      );
  }
  return names;
}

/**
 * The model-visible declaration of each tool, as one JSON string that is compared byte for byte:
 * names, descriptions, and parameter schemas in registration order.
 */
export function toolDeclarations(
  tools: readonly { name: string; description: string; parameters: unknown }[],
): string {
  return JSON.stringify(
    tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    undefined,
    2,
  );
}

/** The part of a Pi tool definition that declares what its results' `structuredContent` holds. */
export interface ToolOutputDeclaration {
  readonly name: string;
  readonly outputSchema?: TSchema;
}

/** The part of a tool result that the conformance helpers read. */
export interface ToolResultOutput {
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/**
 * How `result` fails to conform to what `tool` declares, as Pi's codemode needs it; empty when it
 * conforms. A script gets a result's `structuredContent` only when the tool declares an
 * `outputSchema`, and the text otherwise. So a violation is
 * - `structuredContent` set for a tool that declares no `outputSchema`;
 * - no `structuredContent` on a successful result of a tool that declares an `outputSchema` (the
 *   SDK says such tools always set it);
 * - `structuredContent` that fails the `outputSchema`: one `<instancePath or "/"> <message>` entry
 *   per error. Error results are checked too when they carry `structuredContent`, since scripts
 *   receive it.
 */
export function toolOutputViolations(
  tool: ToolOutputDeclaration,
  result: ToolResultOutput,
): string[] {
  const { outputSchema } = tool;
  const { structuredContent, isError } = result;
  if (outputSchema === undefined) {
    return structuredContent === undefined
      ? []
      : [
          "result sets structuredContent but the tool declares no outputSchema, so codemode scripts would get the text instead",
        ];
  }
  if (structuredContent === undefined) {
    return isError === true
      ? []
      : [
          "tool declares an outputSchema but the result sets no structuredContent; such tools must always set it",
        ];
  }
  return [...Value.Errors(outputSchema, structuredContent)].map(
    ({ instancePath, message }) => `structuredContent ${instancePath || "/"} ${message}`,
  );
}

/** Throw an `Error` naming `tool` and listing every violation `toolOutputViolations` finds. */
export function expectToolOutputMatches(
  tool: ToolOutputDeclaration,
  result: ToolResultOutput,
): void {
  const violations = toolOutputViolations(tool, result);
  if (violations.length > 0)
    throw new Error(`${tool.name}:\n${violations.map((line) => `  ${line}`).join("\n")}`);
}

/** One `tool_result` seen by `recordToolOutputs`. */
export interface RecordedToolOutput {
  readonly toolName: string;
  /** `<parent id>/<n>` for a call a codemode script issued. */
  readonly toolCallId: string;
  /** What the tool declared when the result fired; `undefined` when no such tool was defined. */
  readonly declaration: ToolOutputDeclaration | undefined;
  /** A `structuredClone` taken when the handler ran, so later mutation cannot hide a violation. */
  readonly structuredContent: unknown;
  readonly isError: boolean;
}

export interface ToolOutputRecorder {
  /** Load this LAST; see `recordToolOutputs`. */
  readonly extension: ExtensionFactory;
  /** Every result seen so far, in order. */
  readonly outputs: readonly RecordedToolOutput[];
  /**
   * Throw one `Error` listing every violation of every recorded result against the declaration
   * its tool had when the result fired. Call it once the test's prompts finish, for example in
   * `onTestFinished`.
   */
  check(): void;
}

/**
 * Record every `tool_result` of a Pi session, nested codemode calls included, with the declaration
 * of the tool that produced it, to check against its `outputSchema` afterwards. `getToolDefinition`
 * runs as each result fires, so a tool removed or replaced mid-test is judged as it was then;
 * harnesses pass `(name) => session.getToolDefinition(name)`, closing over their session, which
 * exists by the time any tool runs. Harnesses load `extension` LAST in the session's extension
 * factories, so its handler runs after the other extensions' `tool_result` handlers (such as
 * redaction) and records what codemode scripts actually receive. Call `check()` once the prompts
 * finish.
 */
export function recordToolOutputs(
  getToolDefinition: (name: string) => ToolOutputDeclaration | undefined,
): ToolOutputRecorder {
  const outputs: RecordedToolOutput[] = [];
  return {
    outputs,
    extension: (pi) => {
      pi.on("tool_result", (event) => {
        const tool = getToolDefinition(event.toolName);
        // Snapshot the declaration; the tool object may be replaced or changed later.
        let declaration: { name: string; outputSchema?: TSchema } | undefined;
        if (tool !== undefined) {
          declaration = { name: tool.name };
          if (tool.outputSchema !== undefined) declaration.outputSchema = tool.outputSchema;
        }
        outputs.push({
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          declaration,
          structuredContent: structuredClone(event.structuredContent),
          isError: event.isError,
        });
      });
    },
    check() {
      const lines = outputs.flatMap((output) =>
        toolOutputViolations(output.declaration ?? { name: output.toolName }, output).map(
          (violation) => `${output.toolName} (call ${output.toolCallId}): ${violation}`,
        ),
      );
      if (lines.length > 0)
        throw new Error(
          `${lines.length} tool output violation(s):\n${lines.map((line) => `  ${line}`).join("\n")}`,
        );
    },
  };
}
