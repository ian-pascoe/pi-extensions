/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- Exact optional MCP result marker fields are present only when supplied by the protocol operation. */
import { createHash } from "node:crypto";
import { scheduler } from "node:timers/promises";
import {
  type JSONValue,
  type JsonSchemaType,
  type ToolAnnotations,
} from "@modelcontextprotocol/client";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  McpResultMarkerSchema,
  parseMcpResultDetails,
  renderMcpResourceToolCall,
  renderMcpServerToolCall,
  renderMcpToolResult,
  type McpPresentationRedactor,
  type McpResultDetails,
  type McpResultMarker,
} from "./mcp-presentation.js";
import { createMcpSchemaValidator } from "./mcp-json-schema.js";

const RESOURCE_TOOL_NAMES = [
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
] as const;

const ListResourcesSchema = {
  type: "object",
  properties: { server: { type: "string", minLength: 1 } },
  additionalProperties: false,
} as const;
const ReadResourceSchema = {
  type: "object",
  properties: {
    server: { type: "string", minLength: 1 },
    uri: { type: "string", minLength: 1 },
  },
  required: ["server", "uri"],
  additionalProperties: false,
} as const;

type McpOutputSchemaToolDefinition<TParameters extends TSchema = TSchema> = ToolDefinition<
  TParameters,
  unknown
> & {
  readonly outputSchema: JsonSchemaType;
};

function mcpResultDetailsOutputSchema(structuredContentSchema?: JsonSchemaType): JsonSchemaType {
  return {
    type: "object",
    properties: {
      mcp: McpResultMarkerSchema,
      result: {},
      ...(structuredContentSchema === undefined
        ? {}
        : { structuredContent: structuredContentSchema }),
    },
    required: ["mcp", "result"],
    additionalProperties: false,
  };
}

function validatedMcpResultDetailsOutputSchema(
  structuredContentSchema: JsonSchemaType,
): JsonSchemaType {
  const validationMarker = (valid: boolean): JsonSchemaType => ({
    allOf: [
      McpResultMarkerSchema,
      {
        type: "object",
        properties: { outputSchemaValid: { const: valid } },
        required: ["outputSchemaValid"],
      },
    ],
  });
  return {
    anyOf: [
      {
        type: "object",
        properties: {
          mcp: validationMarker(true),
          result: {},
          structuredContent: structuredContentSchema,
        },
        required: ["mcp", "result"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          mcp: validationMarker(false),
          result: {},
          structuredContent: {},
        },
        required: ["mcp", "result"],
        additionalProperties: false,
      },
    ],
  };
}

const RESOURCE_RESULT_DETAILS_OUTPUT_SCHEMA = mcpResultDetailsOutputSchema();

/** Minimal public Pi surface required to register and activate MCP tools. */
export interface McpToolCatalogPi {
  /** Register or replace one Pi tool by name. */
  registerTool<TParameters extends TSchema, TDetails>(
    tool: ToolDefinition<TParameters, TDetails>,
  ): void;
  /** Return every registered tool name, including tools from other extensions. */
  getAllTools(): readonly { readonly name: string }[];
  /** Return the current active tool names. */
  getActiveTools(): string[];
  /** Replace the active tool names. */
  setActiveTools(toolNames: string[]): void;
  /** Observe finalized tool results so MCP errors retain their original content. */
  on(
    event: "tool_result",
    handler: (
      event: ToolResultEvent,
    ) => Promise<{ readonly isError?: boolean } | void> | { readonly isError?: boolean } | void,
  ): void;
}

/** Request-scoped Pi execution state forwarded to the MCP Host. */
export interface McpToolExecution {
  readonly context: ExtensionContext;
  readonly onUpdate: AgentToolUpdateCallback<JSONValue | undefined> | undefined;
  readonly signal: AbortSignal | undefined;
  readonly toolCallId: string;
}

/** MCP operation result already mapped to Pi-native text and image content. */
export interface McpToolOperationResult extends AgentToolResult<JSONValue | undefined> {
  readonly isError?: boolean;
  readonly structuredContent?: JSONValue;
}

