import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stackMcpServerAutocomplete } from "./mcp-server-autocomplete.js";
import { getMcpServerCatalogue, transformMcpServerReferences } from "./mcp-server-references.js";

export default function mcpSelectorExtension(pi: ExtensionAPI): void {
  // Read fresh on every use: servers connect, disconnect, and change exposure during a session.
  const getCatalogue = () => getMcpServerCatalogue(pi.getAllTools());

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider((current) => stackMcpServerAutocomplete(current, getCatalogue));
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
