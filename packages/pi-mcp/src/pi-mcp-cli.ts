#!/usr/bin/env node

// oxlint-disable anti-slop/no-conditional-empty-object-spread -- Exact optional command data requires omitting absent fields at the shared command boundary.
// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- This entrypoint owns recursive JSON and trust-store parsing before values reach typed settings adapters.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  runMcpCommandLine,
  type McpCommandAdapterResult,
  type McpCommandAdapters,
  type McpCommandJsonValue,
} from "./mcp-command.js";
import { McpAuthStore } from "./mcp-auth-store.js";
import {
  authenticateMcpOAuth,
  DEFAULT_MCP_OAUTH_REDIRECT_URL,
  McpOAuthProvider,
} from "./mcp-oauth.js";
import { McpServerClient } from "./mcp-server-client.js";
import {
  McpSettingsStore,
  type McpSettingsScope,
  type McpStoreJsonObject,
  type McpStoreJsonValue,
} from "./mcp-settings-store.js";
import {
  resolveMcpSettings,
  type McpServerDefinition,
  type ResolvedMcpSettings,
} from "./pi-mcp-settings.js";

const HELP = `Usage: pi-mcp <command> [options]

Commands:
  list                 List effective MCP Server Definitions without connecting
  add                  Add or replace a Server Definition
  remove               Remove a Server Definition
  enable               Enable a Server Definition
  disable              Disable a Server Definition
  auth                 Authenticate an OAuth Server Definition
  logout               Remove stored OAuth credentials
  test                 Test one server, or every enabled server with --all

Options:
  -h, --help           Show this help message
  -a, --approve        Trust project settings for this invocation
  -na, --no-approve    Ignore project settings for this invocation
`;

/** Terminal and construction effects used by the standalone MCP command adapter. */
export interface PiMcpCliOptions {
  /** Build persistent, authentication, and temporary-test command adapters. */
  readonly createAdapters?: (projectTrusted?: boolean) => Promise<McpCommandAdapters>;
  /** Write command failures and usage text. */
  readonly writeStderr?: (text: string) => void;
  /** Write successful command output and help text. */
  readonly writeStdout?: (text: string) => void;
}

function commandSuccess(message: string, data?: McpCommandJsonValue): McpCommandAdapterResult {
  return { ...(data === undefined ? {} : { data }), message, ok: true };
}

function commandFailure(
  category: "authentication" | "connection" | "runtime" | "settings",
  message: string,
): McpCommandAdapterResult {
  return { category, message, ok: false };
}

function parseMcpStoreJsonValue(value: unknown): McpStoreJsonValue | undefined {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const values: McpStoreJsonValue[] = [];
    for (const item of value) {
      const parsed = parseMcpStoreJsonValue(item);
      if (parsed === undefined) return undefined;
      values.push(parsed);
    }
    return values;
  }
  if (typeof value !== "object") return undefined;
  const object: Record<string, McpStoreJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const parsed = parseMcpStoreJsonValue(item);
    if (parsed === undefined) return undefined;
    object[key] = parsed;
  }
  return object;
}

function parseMcpStoreJsonObject(value: unknown): McpStoreJsonObject | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object: Record<string, McpStoreJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const parsed = parseMcpStoreJsonValue(item);
    if (parsed === undefined) return undefined;
    object[key] = parsed;
  }
  return object;
}

async function readSavedProjectTrust(agentDirectory: string, cwd: string): Promise<boolean> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(join(agentDirectory, "trust.json"), "utf8"));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    return false;
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) return false;
  let path = resolve(cwd);
  while (true) {
    const decision = Object.hasOwn(document, path)
      ? Object.getOwnPropertyDescriptor(document, path)?.value
      : undefined;
    if (decision === true || decision === false) return decision;
    const parent = dirname(path);
    if (parent === path) return false;
    path = parent;
  }
}

