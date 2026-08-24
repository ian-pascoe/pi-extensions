import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Static, Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

const DEFAULT_MCP_RETRY = {
  backoffFactor: 1.5,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxRetries: 2,
} as const;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Fixed shutdown budget for every MCP Client, in milliseconds. */
export const MCP_SHUTDOWN_TIMEOUT_MS = 5_000;

const JsonValueSchema = Type.Any();
const NonEmptyStringSchema = Type.String({ minLength: 1 });
const PositiveSafeIntegerSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const RetryCountSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const BackoffFactorSchema = Type.Number({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const StringMapSchema = Type.Record(Type.String(), Type.String());
const McpAuthWireSchema = Type.Object(
  {
    clientId: Type.Optional(Type.String()),
    clientSecret: Type.Optional(Type.String()),
    redirectUri: Type.Optional(Type.String()),
    scopes: Type.Optional(Type.Array(Type.String())),
    token: Type.Optional(Type.String()),
    type: Type.String(),
  },
  { additionalProperties: false },
);
const McpServerDefinitionWireSchema = Type.Object(
  {
    args: Type.Optional(Type.Array(Type.String())),
    auth: Type.Optional(McpAuthWireSchema),
    command: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
    environment: Type.Optional(StringMapSchema),
    headers: Type.Optional(StringMapSchema),
    transport: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const McpRetryWireSchema = Type.Object(
  {
    backoffFactor: Type.Optional(BackoffFactorSchema),
    initialDelayMs: Type.Optional(PositiveSafeIntegerSchema),
    maxDelayMs: Type.Optional(PositiveSafeIntegerSchema),
    maxRetries: Type.Optional(RetryCountSchema),
  },
  { additionalProperties: false },
);
const McpLayerWireSchema = Type.Object(
  {
    connectTimeoutMs: Type.Optional(PositiveSafeIntegerSchema),
    requestTimeoutMs: Type.Optional(PositiveSafeIntegerSchema),
    retry: Type.Optional(McpRetryWireSchema),
    servers: Type.Optional(
      Type.Record(Type.String(), Type.Union([McpServerDefinitionWireSchema, Type.Null()])),
    ),
  },
  { additionalProperties: false },
);
const SettingsDocumentSchema = Type.Object({ mcp: Type.Optional(JsonValueSchema) });

/** JSON value accepted at the Pi settings boundary. */
export type McpSettingsJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly McpSettingsJsonValue[]
  | { readonly [key: string]: McpSettingsJsonValue };

type PiSettingsDocument = ReturnType<SettingsManager["getGlobalSettings"]>;
type McpLayerWire = Static<typeof McpLayerWireSchema>;
type McpServerDefinitionWire = Static<typeof McpServerDefinitionWireSchema>;
type McpSettingsScope = "global" | "project";

/** Pi settings document or a test boundary document carrying the package-owned `mcp` field. */
export type McpSettingsDocumentInput = PiSettingsDocument | { readonly mcp?: McpSettingsJsonValue };

/** Reads Pi's already trust-filtered global and project settings layers. */
export interface McpSettingsReader {
  getGlobalSettings(): McpSettingsDocumentInput;
  getProjectSettings(): McpSettingsDocumentInput;
}

/** Host-wide retry policy shared by every MCP Server connection. */
export interface McpRetrySettings {
  readonly backoffFactor: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxRetries: number;
}

/** Authentication behavior for one remote MCP Server. */
export type McpServerAuth =
  | { readonly type: "none" }
  | { readonly token: string; readonly type: "bearer" }
  | {
      readonly clientId?: string;
      readonly clientSecret?: string;
      readonly redirectUri?: string;
      readonly scopes: readonly string[];
      readonly type: "oauth";
    };

interface ParsedMcpOAuthAuth {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes: string[];
  type: "oauth";
}

interface McpServerDefinitionBase {
  readonly enabled: boolean;
  readonly id: string;
  readonly provenance: McpSettingsScope;
}

/** Validated local or remote MCP Server connection definition. */
export type McpServerDefinition =
  | (McpServerDefinitionBase & {
      readonly args: readonly string[];
      readonly command: string;
      readonly cwd?: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly transport: "stdio";
    })
  | (McpServerDefinitionBase & {
      readonly auth?: McpServerAuth;
      readonly headers: Readonly<Record<string, string>>;
      readonly transport: "http" | "sse";
      readonly url: string;
    });

/** Records a project-layer mask that hides an inherited Server Definition. */
export interface McpServerMask {
  readonly id: string;
  readonly inherited: boolean;
  readonly provenance: "project";
}

/** Path-qualified, non-sensitive MCP settings failure. */
export class McpSettingsError extends Error {
  readonly _tag = "McpSettingsError" as const;

  constructor(
    /** JSON-style path to the invalid MCP setting. */
    readonly path: string,
    message: string,
  ) {
    super(`MCP settings invalid at ${path}: ${message}`);
  }
}

/** Holds effective secret and interpolated values privately for safe diagnostics. */
export class McpResolvedSecrets {
  private readonly matcher: RegExp | undefined;

  /** Build a redactor from effective values that diagnostics must not expose. */
  constructor(values: Iterable<string> = []) {
    const alternatives = [...new Set(values)]
      .filter((value) => value.length > 0)
      .sort((left, right) => right.length - left.length)
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    this.matcher = alternatives.length === 0 ? undefined : new RegExp(alternatives.join("|"), "gu");
  }

  /** Replace every tracked non-empty effective value with a stable marker. */
  redact(text: string): string {
    return this.matcher === undefined ? text : text.replace(this.matcher, "[REDACTED]");
  }
}

/** Effective trusted MCP settings; invalid input leaves Server Definitions disabled. */
export interface ResolvedMcpSettings {
  readonly connectTimeoutMs: number;
  readonly errors: readonly McpSettingsError[];
  readonly masks: ReadonlyMap<string, McpServerMask>;
  readonly requestTimeoutMs: number;
  readonly retry: McpRetrySettings;
  readonly secrets: McpResolvedSecrets;
  readonly servers: ReadonlyMap<string, McpServerDefinition>;
  readonly valid: boolean;
}

interface ParsedMcpLayer {
  readonly errors: readonly McpSettingsError[];
  readonly scope: McpSettingsScope;
  readonly value: McpLayerWire;
}

type ParsedServerDefinition =
  | { readonly error: McpSettingsError }
  | { readonly value: McpServerDefinition };

interface MergedServerDefinitions {
  readonly errors: readonly McpSettingsError[];
  readonly masks: ReadonlyMap<string, McpServerMask>;
  readonly servers: ReadonlyMap<string, McpServerDefinition>;
}

type InterpolatedServerDefinition =
  | { readonly error: McpSettingsError }
  | { readonly value: McpServerDefinitionWire };

type InterpolatedMcpValue =
  | { readonly error: McpSettingsError }
  | { readonly value: McpSettingsJsonValue };

const MCP_ENVIRONMENT_TEMPLATE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function schemaSettingsError(
  schema: TSchema,
  value: McpSettingsJsonValue,
  path: string,
): McpSettingsError {
  const issue = Value.Errors(schema, value)[0];
  const instancePath = issue?.instancePath.replaceAll("/", ".") ?? "";
  const field =
    issue?.keyword === "additionalProperties"
      ? issue.params.additionalProperties[0]
      : issue?.keyword === "required"
        ? issue.params.requiredProperties[0]
        : undefined;
  const suffix = field === undefined ? "" : `.${String(field)}`;
  return new McpSettingsError(`${path}${instancePath}${suffix}`, issue?.message ?? "invalid value");
}

function interpolateMcpString(
  value: string,
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
  secrets: Set<string>,
): InterpolatedMcpValue {
  let missingVariable: string | undefined;
  const interpolated = value.replace(MCP_ENVIRONMENT_TEMPLATE, (template, variableName: string) => {
    const resolved = environment[variableName];
    if (resolved === undefined) {
      missingVariable ??= variableName;
      return template;
    }
    if (resolved.length > 0) secrets.add(resolved);
    return resolved;
  });
  return missingVariable === undefined
    ? { value: interpolated }
    : {
        error: new McpSettingsError(path, `environment variable ${missingVariable} is not defined`),
      };
}

// oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: McpServerDefinitionWireSchema parses the complete value before this recursive interpolation boundary.
function interpolateMcpValue(
  value: unknown,
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
  secrets: Set<string>,
): InterpolatedMcpValue {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: The owning Server Definition schema already established the recursive JSON representation.
  if (typeof value === "string") {
    return interpolateMcpString(value, path, environment, secrets);
  }
  if (Array.isArray(value)) {
    const interpolated: McpSettingsJsonValue[] = [];
    for (const [index, item] of value.entries()) {
      const result = interpolateMcpValue(item, `${path}.${index}`, environment, secrets);
      if ("error" in result) return result;
      interpolated.push(result.value);
    }
    return { value: interpolated };
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: The owning Server Definition schema already established the recursive JSON representation.
  if (value !== null && typeof value === "object") {
    const interpolated: Record<string, McpSettingsJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = interpolateMcpValue(item, `${path}.${key}`, environment, secrets);
      if ("error" in result) return result;
      interpolated[key] = result.value;
    }
    return { value: interpolated };
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: The owning Server Definition schema already established the recursive JSON representation.
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return { value };
  }
  return {
    error: new McpSettingsError(path, "expected a JSON Server Definition value"),
  };
}
// oxlint-enable anti-slop/no-unknown-parameters

function interpolateServerDefinition(
  wire: McpServerDefinitionWire,
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
  secrets: Set<string>,
): InterpolatedServerDefinition {
  const result = interpolateMcpValue(wire, path, environment, secrets);
  if ("error" in result) return result;
  if (!Value.Check(McpServerDefinitionWireSchema, result.value)) {
    return {
      error: new McpSettingsError(path, "environment interpolation produced an invalid value"),
    };
  }
  return { value: result.value };
}

function parseMcpLayer(
  document: McpSettingsDocumentInput,
  scope: McpSettingsScope,
): ParsedMcpLayer {
  if (!Value.Check(SettingsDocumentSchema, document)) {
    return {
      errors: [new McpSettingsError(`${scope} settings`, "expected a JSON object")],
      scope,
      value: {},
    };
  }
  if (document.mcp === undefined) return { errors: [], scope, value: {} };
  if (!Value.Check(McpLayerWireSchema, document.mcp)) {
    return {
      errors: [schemaSettingsError(McpLayerWireSchema, document.mcp, `${scope} mcp`)],
      scope,
      value: {},
    };
  }
  return { errors: [], scope, value: document.mcp };
}

function parseRemoteUrl(value: string, path: string): string | McpSettingsError {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return new McpSettingsError(path, "URL protocol must be http or https");
    }
    return url.toString();
  } catch {
    return new McpSettingsError(path, "expected an absolute HTTP URL");
  }
}

function parseOAuthRedirectUri(value: string, path: string): string | McpSettingsError {
  try {
    const url = new URL(value);
    const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
    if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
      return new McpSettingsError(path, "expected an HTTP loopback redirect URI");
    }
    return url.toString();
  } catch {
    return new McpSettingsError(path, "expected an HTTP loopback redirect URI");
  }
}

function parseServerAuth(
  wire: McpServerDefinitionWire["auth"],
  headers: Readonly<Record<string, string>>,
  path: string,
): McpServerAuth | McpSettingsError | undefined {
  if (wire === undefined) return undefined;
  if (wire.type === "none") {
    return Object.keys(wire).length === 1
      ? { type: "none" }
      : new McpSettingsError(path, "none authentication accepts only the type field");
  }
  if (wire.type === "bearer") {
    if (!Value.Check(NonEmptyStringSchema, wire.token)) {
      return new McpSettingsError(`${path}.token`, "must be a non-empty string");
    }
    if (
      wire.clientId !== undefined ||
      wire.clientSecret !== undefined ||
      wire.redirectUri !== undefined ||
      wire.scopes !== undefined
    ) {
      return new McpSettingsError(path, "bearer authentication accepts only type and token");
    }
    const authorizationHeader = Object.keys(headers).find(
      (name) => name.toLowerCase() === "authorization",
    );
    if (authorizationHeader !== undefined) {
      return new McpSettingsError(
        `${path.replace(/\.auth$/, "")}.headers.${authorizationHeader}`,
        "Authorization header conflicts with bearer authentication",
      );
    }
    return { token: wire.token, type: "bearer" };
  }
  if (wire.type !== "oauth") {
    return new McpSettingsError(`${path}.type`, "expected none, bearer, or oauth");
  }
  if (wire.token !== undefined) {
    return new McpSettingsError(path, "oauth authentication does not accept token");
  }
  for (const [name, value] of [
    ["clientId", wire.clientId],
    ["clientSecret", wire.clientSecret],
  ] as const) {
    if (value !== undefined && value.length === 0) {
      return new McpSettingsError(`${path}.${name}`, "must not be empty");
    }
  }
  if (wire.clientSecret !== undefined && wire.clientId === undefined) {
    return new McpSettingsError(`${path}.clientId`, "is required with clientSecret");
  }
  if ((wire.scopes ?? []).some((scope) => scope.length === 0)) {
    return new McpSettingsError(`${path}.scopes`, "scope values must not be empty");
  }
  let redirectUri: string | undefined;
  if (wire.redirectUri !== undefined) {
    const parsedRedirectUri = parseOAuthRedirectUri(wire.redirectUri, `${path}.redirectUri`);
    if (parsedRedirectUri instanceof McpSettingsError) return parsedRedirectUri;
    redirectUri = parsedRedirectUri;
  }
  const oauth: ParsedMcpOAuthAuth = {
    scopes: [...(wire.scopes ?? [])],
    type: "oauth",
  };
  if (wire.clientId !== undefined) oauth.clientId = wire.clientId;
  if (wire.clientSecret !== undefined) oauth.clientSecret = wire.clientSecret;
  if (redirectUri !== undefined) oauth.redirectUri = redirectUri;
  return oauth;
}

function parseServerDefinition(
  id: string,
  wire: McpServerDefinitionWire,
  scope: McpSettingsScope,
  secrets: Set<string>,
): ParsedServerDefinition {
  const path = `${scope} mcp.servers.${id}`;
  const hasCommand = wire.command !== undefined;
  const hasUrl = wire.url !== undefined;
  if (hasCommand === hasUrl) {
    return {
      error: new McpSettingsError(path, "exactly one of command or url is required"),
    };
  }

  const transport = wire.transport ?? (hasCommand ? "stdio" : "http");
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
    return { error: new McpSettingsError(`${path}.transport`, "expected stdio, http, or sse") };
  }
  if (hasCommand && transport !== "stdio") {
    return { error: new McpSettingsError(`${path}.transport`, "command requires stdio") };
  }
  if (hasUrl && transport === "stdio") {
    return { error: new McpSettingsError(`${path}.transport`, "url requires http or sse") };
  }

  const common = { enabled: wire.enabled ?? true, id, provenance: scope } as const;
  if (hasCommand) {
    if (!Value.Check(NonEmptyStringSchema, wire.command)) {
      return { error: new McpSettingsError(`${path}.command`, "must not be empty") };
    }
    if (wire.headers !== undefined || wire.auth !== undefined) {
      return {
        error: new McpSettingsError(path, "stdio definitions cannot contain headers or auth"),
      };
    }
    const environment = { ...wire.environment };
    for (const value of Object.values(environment)) {
      if (value.length > 0) secrets.add(value);
    }
    const stdio = {
      ...common,
      args: [...(wire.args ?? [])],
      command: wire.command,
      environment,
      transport: "stdio" as const,
    };
    return wire.cwd === undefined ? { value: stdio } : { value: { ...stdio, cwd: wire.cwd } };
  }

  if (
    wire.args !== undefined ||
    wire.cwd !== undefined ||
    wire.environment !== undefined ||
    wire.command !== undefined
  ) {
    return {
      error: new McpSettingsError(
        path,
        "http and sse definitions cannot contain command, args, cwd, or environment",
      ),
    };
  }
  if (transport === "stdio") {
    return { error: new McpSettingsError(`${path}.transport`, "url requires http or sse") };
  }
  const remoteTransport: "http" | "sse" = transport === "sse" ? "sse" : "http";
  const parsedUrl = parseRemoteUrl(wire.url ?? "", `${path}.url`);
  if (parsedUrl instanceof McpSettingsError) return { error: parsedUrl };
  const headers = { ...wire.headers };
  const auth = parseServerAuth(wire.auth, headers, `${path}.auth`);
  if (auth instanceof McpSettingsError) return { error: auth };
  secrets.add(parsedUrl);
  for (const value of Object.values(headers)) {
    if (value.length > 0) secrets.add(value);
  }
  if (auth?.type === "bearer") secrets.add(auth.token);
  if (auth?.type === "oauth" && auth.clientSecret !== undefined) secrets.add(auth.clientSecret);
  const remote = {
    ...common,
    headers,
    transport: remoteTransport,
    url: parsedUrl,
  };
  return auth === undefined ? { value: remote } : { value: { ...remote, auth } };
}

