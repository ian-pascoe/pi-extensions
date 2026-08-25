/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-unsafe-dictionary-type -- Test fixtures deliberately assemble historical and malformed renderer-boundary details. */
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type AgentToolResult,
  type MessageRenderOptions,
} from "@earendil-works/pi-coding-agent";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
  parseMcpPromptReplayMessages,
  parseMcpResultDetails,
  renderMcpPromptMessage,
  renderMcpResourceToolCall,
  renderMcpResourceUpdateMessage,
  renderMcpServerToolCall,
  renderMcpToolResult,
  sanitizeMcpPresentationText,
  type McpRenderTheme,
} from "../src/mcp-presentation.js";

const plainTheme = {
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} satisfies McpRenderTheme;

function renderText(component: { render(width: number): string[] }, width = 120): string {
  return component
    .render(width)
    .map((line) => line.trimEnd())
    .join("\n");
}

const collapsed = { expanded: false, isPartial: false } as const;
const expanded = { expanded: true, isPartial: false } as const;
const messageExpanded = { expanded: true, outputPad: 1 } satisfies MessageRenderOptions;

function resultDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mcp: {
      isError: false,
      operation: "Server Tool docs/search",
      owner: "pi-mcp",
      serverId: "docs",
      toolName: "search",
      ...overrides,
    },
    result: {
      spillPath: "/tmp/result-spill.txt",
      storedContent: [{ kind: "audio", mimeType: "audio/mpeg", path: "/tmp/audio.bin" }],
      summary: "first line\nsecond line",
    },
  };
}

describe("MCP Transcript Presentation", () => {
  test("renders original Server Tool identities and deterministic bounded arguments", () => {
    const arguments_ = {
      zeta: { second: 2, first: 1 },
      query: "observer UI",
      empty: [],
    };
    const before = structuredClone(arguments_);

    const call = renderText(
      renderMcpServerToolCall("docs server", "search/tool", arguments_, plainTheme, false),
    );
    expect(call).toContain("MCP  docs server / search/tool");
    expect(call).toContain('query="observer UI"');
    expect(call).toContain('zeta={"first":1,"second":2}');

    const full = renderText(
      renderMcpServerToolCall("docs server", "search/tool", arguments_, plainTheme, true),
    );
    expect(full.indexOf('"empty"')).toBeLessThan(full.indexOf('"query"'));
    expect(full.indexOf('"query"')).toBeLessThan(full.indexOf('"zeta"'));
    expect(arguments_).toEqual(before);
  });

  test("renders all fixed Resource operations with their semantic targets", () => {
    expect(
      renderText(
        renderMcpResourceToolCall("list_resources", { server: "docs" }, plainTheme, false),
      ),
    ).toContain("MCP  List Resources  docs");
    expect(
      renderText(
        renderMcpResourceToolCall("list_resource_templates", { server: "docs" }, plainTheme, false),
      ),
    ).toContain("MCP  List Resource Templates  docs");
    expect(
      renderText(
        renderMcpResourceToolCall(
          "read_resource",
          { server: "docs", uri: "file:///guide" },
          plainTheme,
          false,
        ),
      ),
    ).toContain("MCP  Read Resource  docs  file:///guide");
  });

  test("renders semantic success, MCP failure, schema warning, progress, and stored metadata", () => {
    const success: AgentToolResult<unknown> = {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
      details: resultDetails(),
    };
    expect(renderText(renderMcpToolResult(success, collapsed, plainTheme, false))).toContain(
      "✓ completed  ·  2 text blocks  ·  1 image",
    );

    const failed: AgentToolResult<unknown> = {
      content: [{ type: "text", text: "permission denied\nserver detail" }],
      details: resultDetails({ isError: true }),
    };
    expect(renderText(renderMcpToolResult(failed, collapsed, plainTheme, false))).toContain(
      "× failed  ·  permission denied",
    );

    const warning: AgentToolResult<unknown> = {
      content: [{ type: "text", text: "retained" }],
      details: resultDetails({ outputSchemaError: "wrong shape", outputSchemaValid: false }),
    };
    expect(renderText(renderMcpToolResult(warning, collapsed, plainTheme, false))).toContain(
      "! completed with output-schema failure",
    );

    const partial: AgentToolResult<unknown> = {
      content: [{ type: "text", text: 'MCP progress: {"progress":42}' }],
      details: { progress: { progress: 42 } },
    };
    expect(
      renderText(
        renderMcpToolResult(partial, { expanded: false, isPartial: true }, plainTheme, false),
      ),
    ).toContain('Running…  ·  {"progress":42}');

    const full = renderText(renderMcpToolResult(success, expanded, plainTheme, false));
    expect(full).toContain("Content: 2 text blocks · 1 image");
    expect(full).toContain("Stored content: audio · audio/mpeg · /tmp/audio.bin");
    expect(full).toContain("Result Spill: /tmp/result-spill.txt");
    expect(full).toContain("first\nsecond");
  });

  test("redacts exact values and removes terminal controls without changing result bytes", () => {
    const unsafe =
      "visible secret-value\u001b[31m red\u001b[0m\u001b]0;title\u0007\u001b_payload\u001b\\\u0000\u0085\r\nnext\tvalue";
    const result: AgentToolResult<unknown> = {
      content: [{ type: "text", text: unsafe }],
      details: resultDetails(),
    };
    const before = structuredClone(result);
    const redact = (text: string): string => text.replaceAll("secret-value", "[REDACTED]");
    const rendered = renderText(renderMcpToolResult(result, expanded, plainTheme, false, redact));

    expect(rendered).toContain("visible [REDACTED] red\nnext   value");
    expect(rendered).not.toContain("secret-value");
    expect(result).toEqual(before);
    expect(sanitizeMcpPresentationText(unsafe)).toContain("next\tvalue");
  });

  test("falls back to useful bounded content for historical details and narrow widths", () => {
    const historical: AgentToolResult<unknown> = {
      content: [{ type: "text", text: "first useful line\nsecond line" }],
      details: { old: true },
    };
    expect(renderText(renderMcpToolResult(historical, collapsed, plainTheme, false))).toContain(
      "first useful line",
    );
    expect(renderText(renderMcpToolResult(historical, expanded, plainTheme, false))).toContain(
      "second line",
    );

    const lines = renderMcpServerToolCall(
      "server-with-a-very-long-name",
      "tool-with-a-very-long-name",
      { query: "x".repeat(200) },
      plainTheme,
      false,
    ).render(24);
    expect(lines).toHaveLength(1);
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);

    const cancelled: AgentToolResult<unknown> = {
      content: [{ type: "text", text: "operation aborted by user" }],
      details: undefined,
    };
    expect(renderText(renderMcpToolResult(cancelled, collapsed, plainTheme, true))).toContain(
      "■ cancelled",
    );
  });

  test("keeps the tool card background behind a truncation ellipsis", () => {
    const ansiTheme = {
      bg: (_color: string, text: string) => `\u001b[48;5;22m${text}\u001b[49m`,
      bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
      fg: (_color: string, text: string) => `\u001b[31m${text}\u001b[39m`,
    } satisfies McpRenderTheme;
    const box = new Box(1, 1, (text) => ansiTheme.bg("toolSuccessBg", text));
    box.addChild(
      renderMcpServerToolCall(
        "server-with-a-very-long-name",
        "tool-with-a-very-long-name",
        {},
        ansiTheme,
        false,
      ),
    );

    const ellipsisLine = box.render(24).find((line) => line.includes("…"));
    expect(ellipsisLine).toBeDefined();
    expect(ellipsisLine).not.toContain("\u001b[0m…");

    const previewBox = new Box(1, 1, (text) => ansiTheme.bg("toolSuccessBg", text));
    previewBox.addChild(
      renderMcpServerToolCall("server", "tool", { query: "x".repeat(200) }, ansiTheme, false),
    );
    const previewLine = previewBox.render(120).find((line) => line.includes("…"));
    expect(previewLine).toBeDefined();
    expect(previewLine).not.toContain("\u001b[0m…");
  });

  test("keeps expanded result text within Pi display bounds", () => {
    const details = resultDetails();
    details.result = {
      spillPath: `/${"🧪".repeat(2_000)}`,
      storedContent: Array.from({ length: 20 }, () => ({ path: `/${"🧪".repeat(500)}` })),
    };
    const oversized: AgentToolResult<unknown> = {
      content: [{ type: "text", text: `${"x".repeat(80)}\n`.repeat(DEFAULT_MAX_LINES + 100) }],
      details,
    };
    const rendered = renderText(renderMcpToolResult(oversized, expanded, plainTheme, false), 1_000);

    expect(rendered.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(rendered).toContain("omitted");
  });
});

