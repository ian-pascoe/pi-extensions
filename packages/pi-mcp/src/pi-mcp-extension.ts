// oxlint-disable anti-slop/no-conditional-empty-object-spread -- Exact optional protocol and Pi fields must be omitted when absent at this composition boundary.
// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- This Pi composition root parses persisted custom-entry and custom-message replay data before restoring it.
import { pathToFileURL } from "node:url";
import {
  fromJsonSchema,
  ProtocolError,
  RegistrationRejectedError,
  SdkError,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type {
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageResultWithTools,
  ElicitRequest,
  ElicitResult,
  JSONValue,
  JsonSchemaType,
  TextContent,
  ToolUseContent,
} from "@modelcontextprotocol/client";
import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  getAgentDir,
  SettingsManager,
  truncateTail,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { McpAuthStore } from "./mcp-auth-store.js";
import {
  completeMcpCommandArguments,
  type McpCommandCompletionItem,
} from "./mcp-command-completion.js";
import {
  runMcpCommandLine,
  type McpCommandAdapterResult,
  type McpCommandExitCategory,
} from "./mcp-command.js";
import { createMcpContentResult, type McpContentBlock } from "./mcp-content.js";
import {
  McpHost,
  type McpHostGetPromptResult,
  type McpHostLogTail,
  McpHostOperationError,
  type McpHostRequestContext,
  type McpHostResourceSubscription,
  type McpHostServerTool,
  type McpServerStatus,
} from "./mcp-host.js";
import { McpOAuthProvider } from "./mcp-oauth.js";
import { McpObserverUiController } from "./mcp-observer-ui.js";
import {
  parseMcpPromptReplayMessages,
  renderMcpPromptMessage,
  renderMcpResourceUpdateMessage,
  sanitizeMcpPresentationText,
  type McpPromptMessageDetails,
  type McpPromptReplayMessage,
} from "./mcp-presentation.js";
import { createMcpSessionFiles, type McpSessionFiles } from "./mcp-session-files.js";
import {
  McpToolCatalog,
  type McpListResourcesParameters,
  type McpServerToolDefinition,
  type McpToolCatalogRuntime,
  type McpToolExecution,
  type McpToolOperationResult,
} from "./mcp-tool-catalog.js";
import { createStandaloneMcpCommandAdapters } from "./pi-mcp-cli.js";
import { resolveMcpSettings } from "./pi-mcp-settings.js";

/** Notification returned by the shared MCP command surface to the Pi adapter. */
export interface PiMcpExtensionCommandResult {
  readonly level: "error" | "info" | "warning";
  readonly message: string;
}

/** Slash-command completion item returned without importing Pi TUI internals. */
export type PiMcpAutocompleteItem = McpCommandCompletionItem;

/** Session-owned MCP Host behavior consumed by the Pi lifecycle adapter. */
export interface PiMcpExtensionSession {
  /** Close all processes, transports, subscriptions, listeners, timers, and session files once. */
  close(): Promise<void>;
  /** Complete `/mcp` commands and arguments through the live Host. */
  completeCommandArguments?(prefix: string): Promise<PiMcpAutocompleteItem[] | null>;
  /** Execute one `/mcp` command without throwing an expected failure through Pi. */
  executeCommand(
    arguments_: string,
    context: ExtensionCommandContext,
  ): Promise<PiMcpExtensionCommandResult>;
  /** Return the bounded, immutable Server Instructions snapshot for this Pi session. */
  instructionSnapshot(): Promise<string | undefined>;
  /** Redact exact configured values from human-only MCP presentation copy. */
  redactPresentationText(text: string): string;
  /** Start enabled MCP Servers without making `session_start` await their connections. */
  start(): Promise<void>;
  /** Expand persisted MCP Prompt custom messages at their active-branch positions. */
  transformContext(messages: ContextEvent["messages"]): ContextEvent["messages"];
}

/** Construction boundary for trust-aware, session-owned MCP Host state. */
export interface PiMcpExtensionEffects {
  /** Create one inert session generation from Pi's already resolved trust context. */
  createSession(context: ExtensionContext, pi: ExtensionAPI): Promise<PiMcpExtensionSession>;
}

interface ActivePiMcpSession {
  readonly runtime: PiMcpExtensionSession;
  instructionSnapshot?: Promise<string | undefined>;
}

const MCP_PROMPT_MESSAGE_TYPE = "pi-mcp-prompt";
const MCP_RESOURCE_UPDATE_MESSAGE_TYPE = "pi-mcp-resource-update";
const MCP_SUBSCRIPTIONS_ENTRY_TYPE = "pi-mcp-subscriptions";

function toMcpJsonValue(value: unknown): JSONValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(toMcpJsonValue);
  if (typeof value !== "object") return "unsupported value";
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, toMcpJsonValue(item)]),
  );
}

