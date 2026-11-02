import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { stackProseReferenceAutocomplete } from "@ian-pascoe/pi-utils/prose-references";
import {
  getMcpServerCatalogue,
  MCP_SERVER_PARTIAL_NAME,
  MCP_SERVER_SIGIL,
  matchMcpServers,
  transformMcpServerReferences,
} from "./mcp-server-references.js";

export default function mcpSelectorExtension(pi: ExtensionAPI): void {
  // Read fresh on every use: servers connect, disconnect, and change exposure during a session.
  const getCatalogue = () => getMcpServerCatalogue(pi.getAllTools());

  const createAutocompleteProvider = (current: AutocompleteProvider): AutocompleteProvider =>
    stackProseReferenceAutocomplete(current, {
      sigil: MCP_SERVER_SIGIL,
      partialName: MCP_SERVER_PARTIAL_NAME,
      suggest: (query) =>
        matchMcpServers(getCatalogue(), query).map((server) => {
          const value = `${MCP_SERVER_SIGIL}${server.name}`;
          return {
            value,
            label: value,
            description:
              server.description === undefined
                ? "MCP server"
                : `MCP server · ${server.description}`,
          };
        }),
    });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider(createAutocompleteProvider);
  });

  pi.on("input", (event) => {
    if (event.source === "extension") return { action: "continue" };
    const text = transformMcpServerReferences(event.text, getCatalogue());
    if (text === event.text) return { action: "continue" };
    return event.images === undefined
      ? { action: "transform", text }
      : { action: "transform", text, images: event.images };
  });
}
