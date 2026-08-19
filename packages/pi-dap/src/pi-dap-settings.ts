import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const DEFAULT_DAP_TIMEOUTS = {
  executionMs: 30_000,
  requestMs: 10_000,
  shutdownMs: 5_000,
  startupMs: 10_000,
} as const;

const NonEmptyStringSchema = Type.String({ minLength: 1 });
const PositiveMillisecondsSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const JsonValueSchema = Type.Any();
const JsonObjectSchema = Type.Record(Type.String(), JsonValueSchema);
const EnvironmentSchema = Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]));
const DapAdapterDefinitionSchema = Type.Object(
  {
    args: Type.Optional(Type.Array(Type.String())),
    command: NonEmptyStringSchema,
    environment: Type.Optional(EnvironmentSchema),
    transport: JsonValueSchema,
  },
  { additionalProperties: false },
);
const DapTcpTransportSchema = Type.Object(
  {
    host: Type.Optional(NonEmptyStringSchema),
    port: Type.Optional(Type.Integer({ minimum: 0, maximum: 65_535 })),
    type: Type.Literal("tcp"),
  },
  { additionalProperties: false },
);
const DapLaunchProfileSchema = Type.Object(
  {
    adapter: NonEmptyStringSchema,
    arguments: JsonObjectSchema,
  },
  { additionalProperties: false },
);
const SettingsDocumentSchema = Type.Object({ dap: Type.Optional(JsonValueSchema) });

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
type DapAdapterDefinitionWire = Static<typeof DapAdapterDefinitionSchema>;
type DapLaunchProfileWire = Static<typeof DapLaunchProfileSchema>;
type DapTimeoutName = keyof typeof DEFAULT_DAP_TIMEOUTS;
type DapTimeoutOverrides = Partial<Record<DapTimeoutName, number>>;
type SettingsScope = "global" | "project";

const DAP_TIMEOUT_NAMES: readonly DapTimeoutName[] = [
  "executionMs",
  "requestMs",
  "shutdownMs",
  "startupMs",
];

/** Describes the configured stdio or TCP connection used by one Debug Adapter. */
export type DapAdapterTransport =
  | { readonly type: "stdio" }
  | { readonly host: string; readonly port: number; readonly type: "tcp" };

/** Contains the parsed process and transport values for one configured Debug Adapter. */
export interface DapAdapterDefinition {
  readonly args: readonly string[];
  readonly command: string;
  /** Environment overrides applied when the Debug Adapter starts; null removes an inherited key. */
  readonly environment: Readonly<Record<string, string | null>>;
  readonly id: string;
  readonly transport: DapAdapterTransport;
}

/** Contains opaque launch arguments associated with one configured Debug Adapter. */
export interface DapLaunchProfile {
  readonly adapterId: string;
  readonly arguments: JsonObject;
  readonly id: string;
}

/** Contains timeout budgets in milliseconds for Debug Adapter lifecycle operations. */
export interface DapTimeouts {
  readonly executionMs: number;
  readonly requestMs: number;
  readonly shutdownMs: number;
  readonly startupMs: number;
}

/** Reports resolved trusted DAP configuration while quarantining invalid map entries. */
export interface ResolvedDapSettings {
  readonly adapters: ReadonlyMap<string, DapAdapterDefinition>;
  readonly profiles: ReadonlyMap<string, DapLaunchProfile>;
  readonly timeouts: DapTimeouts;
  readonly warnings: readonly string[];
}

/** Reads Pi's already trust-filtered global and project settings documents. */
export interface DapSettingsReader {
  getGlobalSettings(): DapSettingsDocumentInput;
  getProjectSettings(): DapSettingsDocumentInput;
}

/** Minimal Pi settings document input carrying the extension-owned optional `dap` value. */
type PiSettingsDocument = ReturnType<SettingsManager["getGlobalSettings"]>;

/** Pi's core settings type or a test boundary document carrying the extension-owned `dap` value. */
export type DapSettingsDocumentInput = PiSettingsDocument | { readonly dap?: JsonValue };

type ParsedDapAdapter =
  | { readonly kind: "excluded" }
  | {
      readonly kind: "valid";
      readonly scope: SettingsScope;
      readonly value: DapAdapterDefinitionWire;
      readonly transport: DapAdapterTransport;
    };
type ParsedDapProfile =
  | { readonly kind: "excluded" }
  | {
      readonly kind: "valid";
      readonly scope: SettingsScope;
      readonly value: DapLaunchProfileWire;
    };

interface ParsedDapLayer {
  readonly adapters: ReadonlyMap<string, ParsedDapAdapter>;
  readonly profiles: ReadonlyMap<string, ParsedDapProfile>;
  readonly timeouts: DapTimeoutOverrides;
  readonly warnings: readonly string[];
}

interface ParsedDapAdapterTransport {
  readonly transport?: DapAdapterTransport;
  readonly warning?: string;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return Value.Check(JsonObjectSchema, value);
}

