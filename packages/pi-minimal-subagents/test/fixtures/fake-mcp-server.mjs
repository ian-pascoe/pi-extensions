// Minimal stdio MCP server for offline tests: `node fake-mcp-server.mjs <name> <launch-log>`.
// Appends `<name>` to the launch log once per process, and answers `search` and `other` tools
// with `<name>:<tool>`, plus one resource.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [name = "fake", launchLog] = process.argv.slice(2);
if (launchLog) appendFileSync(launchLog, `${name}\n`);

const tools = ["search", "other"].map((tool) => ({
  name: tool,
  description: `${name} ${tool} tool`,
  inputSchema: { type: "object", properties: {} },
}));

function respond(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name, version: "1.0.0" },
      };
    case "tools/list":
      return { tools };
    case "tools/call":
      return { content: [{ type: "text", text: `${name}:${params.name}` }] };
    case "resources/list":
      return { resources: [{ uri: `${name}://intro`, name: "intro", mimeType: "text/plain" }] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "resources/read":
      return { contents: [{ uri: params.uri, mimeType: "text/plain", text: `${name} intro` }] };
    default:
      return {};
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined || message.method === undefined) return;
  const result = respond(message.method, message.params ?? {});
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
});