function formatMcpServerStatus(status: McpServerStatus): string {
  const safeError = "error" in status ? sanitizeMcpPresentationText(status.error) : undefined;
  switch (status.state) {
    case "disabled":
    case "connected":
      return status.state;
    case "connecting":
      return `connecting (attempt ${status.attempt})`;
    case "needs_auth":
      return `needs_auth (${safeError})`;
    case "needs_client_registration":
      return `needs_client_registration (${safeError})`;
    case "retrying":
      return `retrying (attempt ${status.attempt}, retryAt ${status.retryAt}, delay ${status.delayMs} ms, ${safeError})`;
    case "failed":
      return `failed (${status.attempts} attempts, ${safeError})`;
  }
}

function formatMcpStatus(
  statuses: ReadonlyMap<string, McpServerStatus>,
  subscriptions: readonly McpHostResourceSubscription[],
  invalidSettings: readonly string[],
): string {
  const sections: string[] = [];
  if (invalidSettings.length > 0) {
    sections.push(
      `Invalid MCP settings:\n- ${invalidSettings.map(sanitizeMcpPresentationText).join("\n- ")}`,
    );
  } else if (statuses.size === 0) {
    sections.push("No MCP Server Definitions configured");
  } else {
    sections.push(
      [...statuses]
        .map(
          ([serverId, status]) =>
            `${sanitizeMcpPresentationText(serverId)}: ${formatMcpServerStatus(status)}`,
        )
        .join("\n"),
    );
  }
  if (subscriptions.length > 0) {
    sections.push(
      `Active Resource subscriptions:\n${subscriptions
        .map(
          ({ serverId, uri }) =>
            `- ${sanitizeMcpPresentationText(serverId)}: ${sanitizeMcpPresentationText(uri)}`,
        )
        .join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

function formatMcpLogs(tails: readonly McpHostLogTail[]): string {
  if (tails.length === 0) return "No MCP logs retained";
  const complete = sanitizeMcpPresentationText(
    tails.map(({ serverId, text }) => `## ${serverId}\n${text || "(empty)"}`).join("\n\n"),
  );
  const limits = { maxBytes: DEFAULT_MAX_BYTES - 1, maxLines: DEFAULT_MAX_LINES - 1 };
  const visible = truncateTail(complete, limits);
  if (!visible.truncated) return visible.content;
  const retainedPaths = sanitizeMcpPresentationText(
    tails.map(({ path, serverId }) => `${serverId}: ${path}`).join(", "),
  );
  return truncateTail(
    `${visible.content}\n\n[Combined logs truncated; complete retained tails: ${retainedPaths}]`,
    limits,
  ).content;
}

async function runExpectedMcpLiveCommand(
  operation: () => Promise<McpCommandAdapterResult>,
  category: Exclude<McpCommandExitCategory, "success" | "usage">,
  redact: (value: string) => string,
): Promise<McpCommandAdapterResult> {
  try {
    return await operation();
  } catch (cause) {
    if (
      !(
        cause instanceof ProtocolError ||
        cause instanceof RegistrationRejectedError ||
        cause instanceof SdkError ||
        cause instanceof UnauthorizedError ||
        cause instanceof McpHostOperationError
      )
    ) {
      throw cause;
    }
    return {
      category,
      message: sanitizeMcpPresentationText(redact(cause.message)),
      ok: false,
    };
  }
}

function parseSubscriptionEntry(data: unknown): readonly McpHostResourceSubscription[] | undefined {
  if (data === null || typeof data !== "object" || !("version" in data) || data.version !== 1) {
    return undefined;
  }
  if (!("subscriptions" in data) || !Array.isArray(data.subscriptions)) return undefined;
  const subscriptions: McpHostResourceSubscription[] = [];
  for (const item of data.subscriptions) {
    if (
      item === null ||
      typeof item !== "object" ||
      !("serverId" in item) ||
      typeof item.serverId !== "string" ||
      !("uri" in item) ||
      typeof item.uri !== "string"
    ) {
      return undefined;
    }
    subscriptions.push({ serverId: item.serverId, uri: item.uri });
  }
  return subscriptions;
}

function replaySubscriptions(context: ExtensionContext): readonly McpHostResourceSubscription[] {
  let subscriptions: readonly McpHostResourceSubscription[] = [];
  for (const entry of context.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== MCP_SUBSCRIPTIONS_ENTRY_TYPE) continue;
    const parsed = parseSubscriptionEntry(entry.data);
    if (parsed !== undefined) subscriptions = parsed;
  }
  return subscriptions;
}

