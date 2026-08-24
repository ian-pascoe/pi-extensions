import { createHash } from "node:crypto";
import {
  fromJsonSchema,
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
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

const RESOURCE_TOOL_NAMES = [
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
] as const;
const MCP_DETAILS_OWNER = "pi-mcp";
const McpResultDetailsMarkerSchema = Type.Object(
  {
    mcp: Type.Object(
      {
        isError: Type.Boolean(),
        owner: Type.Literal(MCP_DETAILS_OWNER),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

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

/** One diagnostic retaining the MCP names and untrusted annotations behind a Pi tool. */
export interface McpToolCatalogDiagnostic {
  readonly annotations?: ToolAnnotations;
  readonly message?: string;
  readonly originalServerId: string;
  readonly originalToolName: string;
  readonly piToolName?: string;
  readonly status: "invalid_schema" | "registered";
}

interface ServerCatalog {
  active: boolean;
  tools: readonly McpServerToolDefinition[];
}

interface CompiledServerTool {
  readonly definition: McpServerToolDefinition;
  readonly inputValidator: ReturnType<typeof fromJsonSchema<McpServerToolArguments>>;
  readonly outputSchemaError?: string;
  readonly outputValidator?: ReturnType<typeof fromJsonSchema<JSONValue>>;
  readonly serverId: string;
}

interface McpResultMarker {
  isError: boolean;
  operation: string;
  outputSchemaError?: string;
  outputSchemaValid?: boolean;
  owner: typeof MCP_DETAILS_OWNER;
  serverId?: string;
  toolName?: string;
}

interface McpResultDetails {
  readonly mcp: McpResultMarker;
  readonly result: JSONValue | undefined;
}

/** Expected invalid-input failure raised through Pi's required throwing tool boundary. */
export class McpServerToolInputError extends Error {
  /** Stable error discriminator. */
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This parser owns Pi's untyped custom tool-result details boundary.
function parseMcpResultDetails(input: unknown): McpResultDetails | undefined {
  if (!Value.Check(McpResultDetailsMarkerSchema, input)) return undefined;
  // SAFETY: The marker schema established the fields read by the result hook; this module created all matching details objects.
  return input as McpResultDetails;
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
  private readonly serverCatalogs = new Map<string, ServerCatalog>();
  private diagnostics: readonly McpToolCatalogDiagnostic[] = [];
  private resourceToolsActive = false;

  /** Register inert fixed tools and the MCP error-result bridge. */
  constructor(
    private readonly pi: McpToolCatalogPi,
    private readonly runtime: McpToolCatalogRuntime,
  ) {
    this.registerResourceTools();
    this.pi.on("tool_result", (event) => {
      if (!this.ownedToolNames.has(event.toolName)) return;
      const details = parseMcpResultDetails(event.details);
      if (details === undefined || !details.mcp.isError) return;
      return { isError: true };
    });
    this.syncActiveTools([]);
  }

  /** Replace one server's complete advertised tool list and activate valid definitions. */
  replaceServerTools(serverId: string, tools: readonly McpServerToolDefinition[]): void {
    this.serverCatalogs.set(serverId, { active: true, tools: [...tools] });
    this.rebuildServerTools();
  }

  /** Activate or deactivate one server's registered tools without touching foreign tools. */
  setServerActive(serverId: string, active: boolean): void {
    const catalog = this.serverCatalogs.get(serverId);
    if (catalog === undefined || catalog.active === active) return;
    catalog.active = active;
    this.rebuildServerTools();
  }

  /** Activate or deactivate all three fixed Resource tools as one stable capability surface. */
  setResourceToolsActive(active: boolean): void {
    if (this.resourceToolsActive === active) return;
    this.resourceToolsActive = active;
    this.rebuildServerTools();
  }

  /** Return current diagnostics as an immutable snapshot. */
  getDiagnostics(): readonly McpToolCatalogDiagnostic[] {
    return structuredClone(this.diagnostics);
  }

  private rebuildServerTools(): void {
    const diagnostics: McpToolCatalogDiagnostic[] = [];
    const compiledTools: CompiledServerTool[] = [];
    for (const [serverId, catalog] of this.serverCatalogs) {
      for (const definition of catalog.tools) {
        try {
          // SAFETY: fromJsonSchema is the owning boundary parser and rejects values that are not JSON Schema.
          const inputValidator = fromJsonSchema<McpServerToolArguments>(definition.inputSchema);
          let outputValidator: ReturnType<typeof fromJsonSchema<JSONValue>> | undefined;
          let outputSchemaError: string | undefined;
          if (definition.outputSchema !== undefined) {
            try {
              // SAFETY: fromJsonSchema is the owning boundary parser and rejects values that are not JSON Schema.
              outputValidator = fromJsonSchema<JSONValue>(definition.outputSchema);
            } catch (cause) {
              outputSchemaError = cause instanceof Error ? cause.message : String(cause);
            }
          }
          let compiled: CompiledServerTool;
          if (outputValidator !== undefined) {
            compiled = { definition, inputValidator, outputValidator, serverId };
          } else if (outputSchemaError !== undefined) {
            compiled = { definition, inputValidator, outputSchemaError, serverId };
          } else {
            compiled = { definition, inputValidator, serverId };
          }
          compiledTools.push(compiled);
        } catch (cause) {
          const diagnosticBase = {
            message: cause instanceof Error ? cause.message : String(cause),
            originalServerId: serverId,
            originalToolName: definition.name,
            status: "invalid_schema" as const,
          };
          diagnostics.push(
            definition.annotations === undefined
              ? diagnosticBase
              : { ...diagnosticBase, annotations: structuredClone(definition.annotations) },
          );
        }
      }
    }
    compiledTools.sort((left, right) =>
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
    const activeNames: string[] = [];
    for (const compiled of compiledTools) {
      const baseName = `mcp__${sanitizeToolNamePart(compiled.serverId)}__${sanitizeToolNamePart(compiled.definition.name)}`;
      const identity = serverToolIdentity(compiled.serverId, compiled.definition.name);
      const piToolName = occupiedNames.has(baseName)
        ? collisionName(baseName, identity, occupiedNames)
        : baseName;
      occupiedNames.add(piToolName);
      this.ownedToolNames.add(piToolName);
      this.pi.registerTool(this.serverToolDefinition(compiled, piToolName));
      const diagnosticBase = {
        originalServerId: compiled.serverId,
        originalToolName: compiled.definition.name,
        piToolName,
        status: "registered" as const,
      };
      diagnostics.push(
        compiled.definition.annotations === undefined
          ? diagnosticBase
          : {
              ...diagnosticBase,
              annotations: structuredClone(compiled.definition.annotations),
            },
      );
      if (this.serverCatalogs.get(compiled.serverId)?.active === true) activeNames.push(piToolName);
    }
    this.diagnostics = diagnostics;
    this.syncActiveTools(activeNames);
  }

  private serverToolDefinition(compiled: CompiledServerTool, piToolName: string): ToolDefinition {
    // SAFETY: MCP's parsed Tool contract requires inputSchema to be JSON Schema; fromJsonSchema compiled this exact object above. Pi accepts the same structural schema without TypeBox metadata.
    const parameters = compiled.definition.inputSchema as TSchema;
    return {
      name: piToolName,
      label:
        compiled.definition.title ??
        compiled.definition.annotations?.title ??
        compiled.definition.name,
      description:
        compiled.definition.description ?? `Call MCP Server Tool ${compiled.definition.name}.`,
      parameters,
      execute: async (toolCallId, arguments_, signal, onUpdate, context) => {
        const parsed = await compiled.inputValidator["~standard"].validate(arguments_);
        if (parsed.issues !== undefined) {
          throw new McpServerToolInputError(
            compiled.serverId,
            compiled.definition.name,
            schemaIssues(parsed.issues),
          );
        }
        const result = await this.runtime.callServerTool(
          compiled.serverId,
          compiled.definition.name,
          parsed.value,
          execution(toolCallId, signal, onUpdate, context),
        );
        return this.mapOperationResult(
          result,
          `Server Tool ${compiled.serverId}/${compiled.definition.name}`,
          compiled,
        );
      },
    };
  }

  private async mapOperationResult(
    result: McpToolOperationResult,
    operation: string,
    compiled?: CompiledServerTool,
  ): Promise<AgentToolResult<McpResultDetails>> {
    let outputSchemaError = compiled?.outputSchemaError;
    let outputSchemaValid: boolean | undefined;
    if (compiled?.outputValidator !== undefined) {
      const validation = await compiled.outputValidator["~standard"].validate(
        result.structuredContent,
      );
      outputSchemaValid = validation.issues === undefined;
      if (validation.issues !== undefined) outputSchemaError = schemaIssues(validation.issues);
    } else if (outputSchemaError !== undefined) {
      outputSchemaValid = false;
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
      owner: MCP_DETAILS_OWNER,
    };
    if (outputSchemaError !== undefined) mcp.outputSchemaError = outputSchemaError;
    if (outputSchemaValid !== undefined) mcp.outputSchemaValid = outputSchemaValid;
    if (compiled !== undefined) {
      mcp.serverId = compiled.serverId;
      mcp.toolName = compiled.definition.name;
    }
    return { content, details: { mcp, result: result.details } };
  }

  private registerResourceTools(): void {
    this.registerResourceTool({
      name: "list_mcp_resources",
      label: "List MCP Resources",
      description: "List Resources advertised by connected MCP Servers.",
      parameters: ListResourcesSchema,
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
    tool: ToolDefinition<TParameters, unknown>,
  ): void {
    this.ownedToolNames.add(tool.name);
    this.pi.registerTool(tool);
  }

  private syncActiveTools(serverToolNames: readonly string[]): void {
    const foreignActiveNames = this.pi
      .getActiveTools()
      .filter((name) => !this.ownedToolNames.has(name));
    const ownActiveNames = [
      ...(this.resourceToolsActive ? RESOURCE_TOOL_NAMES : []),
      ...serverToolNames,
    ];
    const nextActiveNames = [...foreignActiveNames, ...ownActiveNames];
    if (JSON.stringify(nextActiveNames) !== JSON.stringify(this.pi.getActiveTools())) {
      this.pi.setActiveTools(nextActiveNames);
    }
  }
}
