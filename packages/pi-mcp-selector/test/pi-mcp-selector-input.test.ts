import type { InputEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vite-plus/test";
import { McpSelectorHarness, mcpTool } from "./mcp-selector-harness.js";

const GITHUB = '[&github](mcp://github "MCP server mcp__github")';
const RADIUS = '[&dev-radius](mcp://dev-radius "MCP server mcp__dev_radius")';

describe("Pi MCP Selector input", () => {
  test("first prompt converts references to servers in the bound Catalogue", async () => {
    const harness = new McpSelectorHarness();
    expect(
      await harness.emit({
        type: "input",
        source: "interactive",
        text: "Use &github and &dev-radius.",
      }),
    ).toEqual({ action: "transform", text: `Use ${GITHUB} and ${RADIUS}.` });
  });

  test("reads the Catalogue fresh on every submission", async () => {
    const harness = new McpSelectorHarness();
    harness.tools = [];
    expect(await harness.emit({ type: "input", source: "interactive", text: "&github" })).toEqual({
      action: "continue",
    });
    harness.tools = [mcpTool({ name: "github" })];
    expect(await harness.emit({ type: "input", source: "interactive", text: "&github" })).toEqual({
      action: "transform",
      text: GITHUB,
    });
    harness.tools = [mcpTool({ name: "github", exposure: "hidden" })];
    expect(await harness.emit({ type: "input", source: "interactive", text: "&github" })).toEqual({
      action: "continue",
    });
  });

  test("preserves attachments and steering delivery", async () => {
    const harness = new McpSelectorHarness();
    const event: InputEvent = {
      type: "input",
      source: "rpc",
      text: "&github",
      streamingBehavior: "steer",
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    };
    expect(await harness.emit(event, "rpc")).toEqual({
      action: "transform",
      text: GITHUB,
      images: event.images,
    });
    expect(event.streamingBehavior).toBe("steer");
    expect(event.text).toBe("&github");
  });

  test("leaves extension-generated messages, unknown names, and file paths unchanged", async () => {
    const harness = new McpSelectorHarness();
    expect(await harness.emit({ type: "input", source: "extension", text: "&github" })).toEqual({
      action: "continue",
    });
    expect(
      await harness.emit({
        type: "input",
        source: "interactive",
        text: "&unknown &src/index.ts &github.com &./github",
      }),
    ).toEqual({ action: "continue" });
  });
});
