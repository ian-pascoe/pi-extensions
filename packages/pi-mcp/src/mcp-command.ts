/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- Exact optional command fields are assembled only when their argv values are present. */
/* oxlint-disable anti-slop/no-runtime-typeof -- This module is the owning parser boundary for raw command-line strings and tagged parser results. */

/** JSON data returned by a command adapter and rendered by the shared command runner. */
export type McpCommandJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly McpCommandJsonValue[]
  | { readonly [key: string]: McpCommandJsonValue };

/** Commands available through Pi's `/mcp` surface, in help order. */
export const MCP_COMMAND_NAMES = [
  "list",
  "add",
  "remove",
  "enable",
  "disable",
  "auth",
  "logout",
  "test",
  "status",
  "reconnect",
  "prompt",
  "subscribe",
  "unsubscribe",
  "logs",
  "help",
] as const;

/** Persistent and offline commands available through the standalone executable. */
export const MCP_STANDALONE_COMMAND_NAMES = MCP_COMMAND_NAMES.slice(0, 8);

/** Command entrypoint that owns parsing and adapter execution. */
export type McpCommandSurface = "runtime" | "standalone";

/** Stable categories used for command results and process exit codes. */
export type McpCommandExitCategory =
  | "success"
  | "usage"
  | "settings"
  | "authentication"
  | "connection"
  | "runtime";
/** Settings layer targeted by a mutating command. */
export type McpCommandSettingsScope = "global" | "project";

/** Enabled Server Definition accepted by the `add` command. */
export type McpAddServerDefinition =
  | {
      readonly args: readonly string[];
      readonly command: string;
      readonly cwd?: string;
      readonly enabled: true;
      readonly environment: Readonly<Record<string, string>>;
      readonly transport: "stdio";
    }
  | {
      readonly auth?:
        | { readonly type: "none" }
        | { readonly token: string; readonly type: "bearer" }
        | {
            readonly clientId?: string;
            readonly clientSecret?: string;
            readonly redirectUri?: string;
            readonly scopes: readonly string[];
            readonly type: "oauth";
          };
      readonly enabled: true;
      readonly headers: Readonly<Record<string, string>>;
      readonly transport: "http" | "sse";
      readonly url: string;
    };

/** Parsed command and its normalized options. */
export type McpCommand =
  | { readonly json: boolean; readonly kind: "list" }
  | {
      readonly definition: McpAddServerDefinition;
      readonly kind: "add";
      readonly name: string;
      readonly scope: McpCommandSettingsScope;
    }
  | {
      readonly kind: "remove";
      readonly logout: boolean;
      readonly name: string;
      readonly scope: McpCommandSettingsScope;
    }
  | { readonly kind: "enable"; readonly name: string; readonly scope: McpCommandSettingsScope }
  | { readonly kind: "disable"; readonly name: string; readonly scope: McpCommandSettingsScope }
  | {
      readonly callback?: string;
      readonly code?: string;
      readonly kind: "auth";
      readonly noOpen: boolean;
      readonly server: string;
      readonly state?: string;
    }
  | {
      readonly all: boolean;
      readonly force: boolean;
      readonly kind: "logout";
      readonly server?: string;
    }
  | {
      readonly all: boolean;
      readonly json: boolean;
      readonly kind: "test";
      readonly server?: string;
    }
  | { readonly includeHelp: boolean; readonly kind: "status" }
  | { readonly kind: "reconnect"; readonly server: string }
  | {
      readonly arguments: Readonly<Record<string, string>>;
      readonly kind: "prompt";
      readonly prompt: string;
      readonly server: string;
    }
  | { readonly kind: "subscribe"; readonly server: string; readonly uri: string }
  | { readonly kind: "unsubscribe"; readonly server: string; readonly uri: string }
  | { readonly kind: "logs"; readonly server?: string }
  | { readonly kind: "help" };

/** Usage failure returned when command tokens cannot be parsed. */
export interface McpCommandParseFailure {
  readonly category: "usage";
  readonly message: string;
  readonly ok: false;
  readonly usage: string;
}

/** Successful parsed command or a usage failure. */
export type McpCommandParseResult =
  | { readonly command: McpCommand; readonly ok: true }
  | McpCommandParseFailure;

