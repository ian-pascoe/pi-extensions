import type { InputEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { McpSelectorHarness, mcpTool } from "./mcp-selector-harness.js";

const GITHUB = '[@github](mcp://github "MCP server mcp__github")';
const RADIUS = '[@dev-radius](mcp://dev-radius "MCP server mcp__dev_radius")';

describe("Pi MCP Selector input", () => {
  test("first prompt converts references to servers in the bound Catalogue", async () => {
    const harness = new McpSelectorHarness();
    expect(
      await harness.emit({
        type: "input",
        source: "interactive",
        text: "Use @github and @dev-radius.",
      }),
    ).toEqual({ action: "transform", text: `Use ${GITHUB} and ${RADIUS}.` });
  });

  test("reads the Catalogue fresh on every submission", async () => {
    const harness = new McpSelectorHarness();
    harness.tools = [];
    expect(await harness.emit({ type: "input", source: "interactive", text: "@github" })).toEqual({
      action: "continue",
    });
    harness.tools = [mcpTool({ name: "github" })];
    expect(await harness.emit({ type: "input", source: "interactive", text: "@github" })).toEqual({
      action: "transform",
      text: GITHUB,
    });
    harness.tools = [mcpTool({ name: "github", exposure: "hidden" })];
    expect(await harness.emit({ type: "input", source: "interactive", text: "@github" })).toEqual({
      action: "continue",
    });
  });

  test("keeps servers that are not codemode-active or loaded mentionable", async () => {
    const harness = new McpSelectorHarness();
    harness.tools = [
      mcpTool({ name: "github", exposure: "deferred" }),
      mcpTool({ name: "dev-radius", exposure: "direct" }),
    ];
    expect(
      await harness.emit({ type: "input", source: "interactive", text: "@github @dev-radius" }),
    ).toEqual({ action: "transform", text: `${GITHUB} ${RADIUS}` });
  });

  test.each(["interactive", "rpc"] as const)(
    "preserves %s attachments and steering/follow-up delivery",
    async (source) => {
      const harness = new McpSelectorHarness();
      for (const streamingBehavior of ["steer", "followUp"] as const) {
        const event: InputEvent = {
          type: "input",
          source,
          text: "@github",
          streamingBehavior,
          images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        };
        expect(await harness.emit(event, source === "rpc" ? "rpc" : "tui")).toEqual({
          action: "transform",
          text: GITHUB,
          images: event.images,
        });
        expect(event.streamingBehavior).toBe(streamingBehavior);
        expect(event.text).toBe("@github");
      }
    },
  );

  test.each(["print", "json"] as const)("converts in %s mode", async (mode) => {
    const harness = new McpSelectorHarness();
    expect(
      await harness.emit({ type: "input", source: "interactive", text: "@github" }, mode),
    ).toEqual({ action: "transform", text: GITHUB });
  });

  test("leaves extension-generated messages, unknown names, and file mentions unchanged", async () => {
    const harness = new McpSelectorHarness();
    expect(await harness.emit({ type: "input", source: "extension", text: "@github" })).toEqual({
      action: "continue",
    });
    expect(
      await harness.emit({
        type: "input",
        source: "interactive",
        text: "@unknown @src/index.ts @github.com @./github",
      }),
    ).toEqual({ action: "continue" });
  });

  test("does not convert a server that is still connecting or needs sign-in (no tools yet)", async () => {
    const harness = new McpSelectorHarness();
    harness.tools = [];
    expect(
      await harness.emit({ type: "input", source: "interactive", text: "ask @github" }),
    ).toEqual({ action: "continue" });
  });
});
