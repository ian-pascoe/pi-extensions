import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { McpSelectorHarness, mcpTool } from "./mcp-selector-harness.js";

type SuggestionOptions = Parameters<AutocompleteProvider["getSuggestions"]>[3];

const GITHUB: AutocompleteItem = {
  value: "&github",
  label: "&github",
  description: "MCP server · Search code and issues",
};
const RADIUS: AutocompleteItem = {
  value: "&dev-radius",
  label: "&dev-radius",
  description: "MCP server · Query the radius.",
};

const options = (): SuggestionOptions => ({ signal: new AbortController().signal });

/** A stand-in for Pi's native provider. */
class NativeProvider implements AutocompleteProvider {
  triggerCharacters = ["#"];
  calls: Parameters<AutocompleteProvider["getSuggestions"]>[] = [];
  applied: Parameters<AutocompleteProvider["applyCompletion"]>[] = [];
  suggestions: AutocompleteSuggestions | null = null;
  appliedResult = { lines: ["native"], cursorLine: 0, cursorCol: 6 };
  triggersFiles = false;

  async getSuggestions(...args: Parameters<AutocompleteProvider["getSuggestions"]>) {
    this.calls.push(args);
    return this.suggestions;
  }

  applyCompletion(...args: Parameters<AutocompleteProvider["applyCompletion"]>) {
    this.applied.push(args);
    return this.appliedResult;
  }

  shouldTriggerFileCompletion() {
    return this.triggersFiles;
  }
}

async function setup(native = new NativeProvider(), tools?: ToolInfo[]) {
  const harness = new McpSelectorHarness();
  if (tools) harness.tools = tools;
  return { harness, native, provider: await harness.provider(native) };
}