function readPiMcpCliOAuthPaste(signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolveInput, rejectInput) => {
    let input = "";
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      process.stdin.pause();
    };
    const onData = (chunk: Buffer | string): void => {
      input += chunk.toString();
    };
    const onEnd = (): void => {
      cleanup();
      resolveInput(input.trim());
    };
    const onError = (): void => {
      cleanup();
      rejectInput(new Error("Pi MCP OAuth callback input failed"));
    };
    const onAbort = (): void => {
      cleanup();
      rejectInput(signal.reason);
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    process.stdin.resume();
  });
}

function authClientIdentity(definition: McpServerDefinition): string {
  return definition.transport === "stdio" || definition.auth?.type !== "oauth"
    ? "@ian-pascoe/pi-mcp"
    : (definition.auth.clientId ?? "@ian-pascoe/pi-mcp");
}

interface StandaloneMcpState {
  readonly authStore: McpAuthStore;
  readonly settingsStore: McpSettingsStore;
}

async function readStandaloneSettings(state: StandaloneMcpState): Promise<{
  readonly settings?: ResolvedMcpSettings;
  readonly failure?: McpCommandAdapterResult;
}> {
  const layers = await state.settingsStore.readLayers();
  if (!layers.ok) return { failure: commandFailure("settings", layers.error.message) };
  const settings = resolveMcpSettings({
    getGlobalSettings: () => layers.value.global.document,
    getProjectSettings: () => layers.value.project?.document ?? {},
  });
  if (!settings.valid) {
    return {
      failure: commandFailure("settings", settings.errors.map((error) => error.message).join("; ")),
    };
  }
  return { settings };
}

async function listStandaloneServers(state: StandaloneMcpState): Promise<McpCommandAdapterResult> {
  const resolved = await readStandaloneSettings(state);
  if (resolved.failure !== undefined) return resolved.failure;
  const settings = resolved.settings;
  if (settings === undefined) return commandFailure("runtime", "settings resolution failed");
  const servers: McpCommandJsonValue[] = [];
  const messages: string[] = [];
  for (const definition of settings.servers.values()) {
    let storedAuth = false;
    if (definition.transport !== "stdio") {
      const stored = await state.authStore.readEntry({
        clientIdentity: authClientIdentity(definition),
        serverUrl: definition.url,
      });
      if (!stored.ok) return commandFailure("authentication", stored.error.message);
      storedAuth = stored.value !== undefined;
    }
    servers.push({
      auth: definition.transport === "stdio" ? "none" : (definition.auth?.type ?? "anonymous"),
      enabled: definition.enabled,
      name: definition.id,
      provenance: definition.provenance,
      storedAuth,
      transport: definition.transport,
    });
    messages.push(
      `${definition.id} (${definition.provenance}, ${definition.enabled ? "enabled" : "disabled"})`,
    );
  }
  for (const mask of settings.masks.values()) {
    servers.push({
      enabled: false,
      inherited: mask.inherited,
      masked: true,
      name: mask.id,
      provenance: mask.provenance,
    });
    messages.push(`${mask.id} (${mask.provenance}, disabled mask)`);
  }
  const message =
    messages.length === 0 ? "No MCP Server Definitions configured" : messages.join("\n");
  return commandSuccess(message, { servers });
}

function settingsMutationResult(
  result: Awaited<ReturnType<McpSettingsStore["removeServerDefinition"]>>,
  action: string,
): McpCommandAdapterResult {
  return result.ok
    ? commandSuccess(
        `${action} ${result.value.changed ? "updated" : "unchanged"}: ${result.value.path}`,
      )
    : commandFailure("settings", result.error.message);
}

async function enabledServerDefinitions(
  state: StandaloneMcpState,
  selected: string | undefined,
): Promise<
  | { readonly ok: true; readonly definitions: readonly McpServerDefinition[] }
  | { readonly ok: false; readonly failure: McpCommandAdapterResult }
