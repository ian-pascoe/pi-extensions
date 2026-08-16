import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const DEFAULT_FORMATTER_TIMEOUT_MS = 30_000;
const NonEmptyStringSchema = Type.String({ minLength: 1 });
const PositiveMillisecondsSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const FormatterFilesSchema = Type.Object(
  {
    extensions: Type.Optional(Type.Array(NonEmptyStringSchema, { minItems: 1 })),
    fileNames: Type.Optional(Type.Array(NonEmptyStringSchema, { minItems: 1 })),
  },
  { additionalProperties: false },
);
const FormatterDefinitionSchema = Type.Object(
  {
    args: Type.Optional(Type.Array(Type.String())),
    command: NonEmptyStringSchema,
    environment: Type.Optional(
      Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()])),
    ),
    files: FormatterFilesSchema,
    rootMarkers: Type.Optional(Type.Array(NonEmptyStringSchema)),
  },
  { additionalProperties: false },
);
const FormatterLayerSchema = Type.Object(
  {
    formatters: Type.Optional(Type.Any()),
    timeoutMs: Type.Optional(Type.Any()),
  },
  { additionalProperties: true },
);
const JsonObjectSchema = Type.Record(Type.String(), Type.Any());
const SettingsDocumentSchema = Type.Object(
  { formatter: Type.Optional(Type.Any()) },
  { additionalProperties: true },
);

type FormatterDefinitionWire = Static<typeof FormatterDefinitionSchema>;
type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Contains one enabled formatter command and its exact file matching policy. */
export interface FormatterDefinition {
  readonly args: readonly string[];
  readonly command: string;
  readonly environment: Readonly<Record<string, string | null>>;
  readonly extensions: readonly string[];
  readonly fileNames: readonly string[];
  readonly id: string;
  readonly rootMarkers: readonly string[];
}

/** Contains resolved trusted formatter definitions and non-fatal configuration warnings. */
export interface ResolvedFormatterSettings {
  readonly formatters: ReadonlyMap<string, FormatterDefinition>;
  readonly timeoutMs: number;
  readonly warnings: readonly string[];
}

/** Reads Pi's trust-filtered global and project settings documents. */
export interface FormatterSettingsReader {
  getGlobalSettings(): FormatterSettingsDocumentInput;
  getProjectSettings(): FormatterSettingsDocumentInput;
}

type PiSettingsDocument = ReturnType<SettingsManager["getGlobalSettings"]>;

/** Pi's settings shape extended with the formatter-owned configuration key. */
export type FormatterSettingsDocumentInput =
  | PiSettingsDocument
  | { readonly formatter?: JsonValue };

interface ParsedFormatterLayer {
  readonly definitions: ReadonlyMap<string, FormatterDefinitionWire | null>;
  readonly timeoutMs?: number;
  readonly warnings: readonly string[];
}

function formatterValidationWarning(
  value: JsonValue,
  schema: typeof FormatterDefinitionSchema,
  prefix: string,
): string {
  const error = Value.Errors(schema, value)[0];
  const path = error?.instancePath.replaceAll("/", ".") ?? "";
  const unknownField =
    error?.keyword === "additionalProperties" ? error.params.additionalProperties[0] : undefined;
  return `${prefix}${path}${unknownField === undefined ? "" : `.${unknownField}`}: ${error?.message ?? "invalid settings"}`;
}

function readFormatterLayer(
  settings: FormatterSettingsDocumentInput,
  scope: "global" | "project",
): ParsedFormatterLayer {
  if (!Value.Check(SettingsDocumentSchema, settings)) {
    return {
      definitions: new Map(),
      warnings: [`${scope} settings: expected a JSON object`],
    };
  }
  const formatter = "formatter" in settings ? settings.formatter : undefined;
  if (formatter === undefined) return { definitions: new Map(), warnings: [] };
  if (!Value.Check(FormatterLayerSchema, formatter)) {
    return {
      definitions: new Map(),
      warnings: [`${scope} formatter: expected an object`],
    };
  }

  const warnings: string[] = [];
  for (const field of Object.keys(formatter)) {
    if (field !== "formatters" && field !== "timeoutMs") {
      warnings.push(`${scope} formatter.${field}: unknown field`);
    }
  }

  let timeoutMs: number | undefined;
  if (formatter.timeoutMs !== undefined) {
    if (Value.Check(PositiveMillisecondsSchema, formatter.timeoutMs)) {
      timeoutMs = formatter.timeoutMs;
    } else {
      warnings.push(`${scope} formatter.timeoutMs: expected a positive integer`);
    }
  }

  const definitions = new Map<string, FormatterDefinitionWire | null>();
  if (formatter.formatters !== undefined) {
    if (!Value.Check(JsonObjectSchema, formatter.formatters)) {
      warnings.push(`${scope} formatter.formatters: expected an object`);
    } else {
      for (const [id, definition] of Object.entries(formatter.formatters)) {
        if (!Value.Check(NonEmptyStringSchema, id)) {
          warnings.push(`${scope} formatter.formatters: formatter ID must not be empty`);
          continue;
        }
        if (definition === null) {
          definitions.set(id, null);
          continue;
        }
        if (!Value.Check(FormatterDefinitionSchema, definition)) {
          warnings.push(
            formatterValidationWarning(
              definition,
              FormatterDefinitionSchema,
              `${scope} formatter.formatters.${id}`,
            ),
          );
          definitions.set(id, null);
          continue;
        }
        if (definition.files.extensions === undefined && definition.files.fileNames === undefined) {
          warnings.push(
            `${scope} formatter.formatters.${id}.files: extensions or fileNames is required`,
          );
          definitions.set(id, null);
        } else {
          definitions.set(id, definition);
        }
      }
    }
  }

  return timeoutMs === undefined ? { definitions, warnings } : { definitions, timeoutMs, warnings };
}

function resolveFormatterDefinition(
  id: string,
  definition: FormatterDefinitionWire,
): FormatterDefinition {
  return {
    args: definition.args ?? [],
    command: definition.command,
    environment: { ...definition.environment },
    extensions: definition.files.extensions ?? [],
    fileNames: definition.files.fileNames ?? [],
    id,
    rootMarkers: definition.rootMarkers ?? [],
  };
}

/** Resolve global and trusted-project formatter settings, quarantining only invalid entries. */
export function resolveFormatterSettings(
  reader: FormatterSettingsReader,
): ResolvedFormatterSettings {
  const globalLayer = readFormatterLayer(reader.getGlobalSettings(), "global");
  const projectLayer = readFormatterLayer(reader.getProjectSettings(), "project");
  const definitions = new Map<string, FormatterDefinitionWire>();
  for (const [id, definition] of globalLayer.definitions) {
    if (definition !== null) definitions.set(id, definition);
  }
  for (const [id, definition] of projectLayer.definitions) {
    if (definition === null) definitions.delete(id);
    else definitions.set(id, definition);
  }
  const formatters = new Map<string, FormatterDefinition>();
  for (const [id, definition] of definitions) {
    formatters.set(id, resolveFormatterDefinition(id, definition));
  }
  return {
    formatters,
    timeoutMs: projectLayer.timeoutMs ?? globalLayer.timeoutMs ?? DEFAULT_FORMATTER_TIMEOUT_MS,
    warnings: [...globalLayer.warnings, ...projectLayer.warnings],
  };
}