/** Successful adapter outcome and optional JSON payload. */
export interface McpCommandAdapterSuccess {
  readonly data?: McpCommandJsonValue;
  readonly message: string;
  readonly ok: true;
}

/** Adapter outcome for settings, authentication, connection, or runtime failure. */
export interface McpCommandAdapterFailure {
  readonly category: Exclude<McpCommandExitCategory, "success" | "usage">;
  readonly message: string;
  readonly ok: false;
}

/** Result returned by a command adapter. */
export type McpCommandAdapterResult = McpCommandAdapterSuccess | McpCommandAdapterFailure;

/** Options for one command variant, excluding its discriminant. */
export type McpCommandOptions<Kind extends McpCommand["kind"]> = Omit<
  Extract<McpCommand, { kind: Kind }>,
  "kind"
>;

/** Adapter implementations shared by runtime and standalone command surfaces. */
export interface McpCommandAdapters {
  auth: {
    authenticate(options: McpCommandOptions<"auth">): Promise<McpCommandAdapterResult>;
    logout(options: McpCommandOptions<"logout">): Promise<McpCommandAdapterResult>;
  };
  live?: McpLiveCommandAdapter | undefined;
  settings: {
    add(options: McpCommandOptions<"add">): Promise<McpCommandAdapterResult>;
    disable(options: McpCommandOptions<"disable">): Promise<McpCommandAdapterResult>;
    enable(options: McpCommandOptions<"enable">): Promise<McpCommandAdapterResult>;
    list(): Promise<McpCommandAdapterResult>;
    remove(options: McpCommandOptions<"remove">): Promise<McpCommandAdapterResult>;
  };
  test: {
    test(options: McpCommandOptions<"test">): Promise<McpCommandAdapterResult>;
  };
}

/** Runtime-only adapter for live MCP Host operations. */
export interface McpLiveCommandAdapter {
  connectInBackground(server: string): void;
  disconnect(server: string): Promise<void>;
  logs(options: McpCommandOptions<"logs">): Promise<McpCommandAdapterResult>;
  prompt(options: McpCommandOptions<"prompt">): Promise<McpCommandAdapterResult>;
  reconnect(server: string): Promise<McpCommandAdapterResult>;
  status(): Promise<McpCommandAdapterResult>;
  subscribe(options: McpCommandOptions<"subscribe">): Promise<McpCommandAdapterResult>;
  unsubscribe(options: McpCommandOptions<"unsubscribe">): Promise<McpCommandAdapterResult>;
}

/** Rendered command outcome with its process exit code. */
export interface McpCommandExecutionResult {
  readonly category: McpCommandExitCategory;
  readonly data?: McpCommandJsonValue;
  readonly exitCode: number;
  readonly ok: boolean;
  readonly output: string;
}

const EXIT_CODES = {
  authentication: 4,
  connection: 5,
  runtime: 6,
  settings: 3,
  success: 0,
  usage: 2,
} as const satisfies Record<McpCommandExitCategory, number>;

const GENERAL_USAGE = `Usage: pi-mcp <command> [options]
Commands: ${MCP_STANDALONE_COMMAND_NAMES.join(", ")}`;
const RUNTIME_HELP = `Commands: ${MCP_COMMAND_NAMES.join(", ")}`;

const COMMAND_USAGE = {
  add: "Usage: pi-mcp add [-l|--local] <name> <url> [options]\n       pi-mcp add [-l|--local] <name> [options] -- <command> [args...]",
  auth: "Usage: pi-mcp auth <server> [--no-open] [--callback URL | --code CODE --state STATE]",
  disable: "Usage: pi-mcp disable [-l|--local] <server>",
  enable: "Usage: pi-mcp enable [-l|--local] <server>",
  list: "Usage: pi-mcp list [--json]",
  logout: "Usage: pi-mcp logout <server> | --all --force",
  logs: "Usage: /mcp logs [server]",
  help: "Usage: /mcp help",
  prompt: "Usage: /mcp prompt <server> <prompt> [--arg NAME=VALUE]...",
  reconnect: "Usage: /mcp reconnect <server>",
  remove: "Usage: pi-mcp remove [-l|--local] [--logout] <server>",
  status: "Usage: /mcp status",
  subscribe: "Usage: /mcp subscribe <server> <uri>",
  test: "Usage: pi-mcp test <server> | --all [--json]",
  unsubscribe: "Usage: /mcp unsubscribe <server> <uri>",
} as const satisfies Record<(typeof MCP_COMMAND_NAMES)[number], string>;