describe("MCP custom-message presentation", () => {
  const promptDetails = {
    mcpMessages: [{ role: "user", content: { type: "text", text: "original" } }],
    replayMessages: [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "Review secret-value" }] },
      {
        role: "assistant",
        timestamp: 1,
        content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      },
    ],
    version: 1,
  } as const;

  test("parses version-1 Prompt replay details without enriching persisted values", () => {
    expect(parseMcpPromptReplayMessages(promptDetails)).toEqual(promptDetails.replayMessages);
    expect(parseMcpPromptReplayMessages({ ...promptDetails, version: 2 })).toBeUndefined();
    expect(
      parseMcpPromptReplayMessages({ version: 1, replayMessages: [{ role: "tool" }] }),
    ).toBeUndefined();
    expect(parseMcpResultDetails(resultDetails())?.mcp.owner).toBe("pi-mcp");
    expect(parseMcpResultDetails({ mcp: { isError: false, owner: "other" } })).toBeUndefined();
  });

  test("renders Prompt roles, text, and image metadata with safe fallback", () => {
    const redact = (text: string): string => text.replaceAll("secret-value", "[REDACTED]");
    const message = {
      content: "MCP Prompt docs/review",
      details: promptDetails,
    };
    const collapsedPrompt = renderText(
      renderMcpPromptMessage(message, { expanded: false, outputPad: 1 }, plainTheme, redact),
    );
    expect(collapsedPrompt).toContain("MCP Prompt  docs / review");
    expect(collapsedPrompt).toContain("2 messages");
    expect(collapsedPrompt).toContain("user, assistant");

    const full = renderText(renderMcpPromptMessage(message, messageExpanded, plainTheme, redact));
    expect(full).toContain("User");
    expect(full).toContain("Review [REDACTED]");
    expect(full).toContain("Assistant image: image/png");
    expect(full).not.toContain("aW1hZ2U=");

    const fallback = renderText(
      renderMcpPromptMessage(
        { content: "historical prompt content", details: { version: 0 } },
        messageExpanded,
        plainTheme,
      ),
    );
    expect(fallback).toContain("historical prompt content");
  });

  test("renders Resource Update provenance and preserves the explicit-read boundary", () => {
    const message = {
      content:
        "MCP Resource updated on docs: file:///guide. Read it explicitly before using the new content.",
      details: undefined,
    };
    expect(
      renderText(
        renderMcpResourceUpdateMessage(message, { expanded: false, outputPad: 1 }, plainTheme),
      ),
    ).toContain("MCP Resource Update  docs  file:///guide");
    expect(
      renderText(renderMcpResourceUpdateMessage(message, messageExpanded, plainTheme)),
    ).toContain("remains unread until the agent explicitly reads it");
  });
});