function agentPromptReplayMessage(
  message: McpPromptReplayMessage,
): ContextEvent["messages"][number] {
  if (message.role === "user") {
    return { content: [...message.content], role: "user", timestamp: message.timestamp };
  }
  const assistantContent = message.content.map((block) =>
    block.type === "text"
      ? block
      : {
          text: `[MCP Prompt image (${block.mimeType})]\ndata:${block.mimeType};base64,${block.data}`,
          type: "text" as const,
        },
  );
  return {
    api: "mcp-prompt",
    content: assistantContent,
    model: "mcp-prompt",
    provider: "pi-mcp",
    role: "assistant",
    stopReason: "stop",
    timestamp: message.timestamp,
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 0,
      output: 0,
      totalTokens: 0,
    },
  };
}

function transformPromptMessages(messages: ContextEvent["messages"]): ContextEvent["messages"] {
  return messages.flatMap((message) => {
    if (message.role !== "custom" || message.customType !== MCP_PROMPT_MESSAGE_TYPE) {
      return [message];
    }
    return (parseMcpPromptReplayMessages(message.details) ?? []).map(agentPromptReplayMessage);
  });
}

function isMcpContentBlock(value: unknown): value is McpContentBlock {
  if (value === null || typeof value !== "object" || !("type" in value)) return false;
  if (value.type === "text") return "text" in value && typeof value.text === "string";
  if (value.type === "image" || value.type === "audio") {
    return (
      "data" in value &&
      typeof value.data === "string" &&
      "mimeType" in value &&
      typeof value.mimeType === "string"
    );
  }
  if (value.type === "resource_link") {
    return (
      "name" in value &&
      typeof value.name === "string" &&
      "uri" in value &&
      typeof value.uri === "string"
    );
  }
  return (
    value.type === "resource" &&
    "resource" in value &&
    value.resource !== null &&
    typeof value.resource === "object"
  );
}

async function mapPromptResult(
  result: McpHostGetPromptResult,
  sessionFiles: McpSessionFiles,
): Promise<readonly McpPromptReplayMessage[]> {
  const timestamp = Date.now();
  const replay: McpPromptReplayMessage[] = [];
  for (const value of result.messages) {
    if (
      value === null ||
      typeof value !== "object" ||
      !("role" in value) ||
      (value.role !== "user" && value.role !== "assistant") ||
      !("content" in value)
    ) {
      throw new Error("Pi MCP Prompt result contains an invalid message");
    }
    const values = Array.isArray(value.content) ? value.content : [value.content];
    if (!values.every(isMcpContentBlock)) {
      throw new Error("Pi MCP Prompt result contains invalid content");
    }
    const mapped = await createMcpContentResult(values, undefined, sessionFiles);
    replay.push({ content: mapped.content, role: value.role, timestamp });
  }
  return replay;
}

function selectedResourceServer(parameters: McpListResourcesParameters): string | undefined {
  return typeof parameters.server === "string" ? parameters.server : undefined;
}

function toolProgressUpdate(execution: McpToolExecution, progress: unknown): void {
  execution.onUpdate?.({
    content: [{ text: `MCP progress: ${JSON.stringify(progress)}`, type: "text" }],
    details: { progress: toMcpJsonValue(progress) },
  });
}

function samplingUserContent(value: unknown): UserMessage["content"] {
  const blocks = Array.isArray(value) ? value : [value];
  return blocks.map((block) => {
    if (block !== null && typeof block === "object" && "type" in block) {
      if (block.type === "text" && "text" in block && typeof block.text === "string") {
        return { text: block.text, type: "text" as const };
      }
      if (
        block.type === "image" &&
        "data" in block &&
        typeof block.data === "string" &&
        "mimeType" in block &&
        typeof block.mimeType === "string"
      ) {
        return { data: block.data, mimeType: block.mimeType, type: "image" as const };
      }
    }
    return { text: `[MCP sampling content]\n${JSON.stringify(block)}`, type: "text" as const };
  });
}

function samplingAssistantContent(value: unknown): AssistantMessage["content"] {
  const blocks = Array.isArray(value) ? value : [value];
  return blocks.map((block) => {
    if (block !== null && typeof block === "object" && "type" in block) {
      if (block.type === "text" && "text" in block && typeof block.text === "string") {
        return { text: block.text, type: "text" as const };
      }
      if (
        block.type === "tool_use" &&
        "id" in block &&
        typeof block.id === "string" &&
        "name" in block &&
        typeof block.name === "string" &&
        "input" in block &&
        block.input !== null &&
        typeof block.input === "object" &&
        !Array.isArray(block.input)
      ) {
        return {
          arguments: block.input,
          id: block.id,
          name: block.name,
          type: "toolCall" as const,
        };
      }
    }
    return { text: `[MCP sampling content]\n${JSON.stringify(block)}`, type: "text" as const };
  });
}