function usageFailure(
  command: (typeof MCP_COMMAND_NAMES)[number] | undefined,
  message: string,
): McpCommandParseFailure {
  return {
    category: "usage",
    message,
    ok: false,
    usage: command === undefined ? GENERAL_USAGE : COMMAND_USAGE[command],
  };
}

interface ParsedOptions {
  readonly flags: ReadonlySet<string>;
  readonly positionals: readonly string[];
  readonly tail: readonly string[] | undefined;
  readonly values: ReadonlyMap<string, readonly string[]>;
}

function normalizeOptionName(rawName: string): string {
  switch (rawName) {
    case "-l":
    case "--local":
      return "local";
    case "--env":
      return "environment";
    default:
      return rawName.replace(/^--/, "");
  }
}

function parseOptions(
  tokens: readonly string[],
  flagNames: ReadonlySet<string>,
  valueNames: ReadonlySet<string>,
  allowDelimiter = false,
): ParsedOptions | string {
  const flags = new Set<string>();
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token === "--") {
      if (!allowDelimiter) return "unexpected -- delimiter";
      return { flags, positionals, tail: tokens.slice(index + 1), values };
    }
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const equalsIndex = token.indexOf("=");
    const rawName = equalsIndex < 0 ? token : token.slice(0, equalsIndex);
    const name = normalizeOptionName(rawName);
    if (flagNames.has(name)) {
      if (equalsIndex >= 0) return `option ${rawName} does not accept a value`;
      flags.add(name);
      continue;
    }
    if (!valueNames.has(name)) return `unknown option ${rawName}`;
    const value = equalsIndex < 0 ? tokens[index + 1] : token.slice(equalsIndex + 1);
    if (value === undefined || (equalsIndex < 0 && value.startsWith("--"))) {
      return `option ${rawName} requires a value`;
    }
    if (equalsIndex < 0) index += 1;
    const existing = values.get(name) ?? [];
    values.set(name, [...existing, value]);
  }
  return { flags, positionals, tail: undefined, values };
}

function oneValue(options: ParsedOptions, name: string): string | undefined {
  return options.values.get(name)?.at(-1);
}

function parseAssignments(
  values: readonly string[],
  kind: "environment" | "header" | "argument",
): Record<string, string> | string {
  const result: Record<string, string> = {};
  for (const value of values) {
    let split = value.indexOf("=");
    if (split < 0 && kind === "header") split = value.indexOf(":");
    if (split <= 0) return `${kind} must use NAME=VALUE`;
    const key = value.slice(0, split).trim();
    const rawItem = value.slice(split + 1);
    const item = kind === "header" ? rawItem.trim() : rawItem;
    if (key.length === 0) return `${kind} name must not be empty`;
    result[key] = item;
  }
  return result;
}

