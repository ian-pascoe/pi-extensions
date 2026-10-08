import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  escapeTaggedTheme as taggedTheme,
  expectLinesFitWidth,
  readableTags,
} from "@ian-pascoe/pi-utils/ui-testing";
import { beforeAll, describe, expect, test } from "vitest";
import {
  renderWebFetchToolCall,
  renderWebFetchToolResult,
  renderWebSearchToolCall,
  renderWebSearchToolResult,
} from "../src/web-tool-rendering.js";

beforeAll(() => {
  initTheme("dark");
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
});

function context(overrides: { expanded?: boolean; durationMs?: number | undefined } = {}) {
  return {
    state: {},
    executionStarted: true,
    isPartial: false,
    durationMs: "durationMs" in overrides ? overrides.durationMs : 1_200,
    invalidate: () => undefined,
    expanded: overrides.expanded ?? false,
  };
}

const collapsed = { expanded: false, isPartial: false };
const expanded = { expanded: true, isPartial: false };

type Renderable = { render(width: number): string[] };

function rawLines(component: Renderable, width: number): string[] {
  return component.render(width).map((line) => line.trimEnd());
}

/** Rendered lines with theme tokens decoded to `<token>...</token>`. */
function lines(component: Renderable, width = 120): string[] {
  return rawLines(component, width).map(readableTags);
}

function fitsAt(component: Renderable, options?: { piThemedBody?: boolean }): void {
  for (const width of [40, 120]) expectLinesFitWidth(rawLines(component, width), width, options);
}

const numbered = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

describe("web_search rendering", () => {
  const details = { provider: "exa" as const };

  test("call row is a lowercase tool header with the query as target", () => {
    const row = renderWebSearchToolCall({ query: "Pi\u001b[31m tools" }, taggedTheme, context());
    expect(lines(row)[0]).toBe(
      '<toolTitle><b>web_search</b></toolTitle> <accent>"Pi tools"</accent>',
    );
    fitsAt(row);
  });

  test("expanded call lists the options one per line", () => {
    const row = renderWebSearchToolCall(
      { query: "q", numResults: 3, contextMaxCharacters: 1_200 },
      taggedTheme,
      context({ expanded: true }),
    );
    expect(lines(row)).toContain("<muted>numResults: 3</muted>");
    expect(lines(row)).toContain("<muted>contextMaxCharacters: 1200</muted>");
    fitsAt(row);
  });

  test("collapsed result shows provenance and the first 15 lines with Pi's hint", () => {
    const result = { content: [{ type: "text" as const, text: numbered(20) }], details };
    const row = renderWebSearchToolResult(
      result,
      collapsed,
      taggedTheme,
      context(),
      false,
      details,
    );
    const out = lines(row);
    expect(out[0]).toBe("<muted>Exa</muted>");
    expect(out).toContain("<toolOutput>line 15</toolOutput>");
    expect(out).not.toContain("<toolOutput>line 16</toolOutput>");
    expect(out).toContain(
      "<muted>... (5 more lines,</muted> <dim>ctrl+o</dim><muted> to expand</muted><muted>)</muted>",
    );
    expect(out.slice(-2)).toEqual(["", "<muted>Took 1.2s</muted>"]);
    expect(out.join("\n")).not.toContain("✓");
    fitsAt(row);
  });

  test("marks truncation in warning text and lists it when expanded", () => {
    const truncated = {
      provider: "parallel" as const,
      truncation: {
        outputLines: 100,
        totalLines: 200,
        outputBytes: 1_000,
        totalBytes: 2_000,
        fullOutputPath: "/tmp/pi-web-tools/output.txt",
      },
    };
    const result = {
      content: [{ type: "text" as const, text: "visible result" }],
      details: truncated,
    };
    const short = lines(
      renderWebSearchToolResult(result, collapsed, taggedTheme, context(), false, truncated),
    );
    expect(short[0]).toBe("<muted>Parallel</muted><dim> · </dim><warning>truncated</warning>");
    const full = renderWebSearchToolResult(
      result,
      expanded,
      taggedTheme,
      context({ expanded: true }),
      false,
      truncated,
    );
    const out = lines(full).join("\n");
    expect(out).toContain("visible: 100 of 200 lines · 1000 of 2000 bytes");
    expect(out).toContain("complete output: /tmp/pi-web-tools/output.txt");
    expect(out).not.toContain("ctrl+o");
  });

  test("expanded result shows every line of the Markdown output", () => {
    const result = {
      content: [{ type: "text" as const, text: "# Heading\n\nUseful\u001b[31m content" }],
      details,
    };
    const row = renderWebSearchToolResult(result, expanded, taggedTheme, context(), false, details);
    fitsAt(row, { piThemedBody: true });
    const text = stripTerminalSequences(rawLines(row, 120).join("\n"));
    expect(text).toContain("Useful content");
  });

  test("partial result shows only the live Elapsed footer", () => {
    const row = renderWebSearchToolResult(
      { content: [], details },
      { expanded: false, isPartial: true },
      taggedTheme,
      context({ durationMs: undefined }),
      false,
      details,
    );
    const out = lines(row).join("\n");
    expect(out).not.toContain("Searching");
    expect(out).not.toContain("…");
    fitsAt(row);
  });

  test("error shows the first 10 lines in error text with the hint", () => {
    const result = { content: [{ type: "text" as const, text: numbered(14) }], details: undefined };
    const row = renderWebSearchToolResult(
      result,
      collapsed,
      taggedTheme,
      context(),
      true,
      undefined,
    );
    const out = lines(row);
    expect(out[0]).toBe("<error>line 1</error>");
    expect(out).toContain("<error>line 10</error>");
    expect(out).not.toContain("<error>line 11</error>");
    expect(out).toContain(
      "<muted>... (4 more lines,</muted> <dim>ctrl+o</dim><muted> to expand</muted><muted>)</muted>",
    );
    fitsAt(row);
  });
});