function samplingMessages(request: CreateMessageRequest): Message[] {
  const timestamp = Date.now();
  return request.params.messages.map((message): Message => {
    if (message.role === "user") {
      return { content: samplingUserContent(message.content), role: "user", timestamp };
    }
    return {
      api: "mcp-sampling",
      content: samplingAssistantContent(message.content),
      model: "mcp-sampling",
      provider: "pi-mcp",
      role: "assistant",
      stopReason: "stop",
      timestamp,
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 0,
        output: 0,
        totalTokens: 0,
      },
    };
  });
}

async function completeMcpSampling(
  request: CreateMessageRequest,
  execution: McpToolExecution,
): Promise<CreateMessageResult | CreateMessageResultWithTools> {
  const model = execution.context.model;
  if (model === undefined) throw new Error("Pi MCP sampling requires an active Pi model");
  const tools = request.params.tools?.map((tool) => {
    // SAFETY: The official MCP Client parsed each sampling tool inputSchema as JSON Schema. Pi accepts the same exact structural schema.
    const parameters = tool.inputSchema as TSchema;
    return { description: tool.description ?? tool.name, name: tool.name, parameters };
  });
  const response = await execution.context.modelRegistry.complete(
    model,
    {
      messages: samplingMessages(request),
      ...(request.params.systemPrompt === undefined
        ? {}
        : { systemPrompt: request.params.systemPrompt }),
      ...(tools === undefined ? {} : { tools }),
    },
    {
      maxTokens: request.params.maxTokens,
      ...(execution.signal === undefined ? {} : { signal: execution.signal }),
    },
  );
  const content: Array<TextContent | ToolUseContent> = response.content.flatMap<
    TextContent | ToolUseContent
  >((block) => {
    if (block.type === "text") return [{ text: block.text, type: "text" as const }];
    if (block.type === "toolCall") {
      return [
        {
          id: block.id,
          input: block.arguments,
          name: block.name,
          type: "tool_use" as const,
        },
      ];
    }
    return [{ text: block.thinking, type: "text" as const }];
  });
  const stopReason =
    response.stopReason === "length"
      ? "maxTokens"
      : response.stopReason === "toolUse"
        ? "toolUse"
        : "endTurn";
  if (request.params.tools !== undefined) {
    return { content, model: response.model, role: "assistant", stopReason };
  }
  const onlyContent = content[0];
  return {
    content:
      content.length === 1 && onlyContent !== undefined && onlyContent.type !== "tool_use"
        ? onlyContent
        : { text: JSON.stringify(content), type: "text" },
    model: response.model,
    role: "assistant",
    stopReason,
  };
}

async function fulfilMcpElicitation(
  request: ElicitRequest,
  execution: McpToolExecution,
  pi: ExtensionAPI,
): Promise<ElicitResult> {
  if (!execution.context.hasUI) return { action: "decline" };
  if (request.params.mode === "url") {
    const accepted = await execution.context.ui.confirm(
      "MCP URL elicitation",
      `${request.params.message}\n\n${request.params.url}`,
    );
    if (!accepted) return { action: "decline" };
    const [command, args] =
      process.platform === "darwin"
        ? ["open", [request.params.url]]
        : process.platform === "win32"
          ? ["rundll32", ["url.dll,FileProtocolHandler", request.params.url]]
          : ["xdg-open", [request.params.url]];
    await pi.exec(command, args, { timeout: 10_000 }).catch(() => undefined);
    return { action: "accept" };
  }
  const input = await execution.context.ui.editor(
    "MCP form elicitation",
    `${request.params.message}\n\nEnter a JSON object matching:\n${JSON.stringify(request.params.requestedSchema, undefined, 2)}\n\n{}`,
  );
  if (input === undefined) return { action: "cancel" };
  try {
    const content: unknown = JSON.parse(input.slice(input.lastIndexOf("\n\n") + 2));
    // SAFETY: The official MCP Client parsed requestedSchema as the flat elicitation JSON Schema before invoking this Host callback; the cast only reconciles exact-optional SDK declarations.
    const requestedSchema = request.params.requestedSchema as JsonSchemaType;
    const validation =
      await fromJsonSchema<Record<string, string | number | boolean | string[]>>(requestedSchema)[
        "~standard"
      ].validate(content);
    return validation.issues === undefined
      ? { action: "accept", content: validation.value }
      : { action: "decline" };
  } catch {
    return { action: "decline" };
  }
}

