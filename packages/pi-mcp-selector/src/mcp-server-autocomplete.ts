import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { findProseReferencePrefix } from "@ian-pascoe/pi-utils/prose-references";
import {
  MCP_SERVER_PARTIAL_NAME,
  MCP_SERVER_SIGIL,
  matchMcpServers,
  type McpServer,
} from "./mcp-server-references.js";

const grammar = { sigil: MCP_SERVER_SIGIL, partialName: MCP_SERVER_PARTIAL_NAME };

function prefixAt(lines: string[], cursorLine: number, cursorCol: number): string | null {
  const cursorOffset = lines
    .slice(0, cursorLine)
    .reduce((offset, line) => offset + line.length + 1, cursorCol);
  return findProseReferencePrefix(lines.join("\n"), cursorOffset, grammar);
}

function serverItem(server: McpServer): AutocompleteItem {
  const value = `${MCP_SERVER_SIGIL}${server.name}`;
  const description =
    server.description === undefined ? "MCP server" : `MCP server · ${server.description}`;
  return { value, label: value, description };
}

/**
 * Pi's native `@` completion lists files, so a file named like a server would insert text that
 * converts to a server link. Insert such a file as `@./name` instead.
 */
function withoutServerCollision(
  item: AutocompleteItem,
  servers: readonly McpServer[],
): AutocompleteItem {
  if (!item.value.startsWith(MCP_SERVER_SIGIL)) return item;
  const name = item.value.slice(MCP_SERVER_SIGIL.length);
  const key = name.replaceAll("-", "_");
  if (!servers.some((server) => server.name.replaceAll("-", "_") === key)) return item;
  return { ...item, value: `${MCP_SERVER_SIGIL}./${name}` };
}

/**
 * Lists MCP servers above the files Pi's native `@` completion finds, in one popup. The
 * returned provider engages only for an unquoted `@name` prefix in prose with at least one
 * matching server, and delegates everything else, including applying native items, to `current`.
 */
export function stackMcpServerAutocomplete(
  current: AutocompleteProvider,
  getCatalogue: () => readonly McpServer[],
): AutocompleteProvider {
  // The editor hands an item back by identity, which is how a server item is told from a file.
  const ownItems = new WeakSet<AutocompleteItem>();
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), MCP_SERVER_SIGIL])],
    async getSuggestions(lines, cursorLine, cursorCol, requestOptions) {
      const delegate = () => current.getSuggestions(lines, cursorLine, cursorCol, requestOptions);
      const prefix = prefixAt(lines, cursorLine, cursorCol);
      if (prefix === null) return delegate();
      const catalogue = getCatalogue();
      const matches = matchMcpServers(catalogue, prefix.slice(MCP_SERVER_SIGIL.length));
      if (matches.length === 0) return delegate();
      if (requestOptions.signal.aborted) return null;
      const items = matches.map(serverItem);
      for (const item of items) ownItems.add(item);
      let native: Awaited<ReturnType<AutocompleteProvider["getSuggestions"]>> = null;
      try {
        native = await delegate();
      } catch {
        // Servers still help when file search fails.
      }
      if (requestOptions.signal.aborted) return null;
      if (native === null || native.items.length === 0) return { prefix, items };
      if (native.prefix !== prefix) return native;
      return {
        prefix,
        items: [...items, ...native.items.map((item) => withoutServerCollision(item, catalogue))],
      };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!ownItems.has(item)) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }
      const line = lines[cursorLine] ?? "";
      const beforePrefix = line.slice(0, cursorCol - prefix.length);
      const completed = [...lines];
      completed[cursorLine] = `${beforePrefix}${item.value} ${line.slice(cursorCol)}`;
      return {
        lines: completed,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 1,
      };
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
