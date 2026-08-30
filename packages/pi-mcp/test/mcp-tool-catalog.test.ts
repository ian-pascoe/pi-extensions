import { fromJsonSchema, type JSONValue, type JsonSchemaType } from "@modelcontextprotocol/client";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { describe, expect, test } from "vitest";
import {
  McpToolCatalog,
  type McpToolCatalogPi,
  type McpListResourcesParameters,
  type McpReadResourceParameters,
  type McpServerToolArguments,
  type McpToolCatalogRuntime,
  type McpToolExecution,
  type McpToolOperationResult,
} from "../src/mcp-tool-catalog.js";

// SAFETY: Catalog execution only forwards this context to the recording runtime, which never reads it.
const TEST_CONTEXT = {} as ExtensionContext;

class RecordingPi implements McpToolCatalogPi {
  readonly tools = new Map<string, ToolDefinition & { readonly outputSchema?: JsonSchemaType }>();
  readonly activeToolChanges: string[][] = [];
  private activeTools: string[];
  private toolResultHandler:
    | ((
        event: ToolResultEvent,
      ) => Promise<{ readonly isError?: boolean } | void> | { readonly isError?: boolean } | void)
    | undefined;

  constructor(foreignTools: readonly string[] = ["read"]) {
    this.activeTools = [...foreignTools];
    for (const name of foreignTools) {
      this.tools.set(name, {
        name,
        label: name,
        description: "Foreign tool",
        parameters: { type: "object" },
        execute: async () => ({ content: [], details: undefined }),
      });
    }
  }

  registerTool<TParameters extends TSchema, TDetails>(
    tool: ToolDefinition<TParameters, TDetails>,
  ): void {
    // SAFETY: The recording map never calls tools through an erased type; each test retrieves and executes the original registered object.
    this.tools.set(tool.name, tool as ToolDefinition & { readonly outputSchema?: JsonSchemaType });
    if (!this.activeTools.includes(tool.name)) this.activeTools.push(tool.name);
  }

  getAllTools(): readonly { readonly name: string }[] {
    return [...this.tools].map(([name]) => ({ name }));
  }

  getActiveTools(): string[] {
    return [...this.activeTools];
  }

  setActiveTools(toolNames: string[]): void {
    this.activeTools = [...toolNames];
    this.activeToolChanges.push([...toolNames]);
  }

  on(
    event: "tool_result",
    handler: (
      event: ToolResultEvent,
    ) => Promise<{ readonly isError?: boolean } | void> | { readonly isError?: boolean } | void,
  ): void {
    expect(event).toBe("tool_result");
    this.toolResultHandler = handler;
  }

  async applyToolResult(
    toolName: string,
    details: JSONValue | undefined,
  ): Promise<{ readonly isError?: boolean } | void> {
    return this.toolResultHandler?.({
      type: "tool_result",
      toolCallId: "call-1",
      toolName,
      input: {},
      content: [{ type: "text", text: "retained" }],
      details,
      isError: false,
    });
  }
}

class RecordingRuntime implements McpToolCatalogRuntime {
  readonly calls: Array<{
    readonly arguments: McpServerToolArguments;
    readonly execution: McpToolExecution;
    readonly serverId: string;
    readonly toolName: string;
  }> = [];
  result: McpToolOperationResult = {
    content: [{ type: "text", text: "server content" }],
    details: { complete: true },
  };

  async callServerTool(
    serverId: string,
    toolName: string,
    arguments_: McpServerToolArguments,
    execution: McpToolExecution,
  ): Promise<McpToolOperationResult> {
    this.calls.push({ arguments: arguments_, execution, serverId, toolName });
    execution.onUpdate?.({
      content: [{ type: "text", text: "progress" }],
      details: { partial: true },
    });
    return this.result;
  }

  async listResources(parameters: McpListResourcesParameters): Promise<McpToolOperationResult> {
    return {
      content: [{ type: "text", text: `resources:${parameters.server ?? "all"}` }],
      details: {},
    };
  }

  async listResourceTemplates(): Promise<McpToolOperationResult> {
    return { content: [{ type: "text", text: "templates" }], details: {} };
  }

  async readResource(parameters: McpReadResourceParameters): Promise<McpToolOperationResult> {
    return { content: [{ type: "text", text: `read:${String(parameters.uri)}` }], details: {} };
  }
}

const exactInputSchema: JsonSchemaType = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { count: { type: "integer", minimum: 1 } },
  required: ["count"],
  additionalProperties: false,
};