function mergeServerDefinitions(
  globalLayer: ParsedMcpLayer,
  projectLayer: ParsedMcpLayer,
  environment: Readonly<Record<string, string | undefined>>,
  secrets: Set<string>,
): MergedServerDefinitions {
  const definitions = new Map<string, { scope: McpSettingsScope; wire: McpServerDefinitionWire }>();
  const masks = new Map<string, McpServerMask>();
  const errors: McpSettingsError[] = [];
  for (const [id, wire] of Object.entries(globalLayer.value.servers ?? {})) {
    if (id.length === 0) {
      errors.push(new McpSettingsError("global mcp.servers", "Server Definition ID is empty"));
    } else if (wire === null || (wire.enabled === false && Object.keys(wire).length === 1)) {
      errors.push(
        new McpSettingsError(
          `global mcp.servers.${id}`,
          "a mask is valid only in project settings",
        ),
      );
    } else {
      definitions.set(id, { scope: "global", wire });
    }
  }
  for (const [id, wire] of Object.entries(projectLayer.value.servers ?? {})) {
    const inherited = definitions.has(id);
    definitions.delete(id);
    masks.delete(id);
    if (id.length === 0) {
      errors.push(new McpSettingsError("project mcp.servers", "Server Definition ID is empty"));
    } else if (wire === null || (wire.enabled === false && Object.keys(wire).length === 1)) {
      masks.set(id, { id, inherited, provenance: "project" });
    } else {
      definitions.set(id, { scope: "project", wire });
    }
  }

  const servers = new Map<string, McpServerDefinition>();
  for (const [id, configured] of [...definitions].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const path = `${configured.scope} mcp.servers.${id}`;
    const interpolated = interpolateServerDefinition(configured.wire, path, environment, secrets);
    if ("error" in interpolated) {
      errors.push(interpolated.error);
      continue;
    }
    const parsed = parseServerDefinition(id, interpolated.value, configured.scope, secrets);
    if ("error" in parsed) errors.push(parsed.error);
    else servers.set(id, parsed.value);
  }
  return {
    errors,
    masks: new Map([...masks].sort(([left], [right]) => left.localeCompare(right))),
    servers,
  };
}