function schemaValidationWarning(
  schema:
    | typeof DapAdapterDefinitionSchema
    | typeof DapTcpTransportSchema
    | typeof DapLaunchProfileSchema
    | typeof PositiveMillisecondsSchema,
  value: JsonValue,
  prefix: string,
): string {
  const error = Value.Errors(schema, value)[0];
  const path = error?.instancePath.replaceAll("/", ".") ?? "";
  const field =
    error?.keyword === "additionalProperties"
      ? error.params.additionalProperties[0]
      : error?.keyword === "required"
        ? error.params.requiredProperties[0]
        : undefined;
  const fieldSuffix = field === undefined ? "" : `.${String(field)}`;
  return `${prefix}${path}${fieldSuffix}: ${error?.message ?? "invalid settings"}`;
}

function parseDapAdapterTransport(transport: JsonValue, path: string): ParsedDapAdapterTransport {
  if (transport === "stdio") return { transport: { type: "stdio" } };
  if (!Value.Check(DapTcpTransportSchema, transport)) {
    return {
      warning: schemaValidationWarning(DapTcpTransportSchema, transport, `${path}.transport`),
    };
  }
  return {
    transport: {
      host: transport.host ?? "127.0.0.1",
      port: transport.port ?? 0,
      type: "tcp",
    },
  };
}

function parseDapAdapters(
  value: JsonValue | undefined,
  scope: SettingsScope,
): Pick<ParsedDapLayer, "adapters" | "warnings"> {
  const adapters = new Map<string, ParsedDapAdapter>();
  const warnings: string[] = [];
  if (value === undefined) return { adapters, warnings };
  if (!isJsonObject(value)) {
    return { adapters, warnings: [`${scope} dap.adapters: expected a JSON object`] };
  }

  for (const [id, adapter] of Object.entries(value)) {
    const path = `${scope} dap.adapters.${id}`;
    if (!Value.Check(NonEmptyStringSchema, id)) {
      warnings.push(`${scope} dap.adapters: Adapter Definition ID must be a non-empty string`);
      continue;
    }
    if (adapter === null) {
      adapters.set(id, { kind: "excluded" });
      continue;
    }
    if (!Value.Check(DapAdapterDefinitionSchema, adapter)) {
      warnings.push(schemaValidationWarning(DapAdapterDefinitionSchema, adapter, path));
      adapters.set(id, { kind: "excluded" });
      continue;
    }
    const parsedTransport = parseDapAdapterTransport(adapter.transport, path);
    if (parsedTransport.transport === undefined) {
      warnings.push(parsedTransport.warning ?? `${path}.transport: invalid transport`);
      adapters.set(id, { kind: "excluded" });
      continue;
    }
    if (
      parsedTransport.transport.type === "stdio" &&
      (adapter.args ?? []).some((argument) => argument.includes("$PORT"))
    ) {
      warnings.push(`${path}.args: $PORT requires TCP transport`);
      adapters.set(id, { kind: "excluded" });
      continue;
    }
    adapters.set(id, {
      kind: "valid",
      scope,
      transport: parsedTransport.transport,
      value: adapter,
    });
  }
  return { adapters, warnings };
}

function parseDapProfiles(
  value: JsonValue | undefined,
  scope: SettingsScope,
): Pick<ParsedDapLayer, "profiles" | "warnings"> {
  const profiles = new Map<string, ParsedDapProfile>();
  const warnings: string[] = [];
  if (value === undefined) return { profiles, warnings };
  if (!isJsonObject(value)) {
    return { profiles, warnings: [`${scope} dap.profiles: expected a JSON object`] };
  }

  for (const [id, profile] of Object.entries(value)) {
    const path = `${scope} dap.profiles.${id}`;
    if (!Value.Check(NonEmptyStringSchema, id)) {
      warnings.push(`${scope} dap.profiles: Launch Profile ID must be a non-empty string`);
      continue;
    }
    if (profile === null) {
      profiles.set(id, { kind: "excluded" });
      continue;
    }
    if (!Value.Check(DapLaunchProfileSchema, profile)) {
      warnings.push(schemaValidationWarning(DapLaunchProfileSchema, profile, path));
      profiles.set(id, { kind: "excluded" });
      continue;
    }
    profiles.set(id, { kind: "valid", scope, value: profile });
  }
  return { profiles, warnings };
}

function isDapTimeoutName(name: string): name is DapTimeoutName {
  return DAP_TIMEOUT_NAMES.some((timeoutName) => timeoutName === name);
}

function parseDapTimeouts(
  value: JsonValue | undefined,
  scope: SettingsScope,
): Pick<ParsedDapLayer, "timeouts" | "warnings"> {
  const timeouts: DapTimeoutOverrides = {};
  const warnings: string[] = [];
  if (value === undefined) return { timeouts, warnings };
  if (!isJsonObject(value)) {
    return { timeouts, warnings: [`${scope} dap.timeouts: expected a JSON object`] };
  }
  for (const [name, timeout] of Object.entries(value)) {
    if (!isDapTimeoutName(name)) {
      warnings.push(`${scope} dap.timeouts.${name}: unknown field`);
      continue;
    }
    if (!Value.Check(PositiveMillisecondsSchema, timeout)) {
      warnings.push(
        schemaValidationWarning(
          PositiveMillisecondsSchema,
          timeout,
          `${scope} dap.timeouts.${name}`,
        ),
      );
      continue;
    }
    timeouts[name] = timeout;
  }
  return { timeouts, warnings };
}

