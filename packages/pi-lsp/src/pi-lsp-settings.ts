import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const DEFAULT_LSP_TIMEOUTS = {
  diagnosticsMs: 3000,
  initializeMs: 45000,
  requestMs: 3000,
  shutdownMs: 5000,
} as const;

const NonEmptyStringSchema = Type.String({ minLength: 1 });
const PositiveMillisecondsSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const JsonValueSchema = Type.Any();
const JsonObjectSchema = Type.Record(Type.String(), JsonValueSchema);
const LspLanguageMappingSchema = Type.Object(
  {
    extensions: Type.Optional(Type.Array(NonEmptyStringSchema, { minItems: 1 })),
    fileNames: Type.Optional(Type.Array(NonEmptyStringSchema, { minItems: 1 })),
    languageId: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);
const LspServerDefinitionSchema = Type.Object(
  {
    args: Type.Optional(Type.Array(Type.String())),
    command: Type.Optional(NonEmptyStringSchema),
    environment: Type.Optional(
      Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()])),
    ),
    initializationOptions: Type.Optional(JsonValueSchema),
    languages: Type.Optional(Type.Array(LspLanguageMappingSchema, { minItems: 1 })),
    rootMarkers: Type.Optional(Type.Array(NonEmptyStringSchema)),
    settings: Type.Optional(JsonValueSchema),
  },
  { additionalProperties: false },
);
const LspTimeoutsSchema = Type.Object(
  {
    diagnosticsMs: Type.Optional(PositiveMillisecondsSchema),
    initializeMs: Type.Optional(PositiveMillisecondsSchema),
    requestMs: Type.Optional(PositiveMillisecondsSchema),
    shutdownMs: Type.Optional(PositiveMillisecondsSchema),
  },
  { additionalProperties: false },
);
const SettingsDocumentSchema = Type.Object({ lsp: Type.Optional(JsonValueSchema) });

interface JsonObject {
  readonly [key: string]: JsonValue;
}

type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
type LspServerDefinitionWire = Static<typeof LspServerDefinitionSchema>;
type LspTimeoutsWire = Static<typeof LspTimeoutsSchema>;
type LspTimeoutName = keyof typeof DEFAULT_LSP_TIMEOUTS;
const LSP_TIMEOUT_NAMES: readonly LspTimeoutName[] = [
  "diagnosticsMs",
  "initializeMs",
  "requestMs",
  "shutdownMs",
];
type ParsedLspServerDefinition =
  | { readonly kind: "excluded" }
  | { readonly kind: "valid"; readonly value: LspServerDefinitionWire };

/** Describes one configured filename or extension mapping to an LSP language identifier. */
export interface LspLanguageMapping {
  readonly extensions: readonly string[];
  readonly fileNames: readonly string[];
  readonly languageId: string;
}

/** Contains the parsed command and protocol values for one enabled language server. */
export interface LspServerDefinition {
  readonly args: readonly string[];
  readonly command: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly id: string;
  readonly initializationOptions?: JsonValue;
  readonly languages: readonly LspLanguageMapping[];
  readonly rootMarkers: readonly string[];
  readonly settings?: JsonValue;
}

/** Contains bounded timeout values used for all requests made to an LSP server. */
export interface LspTimeouts {
  readonly diagnosticsMs: number;
  readonly initializeMs: number;
  readonly requestMs: number;
  readonly shutdownMs: number;
}

/** Reports resolved trusted configuration, retaining valid entries when other settings are invalid. */
export interface ResolvedLspSettings {
  readonly enabled: boolean;
  readonly servers: ReadonlyMap<string, LspServerDefinition>;
  readonly timeouts: LspTimeouts;
  readonly warnings: readonly string[];
}

/** Reads Pi's already trust-filtered global and project settings documents. */
export interface LspSettingsReader {
  getGlobalSettings(): LspSettingsDocumentInput;
  getProjectSettings(): LspSettingsDocumentInput;
}

/** Minimal Pi settings document shape containing the extension-owned optional `lsp` value. */
type PiSettingsDocument = ReturnType<SettingsManager["getGlobalSettings"]>;

