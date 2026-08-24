import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server(
  { name: "pi-mcp-legacy-fixture", version: "1.0.0" },
  { capabilities: {} },
);
await server.connect(new StdioServerTransport());