function readDapLayer(settings: DapSettingsDocumentInput, scope: SettingsScope): ParsedDapLayer {
  if (!Value.Check(SettingsDocumentSchema, settings)) {
    return {
      adapters: new Map(),
      profiles: new Map(),
      timeouts: {},
      warnings: [`${scope} settings: expected a JSON object`],
    };
  }
  if (settings.dap === undefined) {
    return { adapters: new Map(), profiles: new Map(), timeouts: {}, warnings: [] };
  }
  if (!isJsonObject(settings.dap)) {
    return {
      adapters: new Map(),
      profiles: new Map(),
      timeouts: {},
      warnings: [`${scope} dap: expected a JSON object`],
    };
  }

  const unknownWarnings = Object.keys(settings.dap)
    .filter((field) => field !== "adapters" && field !== "profiles" && field !== "timeouts")
    .map((field) => `${scope} dap.${field}: unknown field`);
  const parsedAdapters = parseDapAdapters(settings.dap.adapters, scope);
  const parsedProfiles = parseDapProfiles(settings.dap.profiles, scope);
  const parsedTimeouts = parseDapTimeouts(settings.dap.timeouts, scope);
  return {
    adapters: parsedAdapters.adapters,
    profiles: parsedProfiles.profiles,
    timeouts: parsedTimeouts.timeouts,
    warnings: [
      ...unknownWarnings,
      ...parsedAdapters.warnings,
      ...parsedProfiles.warnings,
      ...parsedTimeouts.warnings,
    ],
  };
}

function mergeDapAdapters(
  globalEntries: ReadonlyMap<string, ParsedDapAdapter>,
  projectEntries: ReadonlyMap<string, ParsedDapAdapter>,
): ReadonlyMap<string, Extract<ParsedDapAdapter, { readonly kind: "valid" }>> {
  const entries = new Map<string, Extract<ParsedDapAdapter, { readonly kind: "valid" }>>();
  for (const [id, entry] of globalEntries) {
    if (entry.kind === "valid") entries.set(id, entry);
  }
  for (const [id, entry] of projectEntries) {
    entries.delete(id);
    if (entry.kind === "valid") entries.set(id, entry);
  }
  return new Map([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function mergeDapProfiles(
  globalEntries: ReadonlyMap<string, ParsedDapProfile>,
  projectEntries: ReadonlyMap<string, ParsedDapProfile>,
): ReadonlyMap<string, Extract<ParsedDapProfile, { readonly kind: "valid" }>> {
  const entries = new Map<string, Extract<ParsedDapProfile, { readonly kind: "valid" }>>();
  for (const [id, entry] of globalEntries) {
    if (entry.kind === "valid") entries.set(id, entry);
  }
  for (const [id, entry] of projectEntries) {
    entries.delete(id);
    if (entry.kind === "valid") entries.set(id, entry);
  }
  return new Map([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function resolveDapAdapter(
  id: string,
  adapter: Extract<ParsedDapAdapter, { readonly kind: "valid" }>,
): DapAdapterDefinition {
  return {
    args: [...(adapter.value.args ?? [])],
    command: adapter.value.command,
    environment: { ...adapter.value.environment },
    id,
    transport: adapter.transport,
  };
}

/** Resolve global and trusted-project DAP settings, preserving valid entries around warnings. */
export function resolveDapSettings(reader: DapSettingsReader): ResolvedDapSettings {
  const globalLayer = readDapLayer(reader.getGlobalSettings(), "global");
  const projectLayer = readDapLayer(reader.getProjectSettings(), "project");
  const mergedAdapters = mergeDapAdapters(globalLayer.adapters, projectLayer.adapters);
  const mergedProfiles = mergeDapProfiles(globalLayer.profiles, projectLayer.profiles);
  const adapters = new Map(
    [...mergedAdapters].map(([id, adapter]) => [id, resolveDapAdapter(id, adapter)]),
  );
  const profiles = new Map<string, DapLaunchProfile>();
  const referenceWarnings: string[] = [];
  for (const [id, profile] of mergedProfiles) {
    if (!adapters.has(profile.value.adapter)) {
      referenceWarnings.push(
        `${profile.scope} dap.profiles.${id}.adapter: adapter "${profile.value.adapter}" is not configured`,
      );
      continue;
    }
    profiles.set(id, {
      adapterId: profile.value.adapter,
      arguments: structuredClone(profile.value.arguments),
      id,
    });
  }

  return {
    adapters,
    profiles,
    timeouts: Object.assign({}, DEFAULT_DAP_TIMEOUTS, globalLayer.timeouts, projectLayer.timeouts),
    warnings: [...globalLayer.warnings, ...projectLayer.warnings, ...referenceWarnings],
  };
}