function createMcpRequestContext(
  execution: McpToolExecution,
  pi: ExtensionAPI,
): McpHostRequestContext<ExtensionContext> {
  return {
    callbacks: {
      onElicitation: (request) => fulfilMcpElicitation(request, execution, pi),
      onListRoots: () => ({
        roots: [
          {
            name: "Pi working directory",
            uri: pathToFileURL(execution.context.cwd).href,
          },
        ],
      }),
      onSampling: (request) => completeMcpSampling(request, execution),
    },
    onProgress: (progress) => toolProgressUpdate(execution, progress),
    piContext: execution.context,
    ...(execution.signal === undefined ? {} : { signal: execution.signal }),
  };
}

function createMcpToolCatalogRuntime(
  host: McpHost,
  sessionFiles: McpSessionFiles,
  pi: ExtensionAPI,
): McpToolCatalogRuntime {
  const mappedTextResult = async (value: unknown): Promise<McpToolOperationResult> => {
    const mapped = await createMcpContentResult(
      [{ text: JSON.stringify(value, undefined, 2), type: "text" }],
      undefined,
      sessionFiles,
    );
    return { content: [...mapped.content], details: toMcpJsonValue(mapped.details) };
  };
  const requestContext = (execution: McpToolExecution): McpHostRequestContext<ExtensionContext> =>
    createMcpRequestContext(execution, pi);
  return {
    callServerTool: async (serverId, toolName, arguments_, execution) => {
      const result = await host.callTool(serverId, toolName, arguments_, requestContext(execution));
      const structuredContent =
        result.structuredContent === undefined
          ? undefined
          : toMcpJsonValue(result.structuredContent);
      const mapped = await createMcpContentResult(result.content, structuredContent, sessionFiles);
      return {
        content: [...mapped.content],
        details: toMcpJsonValue(mapped.details),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
        ...(structuredContent === undefined ? {} : { structuredContent }),
      };
    },
    listResources: async (parameters) =>
      mappedTextResult(await host.listResources(selectedResourceServer(parameters))),
    listResourceTemplates: async (parameters) =>
      mappedTextResult(await host.listResourceTemplates(selectedResourceServer(parameters))),
    readResource: async (parameters, execution) => {
      const result = await host.readResource(
        parameters.server,
        parameters.uri,
        requestContext(execution),
      );
      const mapped = await createMcpContentResult(
        result.contents.map((resource) => ({ resource, type: "resource" })),
        undefined,
        sessionFiles,
      );
      return { content: [...mapped.content], details: toMcpJsonValue(mapped.details) };
    },
  };
}

function catalogServerTool(tool: McpHostServerTool): McpServerToolDefinition {
  // SAFETY: McpHostServerTool is derived from the official Client listTools result. The SDK parsed both schema values; these casts only reconcile exact-optional declarations between public SDK exports.
  const inputSchema = tool.inputSchema as JsonSchemaType;
  // SAFETY: The same validated SDK boundary applies to an optional output schema.
  const outputSchema = tool.outputSchema as JsonSchemaType | undefined;
  return {
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema,
    name: tool.name,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(tool.title === undefined ? {} : { title: tool.title }),
  };
}

class ProductionPiMcpSession implements PiMcpExtensionSession {
  constructor(
    private readonly host: McpHost,
    private readonly observer: McpObserverUiController,
    private readonly redact: (text: string) => string,
    private readonly adapters: Awaited<ReturnType<typeof createStandaloneMcpCommandAdapters>>,
    private readonly synchronizeInitialCatalog: () => Promise<void>,
    private readonly interactionContext: { current: ExtensionContext },
  ) {}

  close(): Promise<void> {
    this.observer.dispose();
    return this.host.shutdown();
  }

  redactPresentationText(text: string): string {
    return this.redact(text);
  }

  async completeCommandArguments(prefix: string): Promise<PiMcpAutocompleteItem[] | null> {
    return completeMcpCommandArguments(prefix, this.host);
  }

  async executeCommand(
    arguments_: string,
    context: ExtensionCommandContext,
  ): Promise<PiMcpExtensionCommandResult> {
    this.interactionContext.current = context;
    const result = await runMcpCommandLine(arguments_, "runtime", this.adapters);
    return {
      level: result.ok ? "info" : result.category === "usage" ? "warning" : "error",
      message: result.output.trimEnd(),
    };
  }

  async instructionSnapshot(): Promise<string | undefined> {
    const snapshot = await this.host.freezeInstructionSnapshot();
    return snapshot.text.length === 0 ? undefined : snapshot.text;
  }

  async start(): Promise<void> {
    this.host.start();
    await this.host.waitForInitialConnections();
    await this.synchronizeInitialCatalog();
  }

