import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "serve";
let cancellations = 0;
let templateListCalls = 0;
let toolRevision = 0;
const pending = new Map();
const pendingSamples = new Map();

if (mode === "ignore-close") process.on("SIGTERM", () => undefined);
process.stderr.write(`pid:${process.pid}\n`);

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "notifications/initialized" && mode === "close-after-initialize") {
    setTimeout(() => process.exit(0), 10);
    return;
  }
  if (message.method === undefined && pendingSamples.has(message.id)) {
    const toolRequestId = pendingSamples.get(message.id);
    pendingSamples.delete(message.id);
    const text =
      message.result?.content?.text ?? `sampling-error:${message.error?.message ?? "unknown"}`;
    respond(toolRequestId, { content: [{ type: "text", text }] });
    return;
  }
  if (message.method === "server/discover") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
    return;
  }
  if (message.method === "initialize") {
    if (mode === "hang") return;
    respond(message.id, {
      protocolVersion: "2025-06-18",
      capabilities:
        mode === "list-change"
          ? { resources: { listChanged: true }, tools: { listChanged: true } }
          : { tools: {} },
      serverInfo: { name: "pi-mcp-client-fixture", version: "1.0.0" },
      instructions: "fixture instructions",
    });
    return;
  }
  if (message.method === "ping") {
    respond(message.id, {});
    return;
  }
  if (mode === "list-change" && message.method === "resources/list") {
    respond(message.id, {
      resources: [
        {
          name: `resource-${toolRevision}`,
          uri: `fixture://resource-${toolRevision}`,
        },
      ],
    });
    return;
  }
  if (mode === "list-change" && message.method === "resources/templates/list") {
    respond(message.id, {
      cacheScope: "private",
      resourceTemplates: [
        {
          name: `template-${toolRevision}-${templateListCalls++}`,
          uriTemplate: `fixture://template-${toolRevision}/{id}`,
        },
      ],
      ttlMs: 60_000,
    });
    return;
  }
  if (message.method === "tools/list") {
    if (mode === "list-change") {
      respond(message.id, {
        tools: [
          {
            name: "trigger",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          {
            name: `revision-${toolRevision}`,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      });
      return;
    }
    respond(message.id, {
      tools: [
        {
          name: "state",
          description: JSON.stringify({
            cwd: process.cwd(),
            customEnvironment: process.env.PI_MCP_CLIENT_FIXTURE,
            unsafeInheritedEnvironment: process.env.PI_MCP_UNSAFE_INHERIT,
            hasPath: process.env.PATH !== undefined,
          }),
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          name: "progress",
          inputSchema: {
            type: "object",
            properties: { intervalMs: { type: "number" } },
            additionalProperties: false,
          },
        },
        {
          name: "never",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          name: "sample",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    if (mode === "list-change" && message.params.name === "trigger") {
      toolRevision += 1;
      respond(message.id, { content: [{ type: "text", text: "changed" }] });
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      send({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
      return;
    }
    if (message.params.name === "sample") {
      const samplingRequestId = `sampling-${message.id}`;
      pendingSamples.set(samplingRequestId, message.id);
      send({
        jsonrpc: "2.0",
        id: samplingRequestId,
        method: "sampling/createMessage",
        params: {
          maxTokens: 32,
          messages: [{ role: "user", content: { type: "text", text: "return context" } }],
        },
      });
      return;
    }
    if (message.params.name === "progress") {
      const intervalMs = message.params.arguments?.intervalMs ?? 40;
      const token = message.params._meta?.progressToken;
      const timers = [1, 2, 3].map((progress) =>
        setTimeout(() => {
          send({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: token, progress, total: 3 },
          });
          if (progress === 3) {
            pending.delete(message.id);
            setTimeout(
              () => respond(message.id, { content: [{ type: "text", text: "complete" }] }),
              1,
            );
          }
        }, intervalMs * progress),
      );
      pending.set(message.id, timers);
      return;
    }
    if (message.params.name === "never") {
      pending.set(message.id, []);
      return;
    }
    respond(message.id, {
      content: [{ type: "text", text: String(cancellations) }],
    });
    return;
  }
  if (message.method === "notifications/cancelled") {
    cancellations += 1;
    const timers = pending.get(message.params.requestId) ?? [];
    for (const timer of timers) clearTimeout(timer);
    pending.delete(message.params.requestId);
  }
});

lines.on("close", () => {
  if (mode !== "ignore-close") process.exit(0);
});
