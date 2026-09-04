import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import {
  renderWebFetchToolCall,
  renderWebFetchToolResult,
  renderWebSearchToolCall,
  renderWebSearchToolResult,
  type WebToolRenderTheme,
} from "../src/web-tool-rendering.js";

const plainTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} satisfies WebToolRenderTheme;

beforeAll(() => initTheme("dark"));

function renderLines(component: { render(width: number): string[] }): string {
  return stripTerminalSequences(
    component
      .render(120)
      .map((line) => line.trimEnd())
      .join("\n"),
  );
}

describe("Pi Web Tools transcript rendering", () => {
  test("renders compact sanitized calls and explicit options on expansion", () => {
    const search = {
      query: "Pi\u001b[31m tools",
      numResults: 3,
      livecrawl: "preferred" as const,
      type: "deep" as const,
      contextMaxCharacters: 1_200,
    };
    expect(renderLines(renderWebSearchToolCall(search, plainTheme, false))).toBe(
      'Web  Search  "Pi tools"',
    );
    const expandedSearch = renderLines(renderWebSearchToolCall(search, plainTheme, true));
    expect(expandedSearch).toContain("Results: 3");
    expect(expandedSearch).toContain("Search type: deep");
    expect(expandedSearch).toContain("Live crawl: preferred");
    expect(expandedSearch).toContain("Context: 1200 characters");

    const fetch = {
      url: "https://user:password@example.com/path?q=1",
      format: "html" as const,
      timeout: 12,
    };
    expect(renderLines(renderWebFetchToolCall(fetch, plainTheme, false))).toBe(
      "Web  Fetch  example.com/path?q=1",
    );
    const expandedFetch = renderLines(renderWebFetchToolCall(fetch, plainTheme, true));
    expect(expandedFetch).toContain("URL: https://example.com/path?q=1");
    expect(expandedFetch).toContain("Format: html");
    expect(expandedFetch).toContain("Timeout: 12s");
    expect(expandedFetch).not.toContain("user");
    expect(expandedFetch).not.toContain("password");
  });

  test("collapses successful results to provenance and expands sanitized content", () => {
    const searchResult = {
      content: [{ type: "text" as const, text: "# Search result\n\nUseful\u001b[31m content" }],
      details: { provider: "exa" as const },
    };
    const collapsedSearch = renderLines(
      renderWebSearchToolResult(
        searchResult,
        { expanded: false, isPartial: false },
        plainTheme,
        false,
        searchResult.details,
      ),
    );
    expect(collapsedSearch).toContain("✓ completed  ·  Exa");
    expect(collapsedSearch).not.toContain("Useful content");
    const expandedSearch = renderLines(
      renderWebSearchToolResult(
        searchResult,
        { expanded: true, isPartial: false },
        plainTheme,
        false,
        searchResult.details,
      ),
    );
    expect(expandedSearch).toContain("Provider: Exa");
    expect(expandedSearch).toContain("Search result");
    expect(expandedSearch).toContain("Useful content");

    const fetchResult = {
      content: [{ type: "text" as const, text: "# Fetched page\n\nBody" }],
      details: {
        url: "https://user:password@example.com/final",
        contentType: "text/html; charset=utf-8",
        format: "markdown" as const,
      },
    };
    const collapsedFetch = renderLines(
      renderWebFetchToolResult(
        fetchResult,
        { expanded: false, isPartial: false },
        plainTheme,
        false,
        fetchResult.details,
      ),
    );
    expect(collapsedFetch).toContain("✓ fetched  ·  markdown  ·  text/html; charset=utf-8");
    expect(collapsedFetch).not.toContain("Fetched page");
    const expandedFetch = renderLines(
      renderWebFetchToolResult(
        fetchResult,
        { expanded: true, isPartial: false },
        plainTheme,
        false,
        fetchResult.details,
      ),
    );
    expect(expandedFetch).toContain("URL: https://example.com/final");
    expect(expandedFetch).toContain("Format: markdown");
    expect(expandedFetch).toContain("Content type: text/html; charset=utf-8");
    expect(expandedFetch).toContain("Fetched page");
    expect(expandedFetch).not.toContain("user");
    expect(expandedFetch).not.toContain("password");
  });

  test("preserves literal text and HTML syntax in expanded Fetch results", () => {
    for (const format of ["text", "html"] as const) {
      const result = {
        content: [{ type: "text" as const, text: "# Literal\n\n<strong>text</strong>" }],
        details: { url: "https://example.com", contentType: "text/plain", format },
      };
      const expanded = renderLines(
        renderWebFetchToolResult(
          result,
          { expanded: true, isPartial: false },
          plainTheme,
          false,
          result.details,
        ),
      );
      expect(expanded).toContain("# Literal");
      expect(expanded).toContain("<strong>text</strong>");
    }
  });

  test("surfaces partial, truncation, and safe historical failure states", () => {
    expect(
      renderLines(
        renderWebSearchToolResult(
          { content: [], details: undefined },
          { expanded: false, isPartial: true },
          plainTheme,
          false,
          undefined,
        ),
      ),
    ).toBe("Searching…");
    expect(
      renderLines(
        renderWebFetchToolResult(
          { content: [], details: undefined },
          { expanded: false, isPartial: true },
          plainTheme,
          false,
          undefined,
        ),
      ),
    ).toBe("Fetching…");

    const truncated = {
      content: [{ type: "text" as const, text: "visible result" }],
      details: {
        provider: "parallel" as const,
        truncation: {
          outputLines: 100,
          totalLines: 200,
          outputBytes: 1_000,
          totalBytes: 2_000,
          fullOutputPath: "/tmp/pi-web-tools/output.txt",
        },
      },
    };
    const collapsed = renderLines(
      renderWebSearchToolResult(
        truncated,
        { expanded: false, isPartial: false },
        plainTheme,
        false,
        truncated.details,
      ),
    );
    expect(collapsed).toContain("Parallel");
    expect(collapsed).toContain("truncated");
    const expanded = renderLines(
      renderWebSearchToolResult(
        truncated,
        { expanded: true, isPartial: false },
        plainTheme,
        false,
        truncated.details,
      ),
    );
    expect(expanded).toContain("Visible: 100 of 200 lines · 1000 of 2000 bytes");
    expect(expanded).toContain("Complete output: /tmp/pi-web-tools/output.txt");

    const historicalFailure = {
      content: [
        {
          type: "text" as const,
          text: "Unable to fetch requested URL\ninternal\u001b[31m details",
        },
      ],
      details: { old: "shape" },
    };
    const collapsedFailure = renderLines(
      renderWebFetchToolResult(
        historicalFailure,
        { expanded: false, isPartial: false },
        plainTheme,
        true,
        undefined,
      ),
    );
    expect(collapsedFailure).toContain("Unable to fetch requested URL");
    expect(collapsedFailure).not.toContain("internal details");
    expect(
      renderLines(
        renderWebFetchToolResult(
          historicalFailure,
          { expanded: true, isPartial: false },
          plainTheme,
          true,
          undefined,
        ),
      ),
    ).toContain("internal details");
  });
});
