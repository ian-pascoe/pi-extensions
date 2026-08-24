import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { expect, test } from "vitest";
import { createMcpContentResult } from "../src/mcp-content.js";
import { createMcpSessionFiles } from "../src/mcp-session-files.js";

test("maps MCP text, images, embedded resources, links, and structured content without hiding provenance", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "pi-mcp-content-"));
  const files = await createMcpSessionFiles(sessionDirectory);
  try {
    const result = await createMcpContentResult(
      [
        { type: "text", text: "plain text" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        {
          type: "resource",
          resource: { uri: "file:///example.txt", mimeType: "text/plain", text: "embedded text" },
        },
        {
          type: "resource_link",
          uri: "https://example.test/report",
          name: "Report",
          description: "server report",
          mimeType: "text/html",
        },
      ],
      { count: 2, state: "complete" },
      files,
    );

    expect(result.content).toEqual([
      { type: "text", text: "plain text" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      {
        type: "text",
        text: "[MCP embedded resource: file:///example.txt (text/plain)]\nembedded text",
      },
      {
        type: "text",
        text: "[MCP resource link: Report] https://example.test/report (text/html) — server report",
      },
      { type: "text", text: '[MCP structured content]\n{"count":2,"state":"complete"}' },
    ]);
    expect(result.details.spillPath).toBeUndefined();
    expect(result.details.storedContent).toEqual([]);
  } finally {
    await files.close();
    await rm(sessionDirectory, { force: true, recursive: true });
  }
});

test("stores unsupported audio and binary resources privately while keeping paths model-visible", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "pi-mcp-content-"));
  const files = await createMcpSessionFiles(sessionDirectory);
  try {
    const result = await createMcpContentResult(
      [
        { type: "audio", data: "YXVkaW8=", mimeType: "audio/mpeg" },
        {
          type: "resource",
          resource: {
            uri: "file:///example.bin",
            mimeType: "application/octet-stream",
            blob: "AP8H",
          },
        },
      ],
      undefined,
      files,
    );

    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("MCP unsupported audio (audio/mpeg) stored at"),
      },
      {
        type: "text",
        text: expect.stringContaining("MCP embedded binary resource: file:///example.bin"),
      },
    ]);
    expect(result.details.storedContent).toHaveLength(2);
    await expect(readFile(result.details.storedContent[0]!.path)).resolves.toEqual(
      Buffer.from("audio"),
    );
    await expect(readFile(result.details.storedContent[1]!.path)).resolves.toEqual(
      Buffer.from([0, 255, 7]),
    );
  } finally {
    await files.close();
    await rm(sessionDirectory, { force: true, recursive: true });
  }
});

test("truncates model-facing MCP content and writes its complete representation to a Result Spill", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "pi-mcp-content-"));
  const files = await createMcpSessionFiles(sessionDirectory);
  try {
    const completeText = Array.from({ length: 2_001 }, (_, index) => `line ${index}`).join("\n");
    const result = await createMcpContentResult(
      [{ type: "text", text: completeText }],
      undefined,
      files,
    );

    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("[Pi MCP: content truncated; complete Result Spill:"),
      },
    ]);
    expect(result.details.spillPath).toEqual(expect.any(String));
    await expect(readFile(result.details.spillPath!, "utf8")).resolves.toBe(completeText);
  } finally {
    await files.close();
    await rm(sessionDirectory, { force: true, recursive: true });
  }
});