function parseScope(options: ParsedOptions): McpCommandSettingsScope {
  return options.flags.has("local") ? "project" : "global";
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseRemoteAuth(
  options: ParsedOptions,
): McpAddServerDefinition extends infer _Definition
  ?
      | Exclude<Extract<McpAddServerDefinition, { url: string }>["auth"], undefined>
      | undefined
      | string
  : never {
  const configuredType = oneValue(options, "auth");
  const token = oneValue(options, "token");
  const clientId = oneValue(options, "client-id");
  const clientSecret = oneValue(options, "client-secret");
  const redirectUri = oneValue(options, "redirect-uri");
  const scopes = options.values.get("scope") ?? [];
  const inferredType =
    token !== undefined
      ? "bearer"
      : clientId !== undefined ||
          clientSecret !== undefined ||
          redirectUri !== undefined ||
          scopes.length > 0
        ? "oauth"
        : undefined;
  const type = configuredType ?? inferredType;
  if (type === undefined) return undefined;
  if (type === "none") {
    if (
      token !== undefined ||
      clientId !== undefined ||
      clientSecret !== undefined ||
      redirectUri !== undefined ||
      scopes.length > 0
    ) {
      return "auth type none cannot include credential options";
    }
    return { type: "none" };
  }
  if (type === "bearer") {
    if (token === undefined || token.length === 0) return "bearer auth requires --token";
    if (
      clientId !== undefined ||
      clientSecret !== undefined ||
      redirectUri !== undefined ||
      scopes.length > 0
    ) {
      return "bearer auth cannot include OAuth options";
    }
    return { token, type: "bearer" };
  }
  if (type !== "oauth") return "--auth must be none, bearer, or oauth";
  if (token !== undefined) return "OAuth auth cannot include --token";
  return {
    ...(clientId === undefined ? {} : { clientId }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(redirectUri === undefined ? {} : { redirectUri }),
    scopes: [...scopes],
    type: "oauth",
  };
}

function parseAdd(args: readonly string[]): McpCommandParseResult {
  const options = parseOptions(
    args,
    new Set(["local"]),
    new Set([
      "auth",
      "client-id",
      "client-secret",
      "cwd",
      "environment",
      "header",
      "redirect-uri",
      "scope",
      "token",
      "transport",
    ]),
    true,
  );
  if (typeof options === "string") return usageFailure("add", options);
  const name = options.positionals[0];
  if (name === undefined || name.length === 0)
    return usageFailure("add", "server name is required");
  if (options.tail !== undefined) {
    if (options.positionals.length !== 1)
      return usageFailure("add", "a local add cannot also include a URL");
    const command = options.tail[0];
    if (command === undefined || command.length === 0)
      return usageFailure("add", "local command is required after --");
    for (const remoteOption of [
      "auth",
      "client-id",
      "client-secret",
      "header",
      "redirect-uri",
      "scope",
      "token",
    ]) {
      if (options.values.has(remoteOption))
        return usageFailure("add", `local add cannot include --${remoteOption}`);
    }
    const transport = oneValue(options, "transport");
    if (transport !== undefined && transport !== "stdio") {
      return usageFailure("add", "local transport must be stdio");
    }
    const environment = parseAssignments(options.values.get("environment") ?? [], "environment");
    if (typeof environment === "string") return usageFailure("add", environment);
    const cwd = oneValue(options, "cwd");
    return {
      command: {
        definition: {
          args: options.tail.slice(1),
          command,
          ...(cwd === undefined ? {} : { cwd }),
          enabled: true,
          environment,
          transport: "stdio",
        },
        kind: "add",
        name,
        scope: parseScope(options),
      },
      ok: true,
    };
  }
  if (options.positionals.length !== 2)
    return usageFailure("add", "remote add requires a name and URL");
  if (options.values.has("cwd") || options.values.has("environment")) {
    return usageFailure("add", "remote add cannot include local process options");
  }
  const url = options.positionals[1] ?? "";
  if (!isHttpUrl(url)) return usageFailure("add", "remote URL must be absolute HTTP or HTTPS");
  const transport = oneValue(options, "transport") ?? "http";
  if (transport !== "http" && transport !== "sse")
    return usageFailure("add", "remote transport must be http or sse");
  const headers = parseAssignments(options.values.get("header") ?? [], "header");
  if (typeof headers === "string") return usageFailure("add", headers);
  const auth = parseRemoteAuth(options);
  if (typeof auth === "string") return usageFailure("add", auth);
  return {
    command: {
      definition: {
        ...(auth === undefined ? {} : { auth }),
        enabled: true,
        headers,
        transport,
        url,
      },
      kind: "add",
      name,
      scope: parseScope(options),
    },
    ok: true,
  };
}

function parseScopedServer(
  kind: "remove" | "enable" | "disable",
  args: readonly string[],
): McpCommandParseResult {
  const options = parseOptions(
    args,
    new Set(kind === "remove" ? ["local", "logout"] : ["local"]),
    new Set(),
  );
  if (typeof options === "string") return usageFailure(kind, options);
  if (options.positionals.length !== 1)
    return usageFailure(kind, "exactly one server name is required");
  const name = options.positionals[0] ?? "";
  const scope = parseScope(options);
  if (kind === "remove") {
    return { command: { kind, logout: options.flags.has("logout"), name, scope }, ok: true };
  }
  return kind === "enable"
    ? { command: { kind, name, scope }, ok: true }
    : { command: { kind: "disable", name, scope }, ok: true };
}

/** Parse one tokenized command for the standalone executable or Pi runtime. */
export function parseMcpCommand(
  args: readonly string[],
  surface: McpCommandSurface,
): McpCommandParseResult {
  const name = args[0];
  if (name === undefined) {
    return surface === "runtime"
      ? { command: { includeHelp: true, kind: "status" }, ok: true }
      : usageFailure(undefined, "command is required");
  }
  if (!MCP_COMMAND_NAMES.some((candidate) => candidate === name))
    return usageFailure(undefined, `unknown command ${name}`);
  // SAFETY: The membership check immediately above proves `name` is an approved command name.
  const commandName = name as (typeof MCP_COMMAND_NAMES)[number];
  if (
    surface === "standalone" &&
    !MCP_STANDALONE_COMMAND_NAMES.some((candidate) => candidate === commandName)
  ) {
    return usageFailure(undefined, `${commandName} is available only through /mcp`);
  }
  const rest = args.slice(1);
  if (commandName === "add") return parseAdd(rest);
  if (commandName === "remove" || commandName === "enable" || commandName === "disable")
    return parseScopedServer(commandName, rest);
  if (commandName === "list") {
    const options = parseOptions(rest, new Set(["json"]), new Set());
    if (typeof options === "string" || options.positionals.length > 0)
      return usageFailure(
        "list",
        typeof options === "string" ? options : "list accepts no arguments",
      );
    if (surface === "runtime" && options.flags.has("json"))
      return usageFailure("list", "--json is standalone-only");
    return { command: { json: options.flags.has("json"), kind: "list" }, ok: true };
  }
  if (commandName === "auth") {
    const options = parseOptions(
      rest,
      new Set(["no-open"]),
      new Set(["callback", "code", "state"]),
    );
    if (typeof options === "string") return usageFailure("auth", options);
    if (options.positionals.length !== 1)
      return usageFailure(
        "auth",
        "exactly one server name is required; bare authorization codes are not accepted",
      );
    const callback = oneValue(options, "callback");
    const code = oneValue(options, "code");
    const state = oneValue(options, "state");
    if ((code === undefined) !== (state === undefined))
      return usageFailure("auth", "--code and --state must be supplied together");
    if (callback !== undefined && code !== undefined)
      return usageFailure("auth", "use either --callback or --code with --state");
    return {
      command: {
        ...(callback === undefined ? {} : { callback }),
        ...(code === undefined ? {} : { code }),
        kind: "auth",
        noOpen: options.flags.has("no-open"),
        server: options.positionals[0] ?? "",
        ...(state === undefined ? {} : { state }),
      },
      ok: true,
    };
  }
  if (commandName === "logout") {
    const options = parseOptions(rest, new Set(["all", "force"]), new Set());
    if (typeof options === "string") return usageFailure("logout", options);
    const all = options.flags.has("all");
    const force = options.flags.has("force");
    if (all || force) {
      return all && force && options.positionals.length === 0
        ? { command: { all: true, force: true, kind: "logout" }, ok: true }
        : usageFailure("logout", "auth-store reset requires exactly --all --force");
    }
    if (options.positionals.length !== 1)
      return usageFailure("logout", "exactly one server name is required");
    return {
      command: { all: false, force: false, kind: "logout", server: options.positionals[0] ?? "" },
      ok: true,
    };
  }
  if (commandName === "test") {
    const options = parseOptions(rest, new Set(["all", "json"]), new Set());
    if (typeof options === "string") return usageFailure("test", options);
    if (surface === "runtime" && options.flags.has("json"))
      return usageFailure("test", "--json is standalone-only");
    const all = options.flags.has("all");
    if ((all && options.positionals.length > 0) || (!all && options.positionals.length !== 1))
      return usageFailure("test", "select one server or explicit --all");
    return {
      command: {
        all,
        json: options.flags.has("json"),
        kind: "test",
        ...(all ? {} : { server: options.positionals[0] ?? "" }),
      },
      ok: true,
    };
  }
  if (commandName === "status") {
    if (rest.length > 0) return usageFailure("status", "status accepts no arguments");
    return { command: { includeHelp: false, kind: "status" }, ok: true };
  }
  if (commandName === "help") {
    if (rest.length > 0) return usageFailure("help", "help accepts no arguments");
    return { command: { kind: "help" }, ok: true };
  }
  if (commandName === "reconnect") {
    if (rest.length !== 1) return usageFailure("reconnect", "exactly one server name is required");
    return { command: { kind: "reconnect", server: rest[0] ?? "" }, ok: true };
  }
  if (commandName === "prompt") {
    const options = parseOptions(rest, new Set(), new Set(["arg"]));
    if (typeof options === "string") return usageFailure("prompt", options);
    if (options.positionals.length !== 2)
      return usageFailure("prompt", "server and prompt names are required");
    const arguments_ = parseAssignments(options.values.get("arg") ?? [], "argument");
    if (typeof arguments_ === "string") return usageFailure("prompt", arguments_);
    return {
      command: {
        arguments: arguments_,
        kind: "prompt",
        prompt: options.positionals[1] ?? "",
        server: options.positionals[0] ?? "",
      },
      ok: true,
    };
  }
  if (commandName === "subscribe" || commandName === "unsubscribe") {
    if (rest.length !== 2) return usageFailure(commandName, "server and resource URI are required");
    return { command: { kind: commandName, server: rest[0] ?? "", uri: rest[1] ?? "" }, ok: true };
  }
  const options = parseOptions(rest, new Set(), new Set());
  if (typeof options === "string" || options.positionals.length > 1)
    return usageFailure(
      "logs",
      typeof options === "string" ? options : "logs accepts at most one server name",
    );
  return {
    command: {
      kind: "logs",
      ...(options.positionals[0] === undefined ? {} : { server: options.positionals[0] }),
    },
    ok: true,
  };
}

function adapterFailure(
  category: Exclude<McpCommandExitCategory, "success">,
  message: string,
  usage?: string,
): McpCommandExecutionResult {
  return {
    category,
    exitCode: EXIT_CODES[category],
    ok: false,
    output:
      category === "usage"
        ? `Pi MCP: ${message}\n${usage ?? GENERAL_USAGE}\n`
        : `Pi MCP: ${message}\n`,
  };
}

function successResult(
  result: McpCommandAdapterSuccess,
  json: boolean,
  suffix = "",
): McpCommandExecutionResult {
  const output = json
    ? `${JSON.stringify(result.data ?? { message: result.message }, undefined, 2)}\n`
    : `${result.message}${suffix}\n`;
  return {
    category: "success",
    ...(result.data === undefined ? {} : { data: result.data }),
    exitCode: 0,
    ok: true,
    output,
  };
}

function liveAdapter(
  adapters: McpCommandAdapters,
): McpLiveCommandAdapter | McpCommandExecutionResult {
  return adapters.live ?? adapterFailure("runtime", "live MCP Host is unavailable");
}

/** Execute one parsed command through injected persistence, auth, test, and live-Host adapters. */
export async function executeMcpCommand(
  command: McpCommand,
  adapters: McpCommandAdapters,
  surface: McpCommandSurface = "standalone",
): Promise<McpCommandExecutionResult> {
  try {
    let result: McpCommandAdapterResult;
    switch (command.kind) {
      case "list":
        result = await adapters.settings.list();
        break;
      case "add":
        result = await adapters.settings.add({
          definition: command.definition,
          name: command.name,
          scope: command.scope,
        });
        if (result.ok && surface === "runtime") adapters.live?.connectInBackground(command.name);
        break;
      case "remove":
        result = await adapters.settings.remove({
          logout: command.logout,
          name: command.name,
          scope: command.scope,
        });
        if (result.ok && surface === "runtime") await adapters.live?.disconnect(command.name);
        break;
      case "enable":
        result = await adapters.settings.enable({ name: command.name, scope: command.scope });
        if (result.ok && surface === "runtime") adapters.live?.connectInBackground(command.name);
        break;
      case "disable":
        result = await adapters.settings.disable({ name: command.name, scope: command.scope });
        if (result.ok && surface === "runtime") await adapters.live?.disconnect(command.name);
        break;
      case "auth":
        result = await adapters.auth.authenticate({
          ...(command.callback === undefined ? {} : { callback: command.callback }),
          ...(command.code === undefined ? {} : { code: command.code }),
          noOpen: command.noOpen,
          server: command.server,
          ...(command.state === undefined ? {} : { state: command.state }),
        });
        break;
      case "logout":
        result = await adapters.auth.logout({
          all: command.all,
          force: command.force,
          ...(command.server === undefined ? {} : { server: command.server }),
        });
        break;
      case "test":
        result = await adapters.test.test({
          all: command.all,
          json: command.json,
          ...(command.server === undefined ? {} : { server: command.server }),
        });
        break;
      case "status": {
        const live = liveAdapter(adapters);
        if ("exitCode" in live) return live;
        result = await live.status();
        break;
      }
      case "reconnect": {
        const live = liveAdapter(adapters);
        if ("exitCode" in live) return live;
        result = await live.reconnect(command.server);
        break;
      }
      case "prompt": {
        const live = liveAdapter(adapters);
        if ("exitCode" in live) return live;
        result = await live.prompt({
          arguments: command.arguments,
          prompt: command.prompt,
          server: command.server,
        });
        break;
      }
      case "subscribe": {
        const live = liveAdapter(adapters);
        if ("exitCode" in live) return live;
        result = await live.subscribe({ server: command.server, uri: command.uri });
        break;
      }
      case "unsubscribe": {
        const live = liveAdapter(adapters);
        if ("exitCode" in live) return live;
        result = await live.unsubscribe({ server: command.server, uri: command.uri });
        break;
      }
      case "logs": {
        const live = liveAdapter(adapters);
        if ("exitCode" in live) return live;
        result = await live.logs(command.server === undefined ? {} : { server: command.server });
        break;
      }
      case "help":
        return successResult({ message: RUNTIME_HELP, ok: true }, false);
    }
    if (!result.ok) return adapterFailure(result.category, result.message);
    const json = (command.kind === "list" || command.kind === "test") && command.json;
    const suffix = command.kind === "status" && command.includeHelp ? `\n\n${RUNTIME_HELP}` : "";
    return successResult(result, json, suffix);
  } catch {
    return adapterFailure("runtime", "command failed unexpectedly");
  }
}

/** Split a `/mcp` argument string without invoking a shell or expanding variables. */
export function tokenizeMcpCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let tokenStarted = false;
  for (const character of line) {
    if (escaping) {
      current += character;
      tokenStarted = true;
      escaping = false;
    } else if (character === "\\" && quote !== "'") {
      escaping = true;
      tokenStarted = true;
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      tokenStarted = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (/\s/u.test(character)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
    } else {
      current += character;
      tokenStarted = true;
    }
  }
  if (quote !== undefined) throw new Error("MCP command has an unterminated quote");
  if (escaping) current += "\\";
  if (tokenStarted) tokens.push(current);
  return tokens;
}

/** Parse and execute one pre-tokenized MCP command without reinterpreting argument contents. */
export async function runMcpCommandTokens(
  tokens: readonly string[],
  surface: McpCommandSurface,
  adapters: McpCommandAdapters,
): Promise<McpCommandExecutionResult> {
  const parsed = parseMcpCommand(tokens, surface);
  if (!parsed.ok) return adapterFailure("usage", parsed.message, parsed.usage);
  return executeMcpCommand(parsed.command, adapters, surface);
}

/** Tokenize, parse, and execute one shared command line without throwing through its caller. */
export async function runMcpCommandLine(
  line: string,
  surface: McpCommandSurface,
  adapters: McpCommandAdapters,
): Promise<McpCommandExecutionResult> {
  try {
    return runMcpCommandTokens(tokenizeMcpCommandLine(line), surface, adapters);
  } catch {
    return adapterFailure("usage", "invalid quoting", GENERAL_USAGE);
  }
}