/** Pi's core Settings type or a test/boundary document carrying the extension-owned `lsp` value. */
export type LspSettingsDocumentInput = PiSettingsDocument | { readonly lsp?: JsonValue };

interface ParsedLspLayer {
  readonly servers: ReadonlyMap<string, ParsedLspServerDefinition>;
  readonly timeouts: LspTimeoutsWire;
  readonly warnings: readonly string[];
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return Value.Check(JsonObjectSchema, value);
}

function schemaValidationWarning(
  schema: typeof LspServerDefinitionSchema | typeof PositiveMillisecondsSchema,
  value: JsonValue,
  prefix: string,
): string {
  const error = Value.Errors(schema, value)[0];
  const path = error?.instancePath.replaceAll("/", ".") ?? "";
  const unknownField =
    error?.keyword === "additionalProperties" ? error.params.additionalProperties[0] : undefined;
  const unknownFieldSuffix = unknownField === undefined ? "" : `.${String(unknownField)}`;
  return `${prefix}${path}${unknownFieldSuffix}: ${error?.message ?? "invalid settings"}`;
}

function parseLspServerDefinitions(
  value: JsonValue | undefined,
  scope: "global" | "project",
): Pick<ParsedLspLayer, "servers" | "warnings"> {
  const warnings: string[] = [];
  const servers = new Map<string, ParsedLspServerDefinition>();
  if (value === undefined) return { servers, warnings };
  if (!isJsonObject(value)) {
    return { servers, warnings: [`${scope} lsp.servers: expected a JSON object`] };
  }
  for (const [id, server] of Object.entries(value)) {
    if (!Value.Check(NonEmptyStringSchema, id)) {
      warnings.push(`${scope} lsp.servers.${String(id)}: server ID must be a non-empty string`);
      continue;
    }
    if (server === null) {
      servers.set(id, { kind: "excluded" });
      continue;
    }
    if (!Value.Check(LspServerDefinitionSchema, server)) {
      warnings.push(
        schemaValidationWarning(LspServerDefinitionSchema, server, `${scope} lsp.servers.${id}`),
      );
      servers.set(id, { kind: "excluded" });
      continue;
    }
    if (server.command === undefined || server.languages === undefined) {
      warnings.push(`${scope} lsp.servers.${id}: command and languages are required`);
      servers.set(id, { kind: "excluded" });
      continue;
    }
    if (
      server.languages.some(
        (language) => language.extensions === undefined && language.fileNames === undefined,
      )
    ) {
      warnings.push(
        `${scope} lsp.servers.${id}.languages: each language needs extensions or fileNames`,
      );
      servers.set(id, { kind: "excluded" });
      continue;
    }
    servers.set(id, { kind: "valid", value: server });
  }
  return { servers, warnings };
}

function isLspTimeoutName(name: string): name is LspTimeoutName {
  return LSP_TIMEOUT_NAMES.some((timeoutName) => timeoutName === name);
}

function parseLspTimeouts(
  value: JsonValue | undefined,
  scope: "global" | "project",
): Pick<ParsedLspLayer, "timeouts" | "warnings"> {
  const warnings: string[] = [];
  const timeouts: LspTimeoutsWire = {};
  if (value === undefined) return { timeouts, warnings };
  if (!isJsonObject(value)) {
    return { timeouts, warnings: [`${scope} lsp.timeouts: expected a JSON object`] };
  }
  for (const [name, timeout] of Object.entries(value)) {
    if (!isLspTimeoutName(name)) {
      warnings.push(`${scope} lsp.timeouts.${name}: unknown field`);
      continue;
    }
    if (!Value.Check(PositiveMillisecondsSchema, timeout)) {
      warnings.push(
        schemaValidationWarning(
          PositiveMillisecondsSchema,
          timeout,
          `${scope} lsp.timeouts.${name}`,
        ),
      );
      continue;
    }
    timeouts[name] = timeout;
  }
  return { timeouts, warnings };
}

