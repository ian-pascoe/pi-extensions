/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- Exact optional completion descriptions are included only when their source supplies one. */
import {
  MCP_ADD_LOCAL_VALUE_OPTIONS,
  MCP_ADD_REMOTE_VALUE_OPTIONS,
  MCP_COMMAND_NAMES,
  MCP_COMMAND_OPTIONS,
  scanMcpCommandOptions,
  tokenizeMcpCommandCompletionPrefix,
  type McpCommandCompletionPrefix,
  type McpCommandName,
  type McpCommandScannedOptions,
} from "./mcp-command.js";
import type { McpHost } from "./mcp-host.js";

const MAX_MCP_COMMAND_COMPLETIONS = 100;

const COMMAND_DESCRIPTIONS = {
  add: "Add an MCP Server Definition",
  auth: "Authenticate an MCP Server",
  disable: "Disable an MCP Server",
  enable: "Enable an MCP Server",
  help: "Show MCP command help",
  list: "List configured MCP Servers",
  logout: "Remove stored authentication",
  logs: "Read retained Server logs",
  prompt: "Run an MCP Prompt",
  reconnect: "Reconnect an MCP Server",
  remove: "Remove an MCP Server Definition",
  status: "Show live MCP Server status",
  subscribe: "Subscribe to an MCP Resource",
  test: "Test an MCP Server connection",
  unsubscribe: "Unsubscribe from an MCP Resource",
} as const satisfies Record<(typeof MCP_COMMAND_NAMES)[number], string>;

const OPTION_DESCRIPTIONS = {
  "--all": "Target every configured Server",
  "--arg": "Set a Prompt argument",
  "--auth": "Select remote authentication",
  "--callback": "Complete OAuth from a callback URL",
  "--client-id": "Set an OAuth client ID",
  "--client-secret": "Set an OAuth client secret",
  "--code": "Complete OAuth with a code",
  "--cwd": "Set the stdio working directory",
  "--environment": "Set a stdio environment variable",
  "--force": "Confirm removal of all stored authentication",
  "--header": "Set an HTTP request header",
  "--local": "Write project MCP settings",
  "--logout": "Remove stored authentication too",
  "--no-open": "Do not open the authorization URL",
  "--redirect-uri": "Set the OAuth redirect URI",
  "--scope": "Add an OAuth scope",
  "--state": "Complete OAuth with matching state",
  "--token": "Set a bearer token",
  "--transport": "Select the MCP transport",
  "--": "Start the stdio command",
} as const satisfies Readonly<Record<string, string>>;

const REPEATABLE_OPTIONS = new Set(["arg", "environment", "header", "scope"]);
const REMOTE_ADD_OPTIONS = new Set<string>(MCP_ADD_REMOTE_VALUE_OPTIONS);
const LOCAL_ADD_OPTIONS = new Set<string>(MCP_ADD_LOCAL_VALUE_OPTIONS);

/** Host reads used to complete `/mcp` commands without changing MCP state. */
export type McpCommandCompletionHost = Pick<
  McpHost,
  "completePromptArgument" | "listPrompts" | "listResources" | "listStatuses" | "listSubscriptions"
>;

/** One Pi autocomplete row whose value replaces the complete `/mcp` argument prefix. */
export interface McpCommandCompletionItem {
  readonly description?: string;
  readonly label: string;
  readonly value: string;
}

interface CompletionCandidate {
  readonly description?: string;
  readonly label: string;
  readonly suffix?: "none" | "space";
  readonly token?: string;
}

