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
const LspLayerSchema = Type.Object(
  {
    servers: Type.Optional(
      Type.Record(
        Type.String({ minLength: 1 }),
        Type.Union([LspServerDefinitionSchema, Type.Null()]),
      ),
    ),
    timeouts: Type.Optional(LspTimeoutsSchema),
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
type LspLayerWire = Static<typeof LspLayerSchema>;

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

/** Reports resolved trusted configuration, or disabled startup when either layer is malformed. */
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

type ParsedLspLayer =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly warning: string }
  | { readonly kind: "valid"; readonly value: LspLayerWire };

function lspValidationWarning(value: JsonValue, scope: "global" | "project"): string {
  const error = Value.Errors(LspLayerSchema, value)[0];
  const path = error?.instancePath.replaceAll("/", ".") ?? "";
  const unknownField =
    error?.keyword === "additionalProperties" ? error.params.additionalProperties[0] : undefined;
  return `${scope} lsp${path}${unknownField === undefined ? "" : `.${unknownField}`}: ${error?.message ?? "invalid settings"}`;
}

function readLspLayer(
  settings: LspSettingsDocumentInput,
  scope: "global" | "project",
): ParsedLspLayer {
  if (!Value.Check(SettingsDocumentSchema, settings)) {
    return { kind: "invalid", warning: `${scope} settings: expected a JSON object` };
  }
  if (settings.lsp === undefined) return { kind: "absent" };
  if (!Value.Check(LspLayerSchema, settings.lsp)) {
    return { kind: "invalid", warning: lspValidationWarning(settings.lsp, scope) };
  }
  for (const [serverId, server] of Object.entries(settings.lsp.servers ?? {})) {
    if (server === null) continue;
    if (server.command === undefined || server.languages === undefined) {
      return {
        kind: "invalid",
        warning: `${scope} lsp.servers.${serverId}: command and languages are required`,
      };
    }
    if (
      server.languages.some(
        (language) => language.extensions === undefined && language.fileNames === undefined,
      )
    ) {
      return {
        kind: "invalid",
        warning: `${scope} lsp.servers.${serverId}.languages: each language needs extensions or fileNames`,
      };
    }
  }
  return { kind: "valid", value: settings.lsp };
}

function mergeLspTimeouts(globalLayer: ParsedLspLayer, projectLayer: ParsedLspLayer): LspTimeouts {
  const timeoutValues: readonly (LspTimeoutsWire | undefined)[] = [
    globalLayer.kind === "valid" ? globalLayer.value.timeouts : undefined,
    projectLayer.kind === "valid" ? projectLayer.value.timeouts : undefined,
  ];
  return Object.assign({}, DEFAULT_LSP_TIMEOUTS, ...timeoutValues);
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
  const addServers = (layer: ParsedLspLayer, projectLayerValue: boolean): void => {
    if (layer.kind !== "valid") return;
    for (const [id, server] of Object.entries(layer.value.servers ?? {})) {
      if (server === null) {
        if (projectLayerValue) serverDefinitions.delete(id);
        continue;
      }
      serverDefinitions.set(id, server);
    }
  };
  addServers(globalLayer, false);
  addServers(projectLayer, true);
  return new Map(
    [...serverDefinitions]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, server]) => [id, resolveLspServerDefinition(id, server)]),
  );
}

/** Resolve global and trusted-project LSP settings without adding an `lsp` field to Pi's Settings type. */
export function resolveLspSettings(reader: LspSettingsReader): ResolvedLspSettings {
  const globalLayer = readLspLayer(reader.getGlobalSettings(), "global");
  const projectLayer = readLspLayer(reader.getProjectSettings(), "project");
  const warnings = [globalLayer, projectLayer]
    .filter(
      (layer): layer is Extract<ParsedLspLayer, { readonly kind: "invalid" }> =>
        layer.kind === "invalid",
    )
    .map((layer) => layer.warning);
  const enabled = warnings.length === 0;
  return {
    enabled,
    servers: enabled ? mergeLspServers(globalLayer, projectLayer) : new Map(),
    timeouts: mergeLspTimeouts(globalLayer, projectLayer),
    warnings,
  };
}