const exactOutputSchema: JsonSchemaType = {
  type: "object",
  properties: { accepted: { const: true } },
  required: ["accepted"],
  additionalProperties: false,
};

describe("McpToolCatalog", () => {
  test("registers exact Server Tool schemas with deterministic collision-only hashes", () => {
    const foreignCollision = "mcp__docs_server__lookup";
    const pi = new RecordingPi(["read", foreignCollision]);
    const runtime = new RecordingRuntime();
    const catalog = new McpToolCatalog(pi, runtime);

    catalog.replaceServerTools("docs server", [
      {
        name: "lookup",
        description: "Look up docs",
        annotations: { destructiveHint: false, title: "Lookup" },
        inputSchema: exactInputSchema,
      },
      {
        name: "clean-name",
        description: "No collision",
        inputSchema: { type: "object", additionalProperties: false },
      },
    ]);
    catalog.replaceServerTools("docs@server", [
      { name: "lookup", inputSchema: { type: "object", additionalProperties: false } },
    ]);
    catalog.replaceServerTools("broken", [
      {
        name: "invalid",
        // SAFETY: This deliberately malformed value exercises the catalog's runtime schema boundary.
        inputSchema: { type: "not-json-schema" } as JsonSchemaType,
      },
    ]);

    const lookupNames = [...pi.tools.keys()].filter((name) => name.startsWith(foreignCollision));
    expect(lookupNames).toEqual([
      foreignCollision,
      expect.stringMatching(/^mcp__docs_server__lookup__[a-f0-9]{8,}$/),
      expect.stringMatching(/^mcp__docs_server__lookup__[a-f0-9]{8,}$/),
    ]);
    expect(new Set(lookupNames).size).toBe(lookupNames.length);
    const exactTool = [...pi.tools.values()].find(
      (tool) =>
        tool.name !== foreignCollision &&
        tool.name.startsWith("mcp__docs_server__lookup__") &&
        tool.description === "Look up docs",
    );
    expect(exactTool?.parameters).toBe(exactInputSchema);
    expect(exactTool?.outputSchema).toMatchObject({
      properties: { structuredContent: {} },
      required: ["mcp", "result"],
    });
    expect(exactTool?.label).toBe("Lookup");
    expect(exactTool?.renderCall).toEqual(expect.any(Function));
    expect(exactTool?.renderResult).toEqual(expect.any(Function));
    expect(pi.tools.has("mcp__docs_server__clean-name")).toBe(true);
    expect([...pi.tools.keys()].some((name) => name.includes("broken"))).toBe(false);
    expect([...pi.tools.keys()].filter((name) => name.includes("mcp_task"))).toEqual([]);
  });

  test("revalidates mutated input and bridges abort, progress, output validation, and MCP errors", async () => {
    const pi = new RecordingPi();
    const runtime = new RecordingRuntime();
    const catalog = new McpToolCatalog(pi, runtime);
    catalog.replaceServerTools("server", [
      {
        name: "count",
        inputSchema: exactInputSchema,
        outputSchema: exactOutputSchema,
      },
    ]);
    const tool = pi.tools.get("mcp__server__count");
    if (tool === undefined) throw new Error("Expected registered Server Tool");
    if (tool.outputSchema === undefined) throw new Error("Expected registered output schema");
    expect(tool.outputSchema).toMatchObject({
      anyOf: [
        {
          properties: {
            mcp: { allOf: [{}, { properties: { outputSchemaValid: { const: true } } }] },
            structuredContent: exactOutputSchema,
          },
          required: ["mcp", "result"],
        },
        {
          properties: {
            mcp: { allOf: [{}, { properties: { outputSchemaValid: { const: false } } }] },
            structuredContent: {},
          },
          required: ["mcp", "result"],
        },
      ],
    });

    await expect(
      tool.execute("bad", { count: 0 }, undefined, undefined, TEST_CONTEXT),
    ).rejects.toThrow("Pi MCP Server Tool input invalid");
    expect(runtime.calls).toEqual([]);

    const abortController = new AbortController();
    const updates: AgentToolResult<unknown>[] = [];
    runtime.result = {
      content: [{ type: "text", text: "retained despite MCP error" }],
      details: { server: "details" },
      isError: true,
      structuredContent: { accepted: false },
    };
    const result = await tool.execute(
      "good",
      { count: 2 },
      abortController.signal,
      (update) => updates.push(update),
      TEST_CONTEXT,
    );

    expect(runtime.calls).toEqual([
      expect.objectContaining({
        arguments: { count: 2 },
        serverId: "server",
        toolName: "count",
      }),
    ]);
    expect(runtime.calls[0]?.execution.signal).toBe(abortController.signal);
    expect(updates).toEqual([
      { content: [{ type: "text", text: "progress" }], details: { partial: true } },
    ]);
    expect(result.content).toEqual([
      { type: "text", text: "retained despite MCP error" },
      {
        type: "text",
        text: expect.stringContaining("MCP output schema validation failed"),
      },
    ]);
    expect(result.details).toEqual(
      expect.objectContaining({
        mcp: expect.objectContaining({ isError: true, outputSchemaValid: false }),
        result: { server: "details" },
        structuredContent: { accepted: false },
      }),
    );
    // SAFETY: The catalog owns this registered tool and returns JSON-safe MCP marker details.
    const resultDetails = result.details as JSONValue;
    const declaredOutputValidator = fromJsonSchema<JSONValue>(tool.outputSchema);
    expect(
      (await declaredOutputValidator["~standard"].validate(resultDetails)).issues,
    ).toBeUndefined();
    await expect(pi.applyToolResult(tool.name, resultDetails)).resolves.toEqual({ isError: true });
    await expect(
      pi.applyToolResult("foreign_extension_tool", resultDetails),
    ).resolves.toBeUndefined();
  });

  test("replaces and deactivates Server Tools without changing foreign active tools", () => {
    const pi = new RecordingPi(["read", "foreign_extension_tool"]);
    const catalog = new McpToolCatalog(pi, new RecordingRuntime());
    catalog.replaceServerTools("server", [
      { name: "first", inputSchema: { type: "object" } },
      { name: "second", inputSchema: { type: "object" } },
    ]);
    expect(pi.getActiveTools()).toEqual([
      "read",
      "foreign_extension_tool",
      "mcp__server__first",
      "mcp__server__second",
    ]);

    catalog.replaceServerTools("server", [
      { name: "second", description: "replacement", inputSchema: { type: "object" } },
      { name: "third", inputSchema: { type: "object" } },
    ]);
    expect(pi.tools.get("mcp__server__second")?.description).toBe("replacement");
    expect(pi.getActiveTools()).toEqual([
      "read",
      "foreign_extension_tool",
      "mcp__server__second",
      "mcp__server__third",
    ]);

    catalog.setServerActive("server", false);
    expect(pi.getActiveTools()).toEqual(["read", "foreign_extension_tool"]);
    catalog.setServerActive("server", true);
    expect(pi.getActiveTools()).toEqual([
      "read",
      "foreign_extension_tool",
      "mcp__server__second",
      "mcp__server__third",
    ]);
  });

  test("registers only the three stable resource tools and activates them by capability", async () => {
    const pi = new RecordingPi();
    const catalog = new McpToolCatalog(pi, new RecordingRuntime());
    const resourceToolNames = [
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
    ];

    expect(resourceToolNames.every((name) => pi.tools.has(name))).toBe(true);
    expect(
      resourceToolNames.every((name) => {
        const outputSchema = pi.tools.get(name)?.outputSchema;
        return (
          outputSchema !== undefined &&
          "properties" in outputSchema &&
          outputSchema.properties?.structuredContent === undefined
        );
      }),
    ).toBe(true);
    expect(
      resourceToolNames.every((name) => {
        const tool = pi.tools.get(name);
        return tool?.renderCall !== undefined && tool.renderResult !== undefined;
      }),
    ).toBe(true);
    expect(pi.getActiveTools()).toEqual(["read"]);
    catalog.setResourceToolsActive(true);
    expect(pi.getActiveTools()).toEqual(["read", ...resourceToolNames]);

    const list = pi.tools.get("list_mcp_resources");
    const read = pi.tools.get("read_mcp_resource");
    if (list === undefined || read === undefined) throw new Error("Expected fixed resource tools");
    await expect(
      list.execute("list", { server: "docs" }, undefined, undefined, TEST_CONTEXT),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "resources:docs" }],
    });
    await expect(
      read.execute(
        "read",
        { server: "docs", uri: "file:///guide.md" },
        undefined,
        undefined,
        TEST_CONTEXT,
      ),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "read:file:///guide.md" }] });
    catalog.setResourceToolsActive(false);
    expect(pi.getActiveTools()).toEqual(["read"]);
  });
});