  transformContext(messages: ContextEvent["messages"]): ContextEvent["messages"] {
    return transformPromptMessages(messages);
  }
}

const productionPiMcpExtensionEffects: PiMcpExtensionEffects = {
  createSession: async (context, pi) => {
    const interactionContext = { current: context };
    const agentDirectory = getAgentDir();
    const settingsManager = SettingsManager.create(context.cwd, agentDirectory, {
      projectTrusted: context.isProjectTrusted(),
    });
    const settings = resolveMcpSettings(settingsManager);
    const invalidSettings = settings.valid
      ? []
      : settings.errors.map((error) => settings.secrets.redact(error.message));
    const adapters = await createStandaloneMcpCommandAdapters({
      agentDirectory,
      cwd: context.cwd,
      projectTrusted: context.isProjectTrusted(),
      waitForOAuthPaste: async (signal) => {
        if (!context.hasUI) throw new Error("Pi MCP OAuth callback input requires UI");
        const input = await context.ui.input(
          "MCP OAuth callback",
          "Paste the full callback URL, or code and state",
          { signal },
        );
        if (input === undefined) throw new Error("Pi MCP OAuth callback input cancelled");
        return input;
      },
      writeAuthorizationUrl: (url) => {
        if (context.hasUI) context.ui.notify(`MCP OAuth authorization URL: ${url}`, "info");
      },
    });
    const sessionFiles = await createMcpSessionFiles(context.sessionManager.getSessionDir());
    const authStore = new McpAuthStore(agentDirectory);
    const resourceServers = new Set<string>();
    let catalog: McpToolCatalog | undefined;
    let observer: McpObserverUiController | undefined;
    let ownedHost: McpHost | undefined;
    try {
      const host = new McpHost({
        initialSubscriptions: replaySubscriptions(context),
        onCatalogChanged: (serverId, kind) => {
          if (kind === "tools") void synchronizeServerCatalog(serverId);
          else if (kind === "resources" || kind === "resourceTemplates") {
            void synchronizeServerCatalog(serverId);
          }
        },
        onResourceUpdated: ({ serverId, uri }) => {
          pi.sendMessage(
            {
              content: `MCP Resource updated on ${serverId}: ${uri}. Read it explicitly before using the new content.`,
              customType: MCP_RESOURCE_UPDATE_MESSAGE_TYPE,
              display: true,
            },
            { deliverAs: "nextTurn" },
          );
        },
        onStatusChange: (statuses) => observer?.update(statuses, invalidSettings),
        persistSubscriptions: (subscriptions) => {
          pi.appendEntry(MCP_SUBSCRIPTIONS_ENTRY_TYPE, { subscriptions, version: 1 });
        },
        piCwd: context.cwd,
        resolveAuthProvider: (definition) => {
          if (definition.auth?.type === "none" || definition.auth?.type === "bearer") {
            return undefined;
          }
          const oauth = definition.auth?.type === "oauth" ? definition.auth : undefined;
          return new McpOAuthProvider({
            authStore,
            clientIdentity: oauth?.clientId ?? "@ian-pascoe/pi-mcp",
            ...(oauth?.clientId === undefined ? {} : { clientId: oauth.clientId }),
            ...(oauth?.clientSecret === undefined ? {} : { clientSecret: oauth.clientSecret }),
            onAuthorizationUrl: () => undefined,
            redirectUrl: oauth?.redirectUri ?? "http://127.0.0.1:19876/mcp/oauth/callback",
            scopes: oauth?.scopes ?? [],
            serverUrl: definition.url,
          });
        },
        sessionFiles,
        settings,
      });
      ownedHost = host;
      observer = new McpObserverUiController(context, (value) => settings.secrets.redact(value));
      observer.update(host.listStatuses(), invalidSettings);
      const synchronizeServerCatalog = async (serverId: string): Promise<void> => {
        const activeCatalog = catalog;
        if (activeCatalog === undefined) return;
        if (host.getStatus(serverId)?.state !== "connected") {
          activeCatalog.setServerActive(serverId, false);
          resourceServers.delete(serverId);
          activeCatalog.setResourceToolsActive(resourceServers.size > 0);
          return;
        }
        try {
          const tools = await host.listTools(serverId);
          activeCatalog.replaceServerTools(
            serverId,
            tools.map(({ tool }) => catalogServerTool(tool)),
          );
          if (host.hasConnectedCapability("resources", serverId)) resourceServers.add(serverId);
          else resourceServers.delete(serverId);
          activeCatalog.setResourceToolsActive(resourceServers.size > 0);
        } catch {
          activeCatalog.setServerActive(serverId, false);
          resourceServers.delete(serverId);
          activeCatalog.setResourceToolsActive(resourceServers.size > 0);
        }
      };
      catalog = new McpToolCatalog(
        pi,
        createMcpToolCatalogRuntime(host, sessionFiles, pi),
        (text) => settings.secrets.redact(text),
      );
      const resolveCurrentSettings = () =>
        resolveMcpSettings(
          SettingsManager.create(context.cwd, agentDirectory, {
            projectTrusted: context.isProjectTrusted(),
          }),
        );
      const applyPersistedServer = async (serverId: string): Promise<void> => {
        const definition = resolveCurrentSettings().servers.get(serverId);
        if (definition === undefined) {
          if (host.getStatus(serverId) !== undefined) await host.removeServer(serverId);
          catalog?.setServerActive(serverId, false);
          resourceServers.delete(serverId);
          catalog?.setResourceToolsActive(resourceServers.size > 0);
          return;
        }
        await host.upsertServer(definition);
        await synchronizeServerCatalog(serverId);
      };
      const persistentAuth = adapters.auth;
      adapters.auth = {
        ...persistentAuth,
        authenticate: async (options) => {
          const result = await persistentAuth.authenticate(options);
          if (result.ok) void host.reconnect(options.server).catch(() => undefined);
          return result;
        },
      };
      adapters.live = {
        connectInBackground: (server) => {
          void applyPersistedServer(server).catch(() => undefined);
        },
        disconnect: applyPersistedServer,
        logs: (options) =>
          runExpectedMcpLiveCommand(
            async () => {
              const tails = await host.readLogs(options.server);
              return { data: toMcpJsonValue(tails), message: formatMcpLogs(tails), ok: true };
            },
            "connection",
            (value) => settings.secrets.redact(value),
          ),
        prompt: (options) =>
          runExpectedMcpLiveCommand(
            async () => {
              const promptExecution: McpToolExecution = {
                context: interactionContext.current,
                onUpdate: undefined,
                signal: interactionContext.current.signal,
                toolCallId: "mcp-prompt",
              };
              const result = await host.getPrompt(
                options.server,
                options.prompt,
                options.arguments,
                createMcpRequestContext(promptExecution, pi),
              );
              const replayMessages = await mapPromptResult(result, sessionFiles);
              pi.sendMessage(
                {
                  content: `MCP Prompt ${options.server}/${options.prompt}`,
                  customType: MCP_PROMPT_MESSAGE_TYPE,
                  details: {
                    mcpMessages: result.messages,
                    replayMessages,
                    version: 1,
                  } satisfies McpPromptMessageDetails,
                  display: true,
                },
                { triggerTurn: true },
              );
              return {
                message: `Expanded MCP Prompt ${options.server}/${options.prompt}`,
                ok: true,
              };
            },
            "runtime",
            (value) => settings.secrets.redact(value),
          ),
        reconnect: (server) =>
          runExpectedMcpLiveCommand(
            async () => {
              await host.reconnect(server);
              return { message: `Reconnected MCP Server ${server}`, ok: true };
            },
            "connection",
            (value) => settings.secrets.redact(value),
          ),
        status: async () => {
          const statuses = host.listStatuses();
          const subscriptions = host.listSubscriptions();
          return {
            data: toMcpJsonValue({
              invalidSettings,
              servers: Object.fromEntries(statuses),
              subscriptions,
            }),
            message: formatMcpStatus(statuses, subscriptions, invalidSettings),
            ok: true,
          };
        },
        subscribe: (options) =>
          runExpectedMcpLiveCommand(
            async () => {
              await host.subscribeResource(options.server, options.uri);
              return { message: `Subscribed to ${options.server}: ${options.uri}`, ok: true };
            },
            "connection",
            (value) => settings.secrets.redact(value),
          ),
        unsubscribe: (options) =>
          runExpectedMcpLiveCommand(
            async () => {
              await host.unsubscribeResource(options.server, options.uri);
              return { message: `Unsubscribed from ${options.server}: ${options.uri}`, ok: true };
            },
            "connection",
            (value) => settings.secrets.redact(value),
          ),
      };
      return new ProductionPiMcpSession(
        host,
        observer,
        (text) => settings.secrets.redact(text),
        adapters,
        async () => {
          await Promise.all([...settings.servers.keys()].map(synchronizeServerCatalog));
        },
        interactionContext,
      );
    } catch (cause) {
      observer?.dispose();
      if (ownedHost === undefined) await sessionFiles.close();
      else await ownedHost.shutdown();
      throw cause;
    }
  },
};

