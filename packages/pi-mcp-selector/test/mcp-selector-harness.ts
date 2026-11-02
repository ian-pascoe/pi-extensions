import type {
  AutocompleteProviderFactory,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionStartEvent,
  ToolInfo,
  ToolNamespace,
} from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, type AutocompleteProvider } from "@earendil-works/pi-tui";
import mcpSelectorExtension from "../src/index.js";

type Handler = (
  event: InputEvent | SessionStartEvent,
  context: ExtensionContext,
) => InputEventResult | void | Promise<InputEventResult | void>;

export interface FakeServer {
  name: string;
  exposure?: ToolInfo["exposure"];
  aliases?: string[];
  description?: string;
  instructions?: string;
}

/** One tool of an MCP server, as `pi.getAllTools()` reports it. */
export function mcpTool(server: FakeServer): ToolInfo {
  const namespace = `mcp__${server.name.replaceAll("-", "_")}`;
  const toolNamespace: ToolNamespace = {
    name: namespace,
    aliases: server.aliases ?? [server.name],
  };
  if (server.description !== undefined) toolNamespace.description = server.description;
  if (server.instructions !== undefined) toolNamespace.instructions = server.instructions;
  const tool = {
    name: `${namespace}__search`,
    description: "Search",
    parameters: { type: "object", properties: {} },
    exposure: server.exposure ?? "codemode",
    namespace: toolNamespace,
  };
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The extension reads only the namespace and exposure of a tool; the schema is never inspected.
  return tool as unknown as ToolInfo;
}

export class McpSelectorHarness {
  tools: ToolInfo[] = [
    mcpTool({ name: "github", description: "Search code and issues" }),
    mcpTool({ name: "dev-radius", instructions: "\nQuery the radius.\nMore." }),
  ];
  readonly factories: AutocompleteProviderFactory[] = [];
  private readonly handlers = new Map<string, Handler>();
  private bound = false;

  constructor() {
    const api = {
      on: (name: string, handler: Handler) => this.handlers.set(name, handler),
      getAllTools: () => {
        if (!this.bound) throw new Error("Catalogue queried before runtime binding");
        return this.tools;
      },
    };
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: This boundary harness supplies every ExtensionAPI method used by the extension.
    mcpSelectorExtension(api as unknown as ExtensionAPI);
    this.bound = true;
  }

  async provider(
    current: AutocompleteProvider = new CombinedAutocompleteProvider(
      [{ name: "help", description: "Native help" }],
      "/tmp",
      null,
    ),
  ): Promise<AutocompleteProvider> {
    await this.emit({ type: "session_start", reason: "startup" });
    const factory = this.factories[0];
    if (!factory) throw new Error("Missing autocomplete provider");
    return factory(current);
  }

  async emit(event: InputEvent | SessionStartEvent, mode: ExtensionContext["mode"] = "tui") {
    const handler = this.handlers.get(event.type);
    if (!handler) throw new Error(`Missing ${event.type} handler`);
    const context = {
      mode,
      hasUI: mode === "tui" || mode === "rpc",
      ui: {
        addAutocompleteProvider: (factory: AutocompleteProviderFactory) => {
          this.factories.push(factory);
        },
      },
    };
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: This context provides the mode and autocomplete API read by the registered handlers.
    return handler(event, context as unknown as ExtensionContext);
  }
}