function readLspLayer(
  settings: LspSettingsDocumentInput,
  scope: "global" | "project",
): ParsedLspLayer {
  if (!Value.Check(SettingsDocumentSchema, settings)) {
    return {
      servers: new Map(),
      timeouts: {},
      warnings: [`${scope} settings: expected a JSON object`],
    };
  }
  if (settings.lsp === undefined) return { servers: new Map(), timeouts: {}, warnings: [] };
  if (!isJsonObject(settings.lsp)) {
    return {
      servers: new Map(),
      timeouts: {},
      warnings: [`${scope} lsp: expected a JSON object`],
    };
  }
  const warnings = Object.keys(settings.lsp)
    .filter((field) => field !== "servers" && field !== "timeouts")
    .map((field) => `${scope} lsp.${field}: unknown field`);
  const parsedServers = parseLspServerDefinitions(settings.lsp.servers, scope);
  const parsedTimeouts = parseLspTimeouts(settings.lsp.timeouts, scope);
  return {
    servers: parsedServers.servers,
    timeouts: parsedTimeouts.timeouts,
    warnings: [...warnings, ...parsedServers.warnings, ...parsedTimeouts.warnings],
  };
}

function mergeLspTimeouts(globalLayer: ParsedLspLayer, projectLayer: ParsedLspLayer): LspTimeouts {
  return Object.assign({}, DEFAULT_LSP_TIMEOUTS, globalLayer.timeouts, projectLayer.timeouts);
}

function resolveLspEnvironment(
  configuredEnvironment: Readonly<Record<string, string | null>> | undefined,
) {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(configuredEnvironment ?? {})) {
    if (value === null) {
      delete environment[key];
    } else {
      environment[key] = value;
    }
  }
  return environment;
}

function resolveLspServerDefinition(
  id: string,
  server: LspServerDefinitionWire,
): LspServerDefinition {
  const languages: LspLanguageMapping[] = (server.languages ?? []).map((language) => ({
    extensions: language.extensions ?? [],
    fileNames: language.fileNames ?? [],
    languageId: language.languageId,
  }));
  const resolved = {
    args: server.args ?? [],
    command: server.command ?? "",
    environment: resolveLspEnvironment(server.environment),
    id,
    languages,
    rootMarkers: server.rootMarkers ?? [],
  };
  const initializationOptions = server.initializationOptions;
  const settings = server.settings;
  if (initializationOptions !== undefined && settings !== undefined) {
    return {
      ...resolved,
      initializationOptions: structuredClone(initializationOptions),
      settings: structuredClone(settings),
    };
  }
  if (initializationOptions !== undefined) {
    return { ...resolved, initializationOptions: structuredClone(initializationOptions) };
  }
  if (settings !== undefined) {
    return { ...resolved, settings: structuredClone(settings) };
  }
  return resolved;
}

function mergeLspServers(
  globalLayer: ParsedLspLayer,
  projectLayer: ParsedLspLayer,
): ReadonlyMap<string, LspServerDefinition> {
  const serverDefinitions = new Map<string, LspServerDefinitionWire>();
  for (const [id, server] of globalLayer.servers) {
    if (server.kind === "valid") serverDefinitions.set(id, server.value);
  }
  for (const [id, server] of projectLayer.servers) {
    serverDefinitions.delete(id);
    if (server.kind === "valid") serverDefinitions.set(id, server.value);
  }
  return new Map(
    [...serverDefinitions]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, server]) => [id, resolveLspServerDefinition(id, server)]),
  );
}

/** Resolve global and trusted-project LSP settings, quarantining invalid entries instead of disabling valid settings. */
export function resolveLspSettings(reader: LspSettingsReader): ResolvedLspSettings {
  const globalLayer = readLspLayer(reader.getGlobalSettings(), "global");
  const projectLayer = readLspLayer(reader.getProjectSettings(), "project");
  return {
    enabled: true,
    servers: mergeLspServers(globalLayer, projectLayer),
    timeouts: mergeLspTimeouts(globalLayer, projectLayer),
    warnings: [...globalLayer.warnings, ...projectLayer.warnings],
  };
}