> {
  const resolved = await readStandaloneSettings(state);
  if (resolved.failure !== undefined) return { failure: resolved.failure, ok: false };
  const settings = resolved.settings;
  if (settings === undefined) {
    return { failure: commandFailure("runtime", "settings resolution failed"), ok: false };
  }
  if (selected === undefined) {
    return {
      definitions: [...settings.servers.values()].filter(({ enabled }) => enabled),
      ok: true,
    };
  }
  const definition = settings.servers.get(selected);
  return definition === undefined
    ? { failure: commandFailure("settings", `unknown MCP Server ${selected}`), ok: false }
    : { definitions: [definition], ok: true };
}

async function testServerDefinition(
  definition: McpServerDefinition,
  settings: ResolvedMcpSettings,
  cwd: string,
  authStore: McpAuthStore,
): Promise<McpCommandAdapterResult> {
  let client: McpServerClient | undefined;
  try {
    const oauth =
      definition.transport !== "stdio" && definition.auth?.type === "oauth"
        ? definition.auth
        : undefined;
    const authProvider =
      definition.transport === "stdio" ||
      definition.auth?.type === "none" ||
      definition.auth?.type === "bearer"
        ? undefined
        : new McpOAuthProvider({
            authStore,
            clientIdentity: authClientIdentity(definition),
            ...(oauth?.clientId === undefined ? {} : { clientId: oauth.clientId }),
            ...(oauth?.clientSecret === undefined ? {} : { clientSecret: oauth.clientSecret }),
            onAuthorizationUrl: () => undefined,
            redirectUrl: oauth?.redirectUri ?? DEFAULT_MCP_OAUTH_REDIRECT_URL,
            scopes: oauth?.scopes ?? [],
            serverUrl: definition.url,
          });
    const connectOptions = {
      clientInfo: { name: "pi-mcp", version: "0.1.0" },
      connectTimeoutMs: settings.connectTimeoutMs,
      definition,
      piCwd: cwd,
      requestTimeoutMs: settings.requestTimeoutMs,
      serverId: definition.id,
    };
    client = await McpServerClient.connect(
      authProvider === undefined ? connectOptions : { ...connectOptions, authProvider },
    );
    return commandSuccess(
      `${definition.id}: connected (${client.negotiatedProtocolVersion ?? "unknown protocol"})`,
      {
        connected: true,
        protocolVersion: client.negotiatedProtocolVersion ?? null,
        server: definition.id,
      },
    );
  } catch {
    return commandFailure("connection", `${definition.id}: connection failed`);
  } finally {
    await client?.close();
  }
}

async function removeStandaloneServer(
  state: StandaloneMcpState,
  options: Parameters<McpCommandAdapters["settings"]["remove"]>[0],
): Promise<McpCommandAdapterResult> {
  if (options.logout) {
    const resolved = await readStandaloneSettings(state);
    if (resolved.failure !== undefined) return resolved.failure;
    const definition = resolved.settings?.servers.get(options.name);
    if (definition === undefined) {
      return commandFailure("settings", `unknown MCP Server ${options.name}`);
    }
    if (definition.transport !== "stdio") {
      const removed = await state.authStore.removeEntry({
        clientIdentity: authClientIdentity(definition),
        serverUrl: definition.url,
      });
      if (!removed.ok) return commandFailure("authentication", removed.error.message);
    }
  }
  return settingsMutationResult(
    await state.settingsStore.removeServerDefinition(options.scope, options.name),
    `MCP Server ${options.name}`,
  );
}

/** Paths and trust state used to compose standalone-compatible command adapters. */
export interface StandaloneMcpCommandAdapterOptions {
  /** Pi's global agent directory containing settings and authentication state. */
  readonly agentDirectory?: string;
  /** Working directory that owns optional project MCP settings. */
  readonly cwd?: string;
  /** Whether project-local settings and mutations are trusted for this invocation. */
  readonly projectTrusted?: boolean;
  /** Read a pasted OAuth callback when command flags did not supply one. */
  readonly waitForOAuthPaste?: (signal: AbortSignal) => Promise<string>;
  /** Print the OAuth authorization URL before any browser opener runs. */
  readonly writeAuthorizationUrl?: (url: string) => void | Promise<void>;
}