function quoteMcpCommandToken(value: string, preferred: "'" | '"' | undefined): string {
  if (preferred === "'" && !value.includes("'")) return `'${value}'`;
  if (preferred === '"' || /[\s'"\\]/u.test(value)) {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return value;
}

function completionItems(
  prefix: McpCommandCompletionPrefix,
  candidates: readonly CompletionCandidate[],
  query = prefix.current.value,
): McpCommandCompletionItem[] | null {
  const normalizedQuery = query.toLocaleLowerCase();
  const items = candidates
    .filter(({ label }) => label.toLocaleLowerCase().startsWith(normalizedQuery))
    .sort(
      ({ label: left }, { label: right }) =>
        left.toLocaleLowerCase().localeCompare(right.toLocaleLowerCase()) ||
        left.localeCompare(right),
    )
    .slice(0, MAX_MCP_COMMAND_COMPLETIONS)
    .map(({ description, label, suffix = "space", token = label }) => ({
      ...(description === undefined ? {} : { description }),
      label,
      value: `${prefix.beforeCurrent}${quoteMcpCommandToken(token, prefix.current.quote)}${suffix === "space" ? " " : ""}`,
    }));
  return items.length === 0 ? null : items;
}

function optionCandidate(name: string, suffix: "none" | "space" = "space"): CompletionCandidate {
  const token = `--${name}`;
  // SAFETY: Unknown option names intentionally produce no description; known names index this closed presentation map.
  const description = OPTION_DESCRIPTIONS[token as keyof typeof OPTION_DESCRIPTIONS];
  return { ...(description === undefined ? {} : { description }), label: token, suffix };
}

function availableOptionCandidates(
  command: McpCommandName,
  parsed: McpCommandScannedOptions,
  allowed?: ReadonlySet<string>,
  flagSuffix: "none" | "space" = "space",
): CompletionCandidate[] {
  const valueNames = new Set<string>(MCP_COMMAND_OPTIONS[command].values);
  return [...MCP_COMMAND_OPTIONS[command].flags, ...MCP_COMMAND_OPTIONS[command].values]
    .filter((name) => allowed === undefined || allowed.has(name))
    .filter(
      (name) =>
        REPEATABLE_OPTIONS.has(name) || (!parsed.flags.has(name) && !parsed.values.has(name)),
    )
    .map((name) => optionCandidate(name, valueNames.has(name) ? "space" : flagSuffix));
}

function serverCandidates(
  host: McpCommandCompletionHost,
  predicate: (state: string, serverId: string) => boolean = () => true,
  suffix: "none" | "space" = "space",
): CompletionCandidate[] {
  return [...host.listStatuses()]
    .filter(([serverId, status]) => predicate(status.state, serverId))
    .map(([serverId, status]) => ({
      description: status.state.replaceAll("_", " "),
      label: serverId,
      suffix,
    }));
}

function completeServerAndOptions(
  prefix: McpCommandCompletionPrefix,
  host: McpCommandCompletionHost,
  command: "auth" | "disable" | "enable" | "remove",
  parsed: McpCommandScannedOptions,
  options?: readonly CompletionCandidate[],
): McpCommandCompletionItem[] | null {
  if (parsed.pendingValue !== undefined || parsed.positionals.length > 1) return null;
  return completionItems(prefix, [
    ...(options ??
      availableOptionCandidates(
        command,
        parsed,
        undefined,
        parsed.positionals.length === 0 ? "space" : "none",
      )),
    ...(parsed.positionals.length === 0 ? serverCandidates(host, () => true, "none") : []),
  ]);
}

function lastOptionValue(parsed: McpCommandScannedOptions, name: string): string | undefined {
  return parsed.values.get(name)?.at(-1);
}

function enumCompletion(
  prefix: McpCommandCompletionPrefix,
  option: string,
  values: readonly CompletionCandidate[],
): McpCommandCompletionItem[] | null {
  const inlinePrefix = `--${option}=`;
  if (prefix.current.value.startsWith(inlinePrefix)) {
    return completionItems(
      {
        ...prefix,
        current: { ...prefix.current, quote: undefined },
      },
      values.map((candidate) => ({ ...candidate, token: `${inlinePrefix}${candidate.label}` })),
      prefix.current.value.slice(inlinePrefix.length),
    );
  }
  return completionItems(prefix, values);
}

type AddCompletionMode = "both" | "invalid" | "local" | "remote";
type AddAuthenticationMode = "bearer" | "invalid" | "none" | "oauth" | undefined;

function addAuthenticationMode(parsed: McpCommandScannedOptions): AddAuthenticationMode {
  const configured = lastOptionValue(parsed, "auth");
  if (
    configured !== undefined &&
    configured !== "bearer" &&
    configured !== "none" &&
    configured !== "oauth"
  )
    return "invalid";
  const bearer = parsed.values.has("token");
  const oauth = ["client-id", "client-secret", "redirect-uri", "scope"].some((name) =>
    parsed.values.has(name),
  );
  if (bearer && oauth) return "invalid";
  if (
    (configured === "none" && (bearer || oauth)) ||
    (configured === "bearer" && oauth) ||
    (configured === "oauth" && bearer)
  ) {
    return "invalid";
  }
  return configured ?? (bearer ? "bearer" : oauth ? "oauth" : undefined);
}

function addCompletionMode(parsed: McpCommandScannedOptions): AddCompletionMode {
  const transport = lastOptionValue(parsed, "transport");
  if (transport !== undefined && !["http", "sse", "stdio"].includes(transport)) return "invalid";
  if (parsed.positionals.length > 2) return "invalid";
  const local =
    transport === "stdio" || [...LOCAL_ADD_OPTIONS].some((name) => parsed.values.has(name));
  const remote =
    parsed.positionals.length > 1 ||
    transport === "http" ||
    transport === "sse" ||
    [...REMOTE_ADD_OPTIONS].some((name) => parsed.values.has(name));
  return local && remote ? "invalid" : local ? "local" : remote ? "remote" : "both";
}

function addOptionCandidates(
  parsed: McpCommandScannedOptions,
  mode: Exclude<AddCompletionMode, "invalid">,
  auth: Exclude<AddAuthenticationMode, "invalid">,
): CompletionCandidate[] {
  const allowed = new Set<string>(["local", "transport"]);
  if (mode !== "remote") for (const name of LOCAL_ADD_OPTIONS) allowed.add(name);
  if (mode !== "local") for (const name of REMOTE_ADD_OPTIONS) allowed.add(name);
  if (auth === "none") {
    for (const name of ["client-id", "client-secret", "redirect-uri", "scope", "token"])
      allowed.delete(name);
  } else if (auth === "bearer") {
    for (const name of ["client-id", "client-secret", "redirect-uri", "scope"])
      allowed.delete(name);
  } else if (auth === "oauth") {
    allowed.delete("token");
  }
  const candidates = availableOptionCandidates(
    "add",
    parsed,
    allowed,
    mode === "remote" && parsed.positionals.length > 1 ? "none" : "space",
  );
  if (parsed.positionals.length === 1 && mode !== "remote") {
    candidates.push({ description: OPTION_DESCRIPTIONS["--"], label: "--" });
  }
  return candidates;
}

function completeAddCommand(
  prefix: McpCommandCompletionPrefix,
  parsed: McpCommandScannedOptions,
): McpCommandCompletionItem[] | null {
  if (parsed.tail !== undefined) return null;
  const mode = addCompletionMode(parsed);
  const auth = addAuthenticationMode(parsed);
  if (mode === "invalid" || auth === "invalid") return null;
  const pending = parsed.pendingValue;
  const inline = prefix.current.value.match(/^--(auth|transport)=(.*)$/u);
  if (pending === "auth" || inline?.[1] === "auth") {
    if (parsed.values.has("auth")) return null;
    const finalSuffix: "none" | "space" =
      mode === "remote" && parsed.positionals.length > 1 ? "none" : "space";
    const candidates = [
      {
        description: "Bearer token authentication",
        label: "bearer" as const,
        suffix: parsed.values.has("token") ? finalSuffix : ("space" as const),
      },
      { description: "No authentication", label: "none" as const, suffix: finalSuffix },
      { description: "OAuth authentication", label: "oauth" as const, suffix: finalSuffix },
    ];
    return enumCompletion(
      prefix,
      "auth",
      auth === undefined ? candidates : candidates.filter(({ label }) => label === auth),
    );
  }
  if (pending === "transport" || inline?.[1] === "transport") {
    if (parsed.values.has("transport")) return null;
    const finalSuffix: "none" | "space" = parsed.positionals.length > 1 ? "none" : "space";
    const transports =
      mode === "local"
        ? [{ description: "Local stdio transport", label: "stdio", suffix: "space" as const }]
        : mode === "remote"
          ? [
              { description: "Streamable HTTP transport", label: "http", suffix: finalSuffix },
              { description: "Server-sent events transport", label: "sse", suffix: finalSuffix },
            ]
          : [
              { description: "Streamable HTTP transport", label: "http", suffix: finalSuffix },
              { description: "Server-sent events transport", label: "sse", suffix: finalSuffix },
              {
                description: "Local stdio transport",
                label: "stdio",
                suffix: "space" as const,
              },
            ];
    return enumCompletion(prefix, "transport", transports);
  }
  if (pending !== undefined) return null;
  return completionItems(prefix, addOptionCandidates(parsed, mode, auth));
}

function completeAuthCommand(
  prefix: McpCommandCompletionPrefix,
  host: McpCommandCompletionHost,
  parsed: McpCommandScannedOptions,
): McpCommandCompletionItem[] | null {
  if (parsed.pendingValue !== undefined) return null;
  let allowed = new Set<string>(["callback", "code", "no-open", "state"]);
  if (parsed.values.has("callback")) {
    allowed.delete("callback");
    allowed.delete("code");
    allowed.delete("state");
  } else if (parsed.values.has("code") || parsed.values.has("state")) {
    allowed.delete("callback");
    if (!parsed.values.has("state")) allowed = new Set(["no-open", "state"]);
    else if (!parsed.values.has("code")) allowed = new Set(["code", "no-open"]);
  }
  return completeServerAndOptions(
    prefix,
    host,
    "auth",
    parsed,
    availableOptionCandidates(
      "auth",
      parsed,
      allowed,
      parsed.positionals.length === 0 ? "space" : "none",
    ),
  );
}

function completeLogoutCommand(
  prefix: McpCommandCompletionPrefix,
  host: McpCommandCompletionHost,
  parsed: McpCommandScannedOptions,
): McpCommandCompletionItem[] | null {
  if (parsed.pendingValue !== undefined || parsed.positionals.length > 1) return null;
  if (parsed.positionals.length === 1) return null;
  if (parsed.flags.has("all") && parsed.flags.has("force")) return null;
  if (parsed.flags.has("all") || parsed.flags.has("force")) {
    const missing = parsed.flags.has("all") ? "force" : "all";
    return completionItems(prefix, [optionCandidate(missing, "none")]);
  }
  return completionItems(prefix, [
    optionCandidate("all"),
    ...serverCandidates(host, () => true, "none"),
  ]);
}

function completeTestCommand(
  prefix: McpCommandCompletionPrefix,
  host: McpCommandCompletionHost,
  parsed: McpCommandScannedOptions,
): McpCommandCompletionItem[] | null {
  if (
    parsed.pendingValue !== undefined ||
    parsed.positionals.length > 0 ||
    parsed.flags.has("json")
  )
    return null;
  if (parsed.flags.has("all")) return null;
  return completionItems(prefix, [
    optionCandidate("all", "none"),
    ...serverCandidates(host, () => true, "none"),
  ]);
}

async function quietMcpCompletionRead<Value>(
  read: () => Promise<Value>,
): Promise<Value | undefined> {
  try {
    return await read();
  } catch {
    // Catalog and protocol completion failures are expected while live Server state changes.
    return undefined;
  }
}

async function promptDefinition(
  host: McpCommandCompletionHost,
  serverId: string,
  promptName: string,
) {
  const prompts = await quietMcpCompletionRead(() => host.listPrompts(serverId));
  if (prompts === undefined) return undefined;
  return {
    definition: prompts.find(({ prompt }) => prompt.name === promptName)?.prompt,
    prompts,
  };
}

async function completePromptArgument(
  prefix: McpCommandCompletionPrefix,
  host: McpCommandCompletionHost,
  serverId: string,
  promptName: string,
  rawArgument: string,
  syntax: "inline" | "separate",
): Promise<McpCommandCompletionItem[] | null> {
  const separator = rawArgument.indexOf("=");
  if (separator < 0) {
    const catalog = await promptDefinition(host, serverId, promptName);
    if (catalog === undefined) return null;
    return completionItems(
      prefix,
      (catalog.definition?.arguments ?? []).map(({ description, name }) => ({
        suffix: "none",
        ...(description === undefined ? {} : { description }),
        label: name,
        token: `${syntax === "inline" ? "--arg=" : ""}${name}=`,
      })),
      rawArgument,
    );
  }
  const argumentName = rawArgument.slice(0, separator);
  const valuePrefix = rawArgument.slice(separator + 1);
  const completion = await quietMcpCompletionRead(() =>
    host.completePromptArgument(serverId, promptName, argumentName, valuePrefix),
  );
  if (completion === undefined) return null;
  return completionItems(
    prefix,
    completion.values.map((value) => ({
      label: value,
      suffix: "none",
      token: `${syntax === "inline" ? "--arg=" : ""}${argumentName}=${value}`,
    })),
    valuePrefix,
  );
}

async function completePromptCommand(
  prefix: McpCommandCompletionPrefix,
  host: McpCommandCompletionHost,
  parsed: McpCommandScannedOptions,
): Promise<McpCommandCompletionItem[] | null> {
  if (parsed.positionals.length === 0) {
    if (parsed.pendingValue !== undefined) return null;
    return completionItems(
      prefix,
      serverCandidates(host, (state) => state === "connected"),
    );
  }
  const serverId = parsed.positionals[0] ?? "";
  if (parsed.positionals.length === 1 && parsed.pendingValue === undefined) {
    const prompts = await quietMcpCompletionRead(() => host.listPrompts(serverId));
    if (prompts === undefined) return null;
    return completionItems(
      prefix,
      prompts.map(({ prompt }) => ({
        ...(prompt.description === undefined ? {} : { description: prompt.description }),
        label: prompt.name,
        suffix: "none",
      })),
    );
  }
  const promptName = parsed.positionals[1];
  if (promptName === undefined || parsed.positionals.length > 2) return null;
  const inlineMarker = "--arg=";
  if (prefix.current.value.startsWith(inlineMarker)) {
    return completePromptArgument(
      prefix,
      host,
      serverId,
      promptName,
      prefix.current.value.slice(inlineMarker.length),
      "inline",
    );
  }
  if (parsed.pendingValue === "arg") {
    return completePromptArgument(
      prefix,
      host,
      serverId,
      promptName,
      prefix.current.value,
      "separate",
    );
  }
  if (parsed.pendingValue !== undefined) return null;
  const catalog = await promptDefinition(host, serverId, promptName);
  if (catalog === undefined) return null;
  return completionItems(
    prefix,
    catalog.definition?.arguments === undefined || catalog.definition.arguments.length === 0
      ? []
      : [optionCandidate("arg")],
  );
}

async function completeResourceCommand(
  prefix: McpCommandCompletionPrefix,
  host: McpCommandCompletionHost,
  command: "subscribe" | "unsubscribe",
  parsed: McpCommandScannedOptions,
): Promise<McpCommandCompletionItem[] | null> {
  if (parsed.pendingValue !== undefined || parsed.positionals.length > 2) return null;
  if (parsed.positionals.length === 0) {
    const subscriptions = host.listSubscriptions();
    return completionItems(
      prefix,
      command === "subscribe"
        ? serverCandidates(host, (state) => state === "connected")
        : serverCandidates(host, (_state, serverId) =>
            subscriptions.some((subscription) => subscription.serverId === serverId),
          ),
    );
  }
  if (parsed.positionals.length > 1) return null;
  const serverId = parsed.positionals[0] ?? "";
  if (command === "unsubscribe") {
    return completionItems(
      prefix,
      host
        .listSubscriptions()
        .filter((subscription) => subscription.serverId === serverId)
        .map(({ uri }) => ({ description: "Subscribed Resource", label: uri, suffix: "none" })),
    );
  }
  const resources = await quietMcpCompletionRead(() => host.listResources(serverId));
  if (resources === undefined) return null;
  return completionItems(
    prefix,
    resources.map(({ resource }) => ({
      ...(resource.name === undefined ? {} : { description: resource.name }),
      label: resource.uri,
      suffix: "none",
    })),
  );
}

function completeSingleServerCommand(
  prefix: McpCommandCompletionPrefix,
  host: McpCommandCompletionHost,
  parsed: McpCommandScannedOptions,
): McpCommandCompletionItem[] | null {
  if (parsed.pendingValue !== undefined || parsed.positionals.length > 0) return null;
  return completionItems(
    prefix,
    serverCandidates(host, () => true, "none"),
  );
}

/** Complete one full `/mcp` argument prefix using local Host state and selected live catalogs. */
export async function completeMcpCommandArguments(
  line: string,
  host: McpCommandCompletionHost,
): Promise<McpCommandCompletionItem[] | null> {
  const prefix = tokenizeMcpCommandCompletionPrefix(line);
  if (prefix.completed.length === 0) {
    return completionItems(
      prefix,
      MCP_COMMAND_NAMES.map((name) => ({
        suffix:
          name === "help" || name === "list" || name === "logs" || name === "status"
            ? "none"
            : "space",
        description: COMMAND_DESCRIPTIONS[name],
        label: name,
      })),
    );
  }
  const command = prefix.completed[0];
  if (!MCP_COMMAND_NAMES.some((name) => name === command)) return null;
  // SAFETY: The membership check above narrows the runtime string to an MCP command name.
  const commandName = command as (typeof MCP_COMMAND_NAMES)[number];
  if (commandName === "help" || commandName === "list" || commandName === "status") return null;
  const scanned = scanMcpCommandOptions(prefix.completed.slice(1), commandName, "completion");
  if (!scanned.ok) return null;
  const parsed = scanned.options;

  switch (commandName) {
    case "add":
      return completeAddCommand(prefix, parsed);
    case "auth":
      return completeAuthCommand(prefix, host, parsed);
    case "disable":
    case "enable":
    case "remove":
      return completeServerAndOptions(prefix, host, commandName, parsed);
    case "logout":
      return completeLogoutCommand(prefix, host, parsed);
    case "test":
      return completeTestCommand(prefix, host, parsed);
    case "prompt":
      return completePromptCommand(prefix, host, parsed);
    case "subscribe":
    case "unsubscribe":
      return completeResourceCommand(prefix, host, commandName, parsed);
    case "logs":
    case "reconnect":
      return completeSingleServerCommand(prefix, host, parsed);
  }
}
