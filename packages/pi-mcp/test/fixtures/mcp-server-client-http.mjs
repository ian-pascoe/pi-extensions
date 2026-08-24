import { createServer } from "node:http";
import { Readable } from "node:stream";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";

const mode = process.argv[2] ?? "http";
const responseHeaders = { "content-type": "application/json" };

const createFixtureServer = ({ requestInfo } = {}) => {
  const server = new McpServer({ name: "pi-mcp-http-fixture", version: "1.0.0" });
  server.registerTool("state", {}, async () => ({
    content: [
      { type: "text", text: `http-ok:${requestInfo?.headers.get("x-fixture") ?? "missing"}` },
    ],
  }));
  return server;
};

const handler = createMcpHandler(createFixtureServer, { legacy: "reject" });
let sseResponse;

const jsonResponse = (message) => {
  if (message.method === "server/discover") {
    return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
  }
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "pi-mcp-sse-fixture", version: "1.0.0" },
        instructions: "sse fixture instructions",
      },
    };
  }
  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{ name: "state", inputSchema: { type: "object", properties: {} } }],
      },
    };
  }
  if (message.method === "tools/call") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "sse-ok" }] },
    };
  }
};

const nodeServer = createServer(async (request, response) => {
  try {
    if (mode === "sse") {
      if (request.method === "GET") {
        sseResponse = response;
        response.writeHead(200, {
          "cache-control": "no-cache",
          connection: "keep-alive",
          "content-type": "text/event-stream",
        });
        response.write("event: endpoint\ndata: /messages\n\n");
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(202).end();
      const result = jsonResponse(message);
      if (message.method === "tools/call" && result !== undefined) {
        result.result.content[0].text = `sse-ok:${request.headers["x-fixture"] ?? "missing"}`;
      }
      if (result !== undefined) {
        sseResponse?.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
      }
      return;
    }

    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const requestInit = { method: request.method, headers };
    if (body !== undefined) {
      requestInit.body = body;
      requestInit.duplex = "half";
    }
    const webRequest = new Request(
      `http://${request.headers.host ?? "127.0.0.1"}${request.url ?? "/"}`,
      requestInit,
    );
    const webResponse = await handler.fetch(webRequest);
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
    if (webResponse.body === null) response.end();
    else Readable.fromWeb(webResponse.body).pipe(response);
  } catch (error) {
    response.writeHead(500, responseHeaders).end(JSON.stringify({ error: String(error) }));
  }
});

nodeServer.listen(0, "127.0.0.1", () => {
  const address = nodeServer.address();
  process.stdout.write(`${address.port}\n`);
});

const shutdown = async () => {
  sseResponse?.end();
  await handler.close();
  nodeServer.closeAllConnections();
  nodeServer.close(() => process.exit(0));
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