/** Build plain-Node persistent and test adapters without importing the Pi runtime. */
export async function createStandaloneMcpCommandAdapters(
  options?: StandaloneMcpCommandAdapterOptions,
): Promise<McpCommandAdapters> {
  const agentDirectory =
    options?.agentDirectory ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const cwd = options?.cwd ?? process.cwd();
  const projectTrusted =
    options?.projectTrusted ?? (await readSavedProjectTrust(agentDirectory, cwd));
  const state: StandaloneMcpState = {
    authStore: new McpAuthStore(agentDirectory),
    settingsStore: new McpSettingsStore({ agentDirectory, cwd, projectTrusted }),
  };
  const scope = (value: "global" | "project"): McpSettingsScope => value;
  return {
    auth: {
      authenticate: async (command) => {
        const selected = await enabledServerDefinitions(state, command.server);
        if (!selected.ok) return selected.failure;
        const definition = selected.definitions[0];
        if (
          definition === undefined ||
          definition.transport === "stdio" ||
          definition.auth?.type === "none" ||
          definition.auth?.type === "bearer"
        ) {
          return commandFailure(
            "authentication",
            `MCP Server ${command.server} is not configured for OAuth`,
          );
        }
        const suppliedPaste =
          command.callback ??
          (command.code === undefined || command.state === undefined
            ? undefined
            : `${command.code} ${command.state}`);
        const oauth = definition.auth?.type === "oauth" ? definition.auth : undefined;
        const result = await authenticateMcpOAuth({
          authStore: state.authStore,
          clientIdentity: authClientIdentity(definition),
          ...(oauth?.clientId === undefined ? {} : { clientId: oauth.clientId }),
          ...(oauth?.clientSecret === undefined ? {} : { clientSecret: oauth.clientSecret }),
          noOpen: command.noOpen,
          ...(oauth?.redirectUri === undefined ? {} : { redirectUrl: oauth.redirectUri }),
          scopes: oauth?.scopes ?? [],
          serverId: definition.id,
          serverUrl: definition.url,
          waitForPaste:
            suppliedPaste === undefined
              ? (options?.waitForOAuthPaste ?? readPiMcpCliOAuthPaste)
              : async () => suppliedPaste,
          writeAuthorizationUrl:
            options?.writeAuthorizationUrl ?? ((url) => void process.stdout.write(`${url}\n`)),
        });
        return result.ok
          ? commandSuccess(`${command.server}: authenticated`)
          : commandFailure("authentication", result.error.message);
      },
      logout: async (options) => {
        if (options.all && options.force) {
          const reset = await state.authStore.forceReset();
          return reset.ok
            ? commandSuccess("MCP authentication store reset")
            : commandFailure("authentication", reset.error.message);
        }
        const selected = await enabledServerDefinitions(state, options.server);
        if (!selected.ok) return selected.failure;
        const definition = selected.definitions[0];
        if (definition === undefined || definition.transport === "stdio") {
          return commandFailure(
            "authentication",
            `MCP Server ${options.server} has no remote credentials`,
          );
        }
        const removed = await state.authStore.removeEntry({
          clientIdentity: authClientIdentity(definition),
          serverUrl: definition.url,
        });
        return removed.ok
          ? commandSuccess(`${options.server}: logged out`)
          : commandFailure("authentication", removed.error.message);
      },
    },
    live: undefined,
    settings: {
      add: async (options) => {
        const definition = parseMcpStoreJsonObject(options.definition);
        if (definition === undefined)
          return commandFailure("settings", "invalid Server Definition");
        return settingsMutationResult(
          await state.settingsStore.setServerDefinition(
            scope(options.scope),
            options.name,
            definition,
          ),
          `MCP Server ${options.name}`,
        );
      },
      disable: async (options) => {
        const resolved = await readStandaloneSettings(state);
        if (resolved.failure !== undefined) return resolved.failure;
        const inherited =
          options.scope === "project" &&
          resolved.settings?.servers.get(options.name)?.provenance === "global";
        return settingsMutationResult(
          await state.settingsStore.disableServerDefinition(
            scope(options.scope),
            options.name,
            inherited,
          ),
          `MCP Server ${options.name}`,
        );
      },
      enable: async (options) =>
        settingsMutationResult(
          await state.settingsStore.enableServerDefinition(scope(options.scope), options.name),
          `MCP Server ${options.name}`,
        ),
      list: () => listStandaloneServers(state),
      remove: async (options) => removeStandaloneServer(state, options),
    },
    test: {
      test: async (options) => {
        const resolved = await readStandaloneSettings(state);
        if (resolved.failure !== undefined) return resolved.failure;
        const settings = resolved.settings;
        if (settings === undefined) return commandFailure("runtime", "settings resolution failed");
        const selected = await enabledServerDefinitions(
          state,
          options.all ? undefined : options.server,
        );
        if (!selected.ok) return selected.failure;
        const results: McpCommandJsonValue[] = [];
        const messages: string[] = [];
        for (const definition of selected.definitions) {
          const result = await testServerDefinition(definition, settings, cwd, state.authStore);
          if (!result.ok) return result;
          messages.push(result.message);
          results.push(result.data ?? null);
        }
        return commandSuccess(messages.join("\n") || "No enabled MCP Servers", { results });
      },
    },
  };
}