/** Merge and parse global plus trusted-project MCP settings without starting any MCP Server. */
export function resolveMcpSettings(
  reader: McpSettingsReader,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedMcpSettings {
  const globalLayer = parseMcpLayer(reader.getGlobalSettings(), "global");
  const projectLayer = parseMcpLayer(reader.getProjectSettings(), "project");
  const layerErrors = [...globalLayer.errors, ...projectLayer.errors];
  const secretValues = new Set<string>();
  const mergedServers = mergeServerDefinitions(
    globalLayer,
    projectLayer,
    environment,
    secretValues,
  );
  const retry = Object.assign(
    {},
    DEFAULT_MCP_RETRY,
    globalLayer.value.retry,
    projectLayer.value.retry,
  );
  const retryRangeErrors =
    retry.initialDelayMs <= retry.maxDelayMs
      ? []
      : [new McpSettingsError("mcp.retry.initialDelayMs", "must not exceed mcp.retry.maxDelayMs")];
  const errors = [...layerErrors, ...mergedServers.errors, ...retryRangeErrors];
  return {
    connectTimeoutMs:
      projectLayer.value.connectTimeoutMs ??
      globalLayer.value.connectTimeoutMs ??
      DEFAULT_CONNECT_TIMEOUT_MS,
    errors,
    masks: errors.length === 0 ? mergedServers.masks : new Map(),
    requestTimeoutMs:
      projectLayer.value.requestTimeoutMs ??
      globalLayer.value.requestTimeoutMs ??
      DEFAULT_REQUEST_TIMEOUT_MS,
    retry,
    secrets: new McpResolvedSecrets(secretValues),
    servers: errors.length === 0 ? mergedServers.servers : new Map(),
    valid: errors.length === 0,
  };
}