/** Own `/mcp`, Pi session generations, Instruction Snapshot reuse, and complete shutdown. */
export class PiMcpLifecycleController {
  private activeSession: ActivePiMcpSession | undefined;
  private shutdownPromise: Promise<void> | undefined;

  /** Bind MCP lifecycle handlers to one Pi extension instance. */
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly effects: PiMcpExtensionEffects,
  ) {}

  /** Register inert handlers and the `/mcp` command without opening external resources. */
  register(): void {
    const redact = (text: string) =>
      this.activeSession?.runtime.redactPresentationText(text) ?? text;
    this.pi.registerMessageRenderer(MCP_PROMPT_MESSAGE_TYPE, (message, options, theme) =>
      renderMcpPromptMessage(message, options, theme, redact),
    );
    this.pi.registerMessageRenderer(MCP_RESOURCE_UPDATE_MESSAGE_TYPE, (message, options, theme) =>
      renderMcpResourceUpdateMessage(message, options, theme, redact),
    );
    this.pi.registerCommand("mcp", {
      description: "Configure and inspect MCP Servers",
      getArgumentCompletions: (prefix) =>
        this.activeSession?.runtime.completeCommandArguments?.(prefix) ?? null,
      handler: (arguments_, context) => this.executeCommand(arguments_, context),
    });
    this.pi.on("session_start", (_event, context) => this.startSession(context));
    this.pi.on("before_agent_start", (event, context) =>
      this.beforeAgentStart(event.systemPrompt, context),
    );
    this.pi.on("context", (event) => this.transformContext(event));
    this.pi.on("session_shutdown", () => this.shutdownSession());
  }

  private async startSession(context: ExtensionContext): Promise<void> {
    await this.shutdownSession();
    let runtime: PiMcpExtensionSession;
    try {
      runtime = await this.effects.createSession(context, this.pi);
    } catch (cause) {
      this.notifyFailure(context, "Pi MCP startup failed", cause);
      return;
    }
    const activeSession = { runtime };
    this.activeSession = activeSession;
    void runtime.start().catch((cause: unknown) => {
      if (this.activeSession === activeSession) {
        this.notifyFailure(context, "Pi MCP background startup failed", cause);
      }
    });
  }

  private async beforeAgentStart(
    systemPrompt: string,
    context: ExtensionContext,
  ): Promise<{ readonly systemPrompt: string } | undefined> {
    const activeSession = this.activeSession;
    if (activeSession === undefined) return undefined;
    activeSession.instructionSnapshot ??= activeSession.runtime.instructionSnapshot();
    try {
      const snapshot = await activeSession.instructionSnapshot;
      return snapshot === undefined || snapshot.length === 0
        ? undefined
        : { systemPrompt: `${systemPrompt}\n\n${snapshot}` };
    } catch (cause) {
      this.notifyFailure(context, "Pi MCP Instruction Snapshot failed", cause);
      return undefined;
    }
  }

  private transformContext(
    event: ContextEvent,
  ): { readonly messages: ContextEvent["messages"] } | undefined {
    const runtime = this.activeSession?.runtime;
    if (runtime === undefined) return undefined;
    return { messages: runtime.transformContext(event.messages) };
  }

  private async executeCommand(
    arguments_: string,
    context: ExtensionCommandContext,
  ): Promise<void> {
    const runtime = this.activeSession?.runtime;
    if (runtime === undefined) {
      if (context.hasUI) context.ui.notify("Pi MCP has no active session", "error");
      return;
    }
    try {
      const result = await runtime.executeCommand(arguments_, context);
      if (context.hasUI) context.ui.notify(result.message, result.level);
    } catch (cause) {
      this.notifyFailure(context, "Pi MCP command failed", cause);
    }
  }

  private notifyFailure(context: ExtensionContext, prefix: string, cause: unknown): void {
    if (!context.hasUI) return;
    const message = cause instanceof Error ? cause.message : String(cause);
    context.ui.notify(`${prefix}: ${message}`, "error");
  }

  private async shutdownSession(): Promise<void> {
    const activeSession = this.activeSession;
    if (activeSession === undefined) {
      await this.shutdownPromise;
      return;
    }
    this.activeSession = undefined;
    const shutdown = activeSession.runtime.close();
    this.shutdownPromise = shutdown;
    try {
      await shutdown;
    } finally {
      if (this.shutdownPromise === shutdown) this.shutdownPromise = undefined;
    }
  }
}

/** Compose the source-TypeScript Pi MCP extension without starting MCP runtime work at load time. */
export function createPiMcpExtension(
  effects: PiMcpExtensionEffects = productionPiMcpExtensionEffects,
): ExtensionFactory {
  return (pi) => new PiMcpLifecycleController(pi, effects).register();
}

const piMcpExtension = createPiMcpExtension();

export default piMcpExtension;