function mcpCommandLineFromArgv(args: readonly string[]): string {
  return args
    .map((argument) => `"${argument.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
    .join(" ");
}

interface PiMcpTrustOverride {
  readonly args: readonly string[];
  readonly projectTrusted?: boolean;
}

function parsePiMcpTrustOverride(args: readonly string[]): PiMcpTrustOverride | undefined {
  const filtered: string[] = [];
  let projectTrusted: boolean | undefined;
  for (const argument of args) {
    const decision =
      argument === "--approve" || argument === "-a"
        ? true
        : argument === "--no-approve" || argument === "-na"
          ? false
          : undefined;
    if (decision === undefined) {
      filtered.push(argument);
      continue;
    }
    if (projectTrusted !== undefined && projectTrusted !== decision) return undefined;
    projectTrusted = decision;
  }
  return projectTrusted === undefined ? { args: filtered } : { args: filtered, projectTrusted };
}

/** Run the standalone CLI and return a stable process exit code. */
export async function runPiMcpCli(
  args: readonly string[],
  options: PiMcpCliOptions = {},
): Promise<number> {
  const writeStdout = options.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr = options.writeStderr ?? ((text: string) => process.stderr.write(text));
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    writeStdout(HELP);
    return 0;
  }
  const parsedTrust = parsePiMcpTrustOverride(args);
  if (parsedTrust === undefined) {
    writeStderr("Pi MCP: --approve and --no-approve cannot be combined\n");
    return 2;
  }
  const adapters =
    options.createAdapters === undefined
      ? await createStandaloneMcpCommandAdapters(
          parsedTrust.projectTrusted === undefined
            ? undefined
            : { projectTrusted: parsedTrust.projectTrusted },
        )
      : await options.createAdapters(parsedTrust.projectTrusted);
  const result = await runMcpCommandLine(
    mcpCommandLineFromArgv(parsedTrust.args),
    "standalone",
    adapters,
  );
  (result.ok ? writeStdout : writeStderr)(result.output);
  return result.exitCode;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void runPiMcpCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      process.stderr.write("Pi MCP: command failed unexpectedly\n");
      process.exitCode = 6;
    },
  );
}