describe("Pi MCP Selector autocomplete", () => {
  test.each(["rpc", "print", "json"] as const)(
    "does not register terminal autocomplete in %s mode",
    async (mode) => {
      const harness = new McpSelectorHarness();
      await harness.emit({ type: "session_start", reason: "startup" }, mode);
      expect(harness.factories).toEqual([]);
    },
  );

  test("bare & lists every server by name without asking native", async () => {
    const { provider, native } = await setup();
    expect(await provider.getSuggestions(["Use &"], 0, 5, options())).toEqual({
      prefix: "&",
      items: [RADIUS, GITHUB],
    });
    expect(native.calls).toEqual([]);
  });

  test("a query lists servers whose name contains it, case-insensitively, prefix matches first", async () => {
    const { provider } = await setup(new NativeProvider(), [
      mcpTool({ name: "my-git" }),
      mcpTool({ name: "github", description: "Search code and issues" }),
      mcpTool({ name: "other" }),
    ]);
    const result = await provider.getSuggestions(["&GIT"], 0, 4, options());
    expect(result?.prefix).toBe("&GIT");
    expect(result?.items.map((item) => item.label)).toEqual(["&github", "&my-git"]);
  });

  test("describes servers by description, first instruction line, or plainly", async () => {
    const { provider } = await setup(new NativeProvider(), [
      mcpTool({ name: "a", description: "Does a" }),
      mcpTool({ name: "b", instructions: "\n First line\nSecond" }),
      mcpTool({ name: "c" }),
    ]);
    expect(
      (await provider.getSuggestions(["Use &"], 0, 5, options()))?.items.map(
        (item) => item.description,
      ),
    ).toEqual(["MCP server · Does a", "MCP server · First line", "MCP server"]);
  });

  test("a lone & at the start of a line opens the popup with every server", async () => {
    const { provider, native } = await setup();
    expect(await provider.getSuggestions(["&"], 0, 1, options())).toEqual({
      prefix: "&",
      items: [RADIUS, GITHUB],
    });
    expect((await provider.getSuggestions(["&g"], 0, 2, options()))?.items).toEqual([GITHUB]);
    expect((await provider.getSuggestions(["Use &g"], 0, 6, options()))?.items).toEqual([GITHUB]);
    expect(native.calls).toEqual([]);
  });

  test("offers nothing when no server matches or the Catalogue is empty", async () => {
    const { provider } = await setup();
    expect(await provider.getSuggestions(["&zzz"], 0, 4, options())).toBeNull();
    const empty = await setup(new NativeProvider(), []);
    expect(await empty.provider.getSuggestions(["Use &"], 0, 5, options())).toBeNull();
  });

  test("leaves @ file completion and non-prose positions to native", async () => {
    const native = new NativeProvider();
    native.suggestions = { prefix: "@gi", items: [{ value: "@github", label: "github" }] };
    const { provider } = await setup(native);
    expect(await provider.getSuggestions(["@gi"], 0, 3, options())).toBe(native.suggestions);
    expect(await provider.getSuggestions(["R&D"], 0, 3, options())).toBe(native.suggestions);
    expect(await provider.getSuggestions(["a && b"], 0, 6, options())).toBe(native.suggestions);
    expect(await provider.getSuggestions(["+gi"], 0, 3, options())).toBe(native.suggestions);
    expect(native.calls).toHaveLength(4);
  });

  test("selecting a server inserts one reference and keeps the rest of the editor", async () => {
    const { provider, native } = await setup();
    const lines = ["First &github", "Use &gith, then inspect.", "Last"];
    const suggestions = await provider.getSuggestions(lines, 1, 9, options());
    const item = suggestions?.items[0];
    if (!item || !suggestions) throw new Error("Missing server suggestion");
    expect(provider.applyCompletion(lines, 1, 9, item, suggestions.prefix)).toEqual({
      lines: ["First &github", "Use &github , then inspect.", "Last"],
      cursorLine: 1,
      cursorCol: 12,
    });
    expect(lines[1]).toBe("Use &gith, then inspect.");
    expect(native.applied).toEqual([]);
  });

  test("hands items it does not own to native", async () => {
    const { provider, native } = await setup();
    const file = { value: "@src/", label: "src/" };
    expect(provider.applyCompletion(["@sr"], 0, 3, file, "@sr")).toBe(native.appliedResult);
    expect(native.applied).toHaveLength(1);
  });

  test("preserves native trigger characters and file-trigger decisions, and adds &", async () => {
    const native = new NativeProvider();
    native.suggestions = { prefix: "/he", items: [{ value: "help", label: "help" }] };
    const { provider } = await setup(native);
    expect(provider.triggerCharacters).toEqual(["#", "&"]);
    expect(await provider.getSuggestions(["/he"], 0, 3, options())).toBe(native.suggestions);
    expect(provider.shouldTriggerFileCompletion?.(["x"], 0, 1)).toBe(false);
    native.triggersFiles = true;
    expect(provider.shouldTriggerFileCompletion?.(["x"], 0, 1)).toBe(true);
  });

  test("reads the Catalogue fresh for each popup", async () => {
    const { provider, harness } = await setup();
    harness.tools = [mcpTool({ name: "fresh" })];
    expect(
      (await provider.getSuggestions(["Use &"], 0, 5, options()))?.items.map((item) => item.label),
    ).toEqual(["&fresh"]);
    harness.tools = [mcpTool({ name: "fresh", exposure: "hidden" })];
    expect(await provider.getSuggestions(["Use &"], 0, 5, options())).toBeNull();
  });

  test("works over Pi's real combined provider for slash commands and server items", async () => {
    const harness = new McpSelectorHarness();
    const provider = await harness.provider();
    expect(await provider.getSuggestions(["/he"], 0, 3, options())).toEqual({
      prefix: "/he",
      items: [{ value: "help", label: "help", description: "Native help" }],
    });
    expect(await provider.getSuggestions(["&dev_r"], 0, 6, options())).toEqual({
      prefix: "&dev_r",
      items: [RADIUS],
    });
  });
});
