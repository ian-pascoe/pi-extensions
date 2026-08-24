import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function connectToFixture(name: string): Promise<Client> {
  const client = new Client(
    { name: "pi-mcp-negotiation-tracer", version: "0.1.0" },
    {
      versionNegotiation: {
        mode: "auto",
        probe: { timeoutMs: 2_000 },
      },
    },
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fixturePath(name)],
      stderr: "pipe",
    }),
    { timeout: 5_000 },
  );
  return client;
}

describe("MCP v2 public client seams", () => {
  test("auto negotiation reaches a 2026-07-28 server", async () => {
    const client = await connectToFixture("current-server.mjs");
    try {
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      expect(client.getDiscoverResult()).toBeDefined();
    } finally {
      await client.close();
    }
  }, 10_000);
});