/** Server Tool fields retained from the validated MCP catalog boundary. */
export interface McpServerToolDefinition {
  readonly annotations?: ToolAnnotations;
  readonly description?: string;
  readonly inputSchema: JsonSchemaType;
  readonly name: string;
  readonly outputSchema?: JsonSchemaType;
  readonly title?: string;
}

/** JSON arguments accepted by one Server Tool after exact-schema validation. */
export type McpServerToolArguments = Record<string, JSONValue>;

/** Optional server selector accepted by fixed Resource list tools. */
export interface McpListResourcesParameters {
  readonly server?: string;
}

/** Server and URI accepted by the fixed Resource read tool. */
export interface McpReadResourceParameters {
  readonly server: string;
  readonly uri: string;
}

/** Host operations dispatched by registered Server Tools and fixed Resource tools. */
export interface McpToolCatalogRuntime {
  /** Call one Server Tool using its original server and tool names. */
  callServerTool(
    serverId: string,
    toolName: string,
    arguments_: McpServerToolArguments,
    execution: McpToolExecution,
  ): Promise<McpToolOperationResult>;
  /** List Resources, optionally for one server. */
  listResources(
    parameters: McpListResourcesParameters,
    execution: McpToolExecution,
  ): Promise<McpToolOperationResult>;
  /** List Resource Templates, optionally for one server. */
  listResourceTemplates(
    parameters: McpListResourcesParameters,
    execution: McpToolExecution,
  ): Promise<McpToolOperationResult>;
  /** Read one Resource from one server. */
  readResource(
    parameters: McpReadResourceParameters,
    execution: McpToolExecution,
  ): Promise<McpToolOperationResult>;
}

interface ServerCatalog {
  active: boolean;
  tools: readonly McpServerToolDefinition[];
}

interface PreparedServerTool {
  readonly definition: McpServerToolDefinition;
  readonly inputValidator: ReturnType<typeof createMcpSchemaValidator<McpServerToolArguments>>;
  readonly outputValidator: ReturnType<typeof createMcpSchemaValidator<JSONValue>> | undefined;
  readonly serverId: string;
}

/** Expected invalid-input failure raised through Pi's required throwing tool boundary. */
export class McpServerToolInputError extends Error {
  readonly _tag = "McpServerToolInputError" as const;

  /** Build an actionable error without including call values. */
  constructor(
    readonly serverId: string,
    readonly toolName: string,
    readonly issues: string,
  ) {
    super(`Pi MCP Server Tool input invalid for ${serverId}/${toolName}: ${issues}`);
  }
}

