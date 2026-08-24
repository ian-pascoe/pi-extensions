import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

serveStdio(() => new McpServer({ name: "pi-mcp-current-fixture", version: "1.0.0" }), {
  legacy: "reject",
});