describe("web_fetch rendering", () => {
  const fetchDetails = {
    url: "https://user:password@example.com/final",
    contentType: "text/html; charset=utf-8",
    format: "markdown" as const,
  };

  test("call row hides credentials and truncates with three dots", () => {
    const row = renderWebFetchToolCall(
      { url: `https://user:password@example.com/${"a".repeat(120)}` },
      taggedTheme,
      context(),
    );
    const first = lines(row, 120)[0] ?? "";
    expect(first.startsWith("<toolTitle><b>web_fetch</b></toolTitle> <accent>example.com/")).toBe(
      true,
    );
    expect(first).toContain("...</accent>");
    expect(first).not.toContain("password");
    expect(first).not.toContain("…");
    fitsAt(row);
  });

  test("expanded call lists redacted arguments one per line", () => {
    const row = renderWebFetchToolCall(
      {
        url: "https://user:password@example.com/p",
        format: "html",
        timeout: 12,
        offset: 40,
        limit: 20,
      },
      taggedTheme,
      context({ expanded: true }),
    );
    const out = lines(row);
    expect(out).toContain("<muted>url: https://example.com/p</muted>");
    expect(out).toContain("<muted>format: html</muted>");
    expect(out).toContain("<muted>timeout: 12s</muted>");
    expect(out).toContain("<muted>offset: 40</muted>");
    expect(out).toContain("<muted>limit: 20</muted>");
    expect(out.join("\n")).not.toContain("password");
    fitsAt(row);
  });

  test("collapsed success is a header-only summary with no body", () => {
    const result = {
      content: [{ type: "text" as const, text: "# Fetched page\n\nBody" }],
      details: fetchDetails,
    };
    const row = renderWebFetchToolResult(
      result,
      collapsed,
      taggedTheme,
      context(),
      false,
      fetchDetails,
    );
    const out = lines(row);
    expect(out[0]).toBe(
      "<muted>markdown</muted><dim> · </dim><muted>text/html; charset=utf-8</muted><dim> (ctrl+o to expand)</dim>",
    );
    expect(out.join("\n")).not.toContain("Fetched page");
    expect(out.join("\n")).not.toContain("✓");
    expect(out.at(-1)).toBe("<muted>Took 1.2s</muted>");
    fitsAt(row);
  });

  test("expanded markdown shows the content without a redundant hint or credentials", () => {
    const result = {
      content: [{ type: "text" as const, text: "# Fetched page\n\nBody" }],
      details: fetchDetails,
    };
    const row = renderWebFetchToolResult(
      result,
      expanded,
      taggedTheme,
      context({ expanded: true }),
      false,
      fetchDetails,
    );
    const out = lines(row).join("\n");
    expect(out).toContain("<muted>url: https://example.com/final</muted>");
    expect(out).toContain("Fetched page");
    expect(out).not.toContain("password");
    expect(out).not.toContain("ctrl+o");
  });

  test("expanded text and html formats keep literal syntax", () => {
    for (const format of ["text", "html"] as const) {
      const details = { url: "https://example.com", contentType: "text/plain", format };
      const result = {
        content: [{ type: "text" as const, text: "# Literal\n\n<strong>text</strong>" }],
        details,
      };
      const row = renderWebFetchToolResult(
        result,
        expanded,
        taggedTheme,
        context(),
        false,
        details,
      );
      const out = lines(row);
      expect(out).toContain("<toolOutput># Literal</toolOutput>");
      expect(out.join("\n")).toContain("<strong>text</strong>");
    }
  });

  test("warns when the fetch was truncated", () => {
    const details = {
      ...fetchDetails,
      contentType: "",
      truncation: {
        outputLines: 1,
        totalLines: 2,
        outputBytes: 1,
        totalBytes: 2,
        fullOutputPath: "/tmp/x",
      },
    };
    const result = { content: [{ type: "text" as const, text: "x" }], details };
    const out = lines(
      renderWebFetchToolResult(result, collapsed, taggedTheme, context(), false, details),
    );
    expect(out[0]).toContain("<muted>markdown</muted><dim> · </dim><warning>truncated</warning>");
  });

  test("partial shows no placeholder text", () => {
    const row = renderWebFetchToolResult(
      { content: [], details: undefined },
      { expanded: false, isPartial: true },
      taggedTheme,
      context({ durationMs: undefined }),
      false,
      undefined,
    );
    expect(lines(row).join("\n")).not.toContain("Fetching");
    fitsAt(row);
  });

  test("historical failure shows sanitized first lines in error text and all when expanded", () => {
    const failure = {
      content: [
        {
          type: "text" as const,
          text: "Unable to fetch requested URL\ninternal\u001b[31m details",
        },
      ],
      details: { old: "shape" },
    };
    const short = renderWebFetchToolResult(
      failure,
      collapsed,
      taggedTheme,
      context(),
      true,
      undefined,
    );
    expect(lines(short).slice(0, 2)).toEqual([
      "<error>Unable to fetch requested URL</error>",
      "<error>internal details</error>",
    ]);
    fitsAt(short);
    const long = renderWebFetchToolResult(
      failure,
      expanded,
      taggedTheme,
      context(),
      true,
      undefined,
    );
    expect(lines(long).join("\n")).toContain("internal details");
    expect(lines(long).join("\n")).not.toContain("ctrl+o");
  });
});