function schemaIssues(issues: readonly { readonly message: string }[]): string {
  return issues.map((issue) => issue.message).join("; ");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sanitizeToolNamePart(value: string): string {
  const sanitized = value.replaceAll(/[^A-Za-z0-9_-]/g, "_");
  return sanitized.length === 0 ? "_" : sanitized;
}

function serverToolIdentity(serverId: string, toolName: string): string {
  return `${serverId}\0${toolName}`;
}

function collisionName(
  baseName: string,
  identity: string,
  occupiedNames: ReadonlySet<string>,
): string {
  const hash = createHash("sha256").update(identity).digest("hex");
  for (let length = 8; length <= hash.length; length += 4) {
    const candidate = `${baseName}__${hash.slice(0, length)}`;
    if (!occupiedNames.has(candidate)) return candidate;
  }
  throw new Error(`Pi MCP Server Tool name hash collision for ${baseName}`);
}

function execution(
  toolCallId: string,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  context: ExtensionContext,
): McpToolExecution {
  const forwardUpdate =
    onUpdate === undefined
      ? undefined
      : (partialResult: AgentToolResult<JSONValue | undefined>) => onUpdate(partialResult);
  return { context, onUpdate: forwardUpdate, signal, toolCallId };
}

/** Register exact-schema Server Tools and the stable fixed Resource tools for one MCP Host. */
export class McpToolCatalog {
  private readonly ownedToolNames = new Set<string>();
  private registeredServerTools: readonly {
    readonly prepared: PreparedServerTool;
    readonly identity: string;
    readonly name: string;
  }[] = [];
  private rebuildTail: Promise<void> = Promise.resolve();
  private readonly serverCatalogs = new Map<string, ServerCatalog>();
  private resourceToolsActive = false;

  /** Register inert fixed tools and the MCP error-result bridge. */
  constructor(
    private readonly pi: McpToolCatalogPi,
    private readonly runtime: McpToolCatalogRuntime,
    private readonly redact: McpPresentationRedactor = (text) => text,
  ) {
    this.registerResourceTools();
    this.pi.on("tool_result", (event) => {
      if (!this.ownedToolNames.has(event.toolName)) return;
      const details = parseMcpResultDetails(event.details);
      if (details === undefined || !details.mcp.isError) return;
      return { isError: true };
    });
    this.syncActiveTools();
  }

  /** Replace one server's complete advertised tool list and activate valid definitions. */
  replaceServerTools(serverId: string, tools: readonly McpServerToolDefinition[]): Promise<void> {
    return this.queueServerToolRebuild(() => {
      this.serverCatalogs.set(serverId, { active: true, tools: [...tools] });
      return true;
    });
  }

  /** Activate or deactivate one server's registered tools without touching foreign tools. */
  setServerActive(serverId: string, active: boolean): Promise<void> {
    return this.queueActiveToolSync(() => {
      const catalog = this.serverCatalogs.get(serverId);
      if (catalog === undefined || catalog.active === active) return false;
      catalog.active = active;
      return true;
    });
  }

  /** Activate or deactivate all three fixed Resource tools as one stable capability surface. */
  setResourceToolsActive(active: boolean): Promise<void> {
    return this.queueActiveToolSync(() => {
      if (this.resourceToolsActive === active) return false;
      this.resourceToolsActive = active;
      return true;
    });
  }

  private queueServerToolRebuild(update: () => boolean): Promise<void> {
    const rebuild = this.rebuildTail.then(async () => {
      if (update()) await this.rebuildServerTools();
    });
    this.rebuildTail = rebuild.catch(() => undefined);
    return rebuild;
  }

  private queueActiveToolSync(update: () => boolean): Promise<void> {
    const sync = this.rebuildTail.then(() => {
      if (update()) this.syncActiveTools();
    });
    this.rebuildTail = sync.catch(() => undefined);
    return sync;
  }

  private async rebuildServerTools(): Promise<void> {
    const previousRegistrations = new Map(
      this.registeredServerTools.map((registered) => [registered.identity, registered]),
    );
    const preparedTools: PreparedServerTool[] = [];
    for (const [serverId, catalog] of this.serverCatalogs) {
      for (const definition of catalog.tools) {
        const identity = serverToolIdentity(serverId, definition.name);
        const previous = previousRegistrations.get(identity);
        if (previous?.prepared.definition === definition) {
          preparedTools.push(previous.prepared);
          await scheduler.yield();
          continue;
        }
        const inputValidator = createMcpSchemaValidator<McpServerToolArguments>(
          definition.inputSchema,
        );
        const outputValidator =
          definition.outputSchema === undefined
            ? undefined
            : createMcpSchemaValidator<JSONValue>(definition.outputSchema);
        preparedTools.push({ definition, inputValidator, outputValidator, serverId });
        await scheduler.yield();
      }
    }
    preparedTools.sort((left, right) =>
      serverToolIdentity(left.serverId, left.definition.name).localeCompare(
        serverToolIdentity(right.serverId, right.definition.name),
      ),
    );

    const foreignNames = new Set(
      this.pi
        .getAllTools()
        .map(({ name }) => name)
        .filter((name) => !this.ownedToolNames.has(name)),
    );
    const occupiedNames = new Set([...foreignNames, ...RESOURCE_TOOL_NAMES]);
    const registeredServerTools = [];
    for (const prepared of preparedTools) {
      const baseName = `mcp__${sanitizeToolNamePart(prepared.serverId)}__${sanitizeToolNamePart(prepared.definition.name)}`;
      const identity = serverToolIdentity(prepared.serverId, prepared.definition.name);
      const piToolName = occupiedNames.has(baseName)
        ? collisionName(baseName, identity, occupiedNames)
        : baseName;
      occupiedNames.add(piToolName);
      this.ownedToolNames.add(piToolName);
      const previous = previousRegistrations.get(identity);
      if (previous?.prepared.definition !== prepared.definition || previous.name !== piToolName) {
        this.pi.registerTool(this.serverToolDefinition(prepared, piToolName));
        // Pi activates newly registered tools; keep new names hidden until the complete catalog commits.
        if (previous?.name !== piToolName) {
          const activeToolNames = this.pi.getActiveTools();
          if (activeToolNames.includes(piToolName)) {
            this.pi.setActiveTools(activeToolNames.filter((name) => name !== piToolName));
          }
        }
      }
      registeredServerTools.push({ prepared, identity, name: piToolName });
      await scheduler.yield();
    }
    this.registeredServerTools = registeredServerTools;
    this.syncActiveTools();
  }

  private serverToolDefinition(
    prepared: PreparedServerTool,
    piToolName: string,
  ): McpOutputSchemaToolDefinition {
    // SAFETY: MCP's parsed Tool contract requires inputSchema to be JSON Schema. Pi accepts the same exact structural schema without TypeBox metadata; its MCP validator compiles lazily on first use.
    const parameters = prepared.definition.inputSchema as TSchema;
    const outputSchema =
      prepared.outputValidator !== undefined && prepared.definition.outputSchema !== undefined
        ? validatedMcpResultDetailsOutputSchema(prepared.definition.outputSchema)
        : mcpResultDetailsOutputSchema({});
    return {
      name: piToolName,
      label:
        prepared.definition.title ??
        prepared.definition.annotations?.title ??
        prepared.definition.name,
      description:
        prepared.definition.description ?? `Call MCP Server Tool ${prepared.definition.name}.`,
      parameters,
      outputSchema,
      renderCall: (arguments_, theme, context) =>
        renderMcpServerToolCall(
          prepared.serverId,
          prepared.definition.name,
          arguments_,
          theme,
          context.expanded,
          this.redact,
        ),
      renderResult: (result, options, theme, context) =>
        renderMcpToolResult(result, options, theme, context.isError, this.redact),
      execute: async (toolCallId, arguments_, signal, onUpdate, context) => {
        let parsed;
        try {
          parsed = await prepared.inputValidator["~standard"].validate(arguments_);
        } catch (cause) {
          throw new McpServerToolInputError(
            prepared.serverId,
            prepared.definition.name,
            errorMessage(cause),
          );
        }
        if (parsed.issues !== undefined) {
          throw new McpServerToolInputError(
            prepared.serverId,
            prepared.definition.name,
            schemaIssues(parsed.issues),
          );
        }
        const result = await this.runtime.callServerTool(
          prepared.serverId,
          prepared.definition.name,
          parsed.value,
          execution(toolCallId, signal, onUpdate, context),
        );
        return this.mapOperationResult(
          result,
          `Server Tool ${prepared.serverId}/${prepared.definition.name}`,
          prepared,
        );
      },
    };
  }

  private async mapOperationResult(
    result: McpToolOperationResult,
    operation: string,
    prepared?: PreparedServerTool,
  ): Promise<AgentToolResult<McpResultDetails>> {
    let outputSchemaError: string | undefined;
    let outputSchemaValid: boolean | undefined;
    if (prepared?.outputValidator !== undefined) {
      try {
        const validation = await prepared.outputValidator["~standard"].validate(
          result.structuredContent,
        );
        outputSchemaValid = validation.issues === undefined;
        if (validation.issues !== undefined) outputSchemaError = schemaIssues(validation.issues);
      } catch (cause) {
        outputSchemaError = errorMessage(cause);
        outputSchemaValid = false;
      }
    }
    const content = [...result.content];
    if (outputSchemaValid === false) {
      content.push({
        type: "text",
        text: `[Pi MCP: MCP output schema validation failed for ${operation}; accompanying content was retained.]`,
      });
    }
    const mcp: McpResultMarker = {
      isError: result.isError ?? false,
      operation,
      ...(outputSchemaError === undefined ? {} : { outputSchemaError }),
      ...(outputSchemaValid === undefined ? {} : { outputSchemaValid }),
      owner: "pi-mcp",
      ...(prepared === undefined
        ? {}
        : { serverId: prepared.serverId, toolName: prepared.definition.name }),
    };
    return {
      content,
      details: {
        mcp,
        result: result.details,
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent }),
      },
    };
  }

  private registerResourceTools(): void {
    this.registerResourceTool({
      name: "list_mcp_resources",
      label: "List MCP Resources",
      description: "List Resources advertised by connected MCP Servers.",
      parameters: ListResourcesSchema,
      outputSchema: RESOURCE_RESULT_DETAILS_OUTPUT_SCHEMA,
      renderCall: (parameters, theme, context) =>
        renderMcpResourceToolCall(
          "list_resources",
          parameters,
          theme,
          context.expanded,
          this.redact,
        ),
      renderResult: (result, options, theme, context) =>
        renderMcpToolResult(result, options, theme, context.isError, this.redact),
      execute: async (toolCallId, parameters, signal, onUpdate, context) =>
        this.mapOperationResult(
          await this.runtime.listResources(
            parameters,
            execution(toolCallId, signal, onUpdate, context),
          ),
          "list Resources",
        ),
    });
    this.registerResourceTool({
      name: "list_mcp_resource_templates",
      label: "List MCP Resource Templates",
      description: "List Resource Templates advertised by connected MCP Servers.",
      parameters: ListResourcesSchema,
      outputSchema: RESOURCE_RESULT_DETAILS_OUTPUT_SCHEMA,
      renderCall: (parameters, theme, context) =>
        renderMcpResourceToolCall(
          "list_resource_templates",
          parameters,
          theme,
          context.expanded,
          this.redact,
        ),
      renderResult: (result, options, theme, context) =>
        renderMcpToolResult(result, options, theme, context.isError, this.redact),
      execute: async (toolCallId, parameters, signal, onUpdate, context) =>
        this.mapOperationResult(
          await this.runtime.listResourceTemplates(
            parameters,
            execution(toolCallId, signal, onUpdate, context),
          ),
          "list Resource Templates",
        ),
    });
    this.registerResourceTool({
      name: "read_mcp_resource",
      label: "Read MCP Resource",
      description: "Read one Resource from a connected MCP Server.",
      parameters: ReadResourceSchema,
      outputSchema: RESOURCE_RESULT_DETAILS_OUTPUT_SCHEMA,
      renderCall: (parameters, theme, context) =>
        renderMcpResourceToolCall(
          "read_resource",
          parameters,
          theme,
          context.expanded,
          this.redact,
        ),
      renderResult: (result, options, theme, context) =>
        renderMcpToolResult(result, options, theme, context.isError, this.redact),
      execute: async (toolCallId, parameters, signal, onUpdate, context) =>
        this.mapOperationResult(
          await this.runtime.readResource(
            parameters,
            execution(toolCallId, signal, onUpdate, context),
          ),
          "read Resource",
        ),
    });
  }

  private registerResourceTool<TParameters extends TSchema>(
    tool: McpOutputSchemaToolDefinition<TParameters>,
  ): void {
    this.ownedToolNames.add(tool.name);
    this.pi.registerTool(tool);
  }

  private syncActiveTools(): void {
    const foreignActiveNames = this.pi
      .getActiveTools()
      .filter((name) => !this.ownedToolNames.has(name));
    const ownActiveNames = [
      ...(this.resourceToolsActive ? RESOURCE_TOOL_NAMES : []),
      ...this.registeredServerTools
        .filter(({ prepared }) => this.serverCatalogs.get(prepared.serverId)?.active === true)
        .map(({ name }) => name),
    ];
    const nextActiveNames = [...foreignActiveNames, ...ownActiveNames];
    if (JSON.stringify(nextActiveNames) !== JSON.stringify(this.pi.getActiveTools())) {
      this.pi.setActiveTools(nextActiveNames);
    }
  }
}
