import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { replaceProseReferences } from "@ian-pascoe/pi-utils/prose-references";

/** An MCP server the session can reach, as the model's namespace for its tools names it. */
export interface McpServer {
  /** The configured server name; the target of its `mcp://` links and what users type. */
  name: string;
  /** Pi's tool namespace for the server, such as `mcp__github`. */
  namespace: string;
  description?: string;
}

export const MCP_SERVER_SIGIL = "&";

/** Characters a partially typed server name may hold; Pi allows letters, digits, `_`, and `-`. */
export const MCP_SERVER_PARTIAL_NAME = "[A-Za-z0-9_-]*";

const NAMESPACE_PREFIX = "mcp__";
const SERVER_NAME = /^[A-Za-z0-9_-]+$/u;

type CatalogueTool = Pick<ToolInfo, "exposure" | "namespace">;

/** Hyphen and underscore name the same server, since Pi's namespace folds them together. */
const nameKey = (name: string): string => name.replaceAll("-", "_");

/** An ATX heading line; group 1 is its text without the opening or closing `#`s. */
const ATX_HEADING = /^#{1,6}(?:\s+(.*?))?(?:\s+#+)?$/u;

/** The first non-empty line, without Markdown ATX heading markers (`# Executor`, `## Executor ##`). */
const firstLine = (text: string | undefined): string | undefined =>
  text
    ?.split("\n")
    .map((line) => {
      const trimmed = line.trim();
      const heading = ATX_HEADING.exec(trimmed);
      return heading === null ? trimmed : (heading[1] ?? "").trim();
    })
    .find((line) => line !== "");

/**
 * The MCP Server Catalogue: each `mcp__` namespace that has a tool Pi has not hidden, so disabled
 * servers and servers without tools yet (connecting, or needing sign-in) are absent. A server is
 * named by its first namespace alias, which Pi sets to the configured name, else by the
 * namespace without its prefix. Sorted by name.
 */
export function getMcpServerCatalogue(tools: readonly CatalogueTool[]): McpServer[] {
  const servers = new Map<string, McpServer>();
  for (const { exposure, namespace } of tools) {
    if (namespace === undefined || exposure === "hidden" || servers.has(namespace.name)) continue;
    if (!namespace.name.startsWith(NAMESPACE_PREFIX)) continue;
    const alias = namespace.aliases?.[0];
    const name =
      alias !== undefined && SERVER_NAME.test(alias)
        ? alias
        : namespace.name.slice(NAMESPACE_PREFIX.length);
    if (!SERVER_NAME.test(name)) continue;
    const server: McpServer = { name, namespace: namespace.name };
    const description = firstLine(namespace.description) ?? firstLine(namespace.instructions);
    if (description !== undefined) server.description = description;
    servers.set(namespace.name, server);
  }
  return [...servers.values()].sort((left, right) => left.name.localeCompare(right.name, "en"));
}

/**
 * The servers whose name contains `query` (case-insensitive), names that start with it first, each
 * group sorted by name. An empty query lists every server.
 */
export function matchMcpServers(servers: readonly McpServer[], query: string): McpServer[] {
  const wanted = nameKey(query).toLowerCase();
  const matches = servers
    .map((server) => ({ server, index: nameKey(server.name).toLowerCase().indexOf(wanted) }))
    .filter(({ index }) => index >= 0);
  const rank = ({ index }: { index: number }): number => (index === 0 ? 0 : 1);
  return matches
    .sort(
      (left, right) =>
        rank(left) - rank(right) || left.server.name.localeCompare(right.server.name, "en"),
    )
    .map(({ server }) => server);
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Converts `&server` shorthand for a catalogue server into `[&server](mcp://server "MCP server
 * mcp__server")` inside Prose Spans. Unknown names, code, links, and names that run into a path,
 * domain, or `name:text` stay literal.
 */
export function transformMcpServerReferences(text: string, servers: readonly McpServer[]): string {
  const catalogue = new Map(servers.map((server) => [nameKey(server.name), server]));
  const names = [...catalogue.keys()]
    .sort((left, right) => right.length - left.length)
    // The catalogue key folds `-` into `_`; a typed name may use either.
    .map((key) => escapeRegex(key).replaceAll("_", "[-_]"));
  if (names.length === 0) return text;
  return replaceProseReferences(text, {
    sigil: MCP_SERVER_SIGIL,
    // A colon opens a reference only before a space (`&server: list`); `&server:resource` is a URI.
    // A semicolon right after the name would make an HTML entity (`&amp;`), which stays literal.
    name: `(?:${names.join("|")})(?!:\\S|;)`,
    resolve: (typed) => {
      const server = catalogue.get(nameKey(typed));
      if (server === undefined) return undefined;
      return `[${MCP_SERVER_SIGIL}${typed}](mcp://${server.name} "MCP server ${server.namespace}")`;
    },
  });
}
