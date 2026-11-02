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
  value: "@github",
  label: "@github",
  description: "MCP server · Search code and issues",
};
const RADIUS: AutocompleteItem = {
  value: "@dev-radius",
  label: "@dev-radius",
  description: "MCP server · Query the radius.",
};

const options = (): SuggestionOptions => ({ signal: new AbortController().signal });

/** A stand-in for Pi's native provider, which lists files for an `@` prefix. */
class NativeProvider implements AutocompleteProvider {
  triggerCharacters = ["#"];
  calls: Parameters<AutocompleteProvider["getSuggestions"]>[] = [];
  applied: Parameters<AutocompleteProvider["applyCompletion"]>[] = [];
  suggestions: AutocompleteSuggestions | null = null;
  failure: Error | undefined;
  appliedResult = { lines: ["native"], cursorLine: 0, cursorCol: 6 };
  triggersFiles = false;

  async getSuggestions(...args: Parameters<AutocompleteProvider["getSuggestions"]>) {
    this.calls.push(args);
    if (this.failure) throw this.failure;
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

function files(prefix: string, ...names: string[]): AutocompleteSuggestions {
  return {
    prefix,
    items: names.map((name) => ({ value: `@${name}`, label: name })),
  };
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

  test("bare @ lists every server by name, then the native file results", async () => {
    const native = new NativeProvider();
    native.suggestions = files("@", "README.md", "src/");
    const { provider } = await setup(native);
    const signal = new AbortController().signal;
    expect(await provider.getSuggestions(["Use @"], 0, 5, { signal, force: true })).toEqual({
      prefix: "@",
      items: [RADIUS, GITHUB, ...native.suggestions.items],
    });
    // The native provider answers the same request.
    expect(native.calls).toEqual([[["Use @"], 0, 5, { signal, force: true }]]);
    expect(native.calls[0]?.[3].signal).toBe(signal);
  });

  test("a query lists servers whose name contains it, prefix matches first, then native files", async () => {
    const native = new NativeProvider();
    native.suggestions = files("@GIT", "gitignore", ".github/");
    const { provider } = await setup(native, [
      mcpTool({ name: "github", description: "Search code and issues" }),
      mcpTool({ name: "my-git" }),
      mcpTool({ name: "other" }),
    ]);
    const result = await provider.getSuggestions(["@GIT"], 0, 4, options());
    expect(result?.prefix).toBe("@GIT");
    expect(result?.items.map((item) => item.label)).toEqual([
      "@github",
      "@my-git",
      "gitignore",
      ".github/",
    ]);
  });

  test("describes servers by description, first instruction line, or plainly", async () => {
    const { provider } = await setup(new NativeProvider(), [
      mcpTool({ name: "a", description: "Does a" }),
      mcpTool({ name: "b", instructions: "\n First line\nSecond" }),
      mcpTool({ name: "c" }),
    ]);
    expect(
      (await provider.getSuggestions(["@"], 0, 1, options()))?.items.map(
        (item) => item.description,
      ),
    ).toEqual(["MCP server · Does a", "MCP server · First line", "MCP server"]);
  });

  test("offers servers alone when native has nothing, fails, or is empty", async () => {
    const native = new NativeProvider();
    const { provider } = await setup(native);
    const expected = { prefix: "@gith", items: [GITHUB] };
    expect(await provider.getSuggestions(["@gith"], 0, 5, options())).toEqual(expected);
    native.suggestions = { prefix: "@gith", items: [] };
    expect(await provider.getSuggestions(["@gith"], 0, 5, options())).toEqual(expected);
    native.suggestions = null;
    native.failure = new Error("fd crashed");
    expect(await provider.getSuggestions(["@gith"], 0, 5, options())).toEqual(expected);
  });

  test("returns native's answer unchanged when it used a different prefix", async () => {
    const native = new NativeProvider();
    native.suggestions = files("@./gith", "github.md");
    const { provider } = await setup(native);
    expect(await provider.getSuggestions(["@gith"], 0, 5, options())).toBe(native.suggestions);
  });

  test("returns null when the request is cancelled while native works", async () => {
    const controller = new AbortController();
    const native = new NativeProvider();
    native.suggestions = files("@gith", "x");
    const getSuggestions = native.getSuggestions.bind(native);
    native.getSuggestions = async (...args) => {
      const result = await getSuggestions(...args);
      controller.abort();
      return result;
    };
    const { provider } = await setup(native);
    expect(
      await provider.getSuggestions(["@gith"], 0, 5, { signal: controller.signal }),
    ).toBeNull();
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await provider.getSuggestions(["@gith"], 0, 5, { signal: cancelled.signal })).toBeNull();
  });

  test("delegates completely when the @ is not a server prefix in prose, or no server is reachable", async () => {
    const native = new NativeProvider();
    native.suggestions = files("@zz", "zzz.ts");
    const { provider } = await setup(native);
    for (const [lines, col] of [
      [["@zz"], 3],
      [["`@gith`"], 6],
      [['@"git'], 5],
      [["@src/gi"], 7],
      [["name@gith"], 9],
      [["@@gith"], 6],
      [["[a](@gith)"], 9],
    ] as const) {
      native.calls.length = 0;
      expect(await provider.getSuggestions([...lines], 0, col, options())).toBe(native.suggestions);
      expect(native.calls).toHaveLength(1);
    }
    // Nothing matches a server and no file collides, so native's answer passes through as is.
    native.calls.length = 0;
    expect(await provider.getSuggestions(["@zz"], 0, 3, options())).toBe(native.suggestions);
    // An empty Catalogue leaves even a colliding file untouched.
    native.suggestions = files("@github", "github");
    const empty = await setup(native, []);
    expect(await empty.provider.getSuggestions(["@github"], 0, 7, options())).toBe(
      native.suggestions,
    );
  });

  test("a fuzzy query that matches no server still inserts a server-named file as @./name", async () => {
    const native = new NativeProvider();
    native.suggestions = files("@ghb", "github", "ghb.md");
    const { provider } = await setup(native);
    const result = await provider.getSuggestions(["@ghb"], 0, 4, options());
    expect(result).toEqual({
      prefix: "@ghb",
      items: [
        { value: "@./github", label: "github" },
        { value: "@ghb.md", label: "ghb.md" },
      ],
    });
    // Native's own items are not modified.
    expect(native.suggestions.items[0]).toEqual({ value: "@github", label: "github" });
  });

  test("a native item named like a server is inserted as @./name, leaving native's item alone", async () => {
    const native = new NativeProvider();
    const plain = { value: "@github", label: "github" };
    const underscore = { value: "@dev_radius", label: "dev_radius" };
    const directory = { value: "@github/", label: "github/" };
    const other = { value: "@github.md", label: "github.md" };
    native.suggestions = { prefix: "@g", items: [plain, underscore, directory, other] };
    const { provider } = await setup(native);
    const result = await provider.getSuggestions(["@g"], 0, 2, options());
    expect(result?.items.slice(1)).toEqual([
      { value: "@./github", label: "github" },
      { value: "@./dev_radius", label: "dev_radius" },
      directory,
      other,
    ]);
    expect(plain).toEqual({ value: "@github", label: "github" });
    // A rewritten file item is native's: its application belongs to the provider below.
    const rewritten = result?.items[1];
    if (!rewritten) throw new Error("Missing rewritten item");
    expect(provider.applyCompletion(["@g"], 0, 2, rewritten, "@g")).toBe(native.appliedResult);
    expect(native.applied).toEqual([[["@g"], 0, 2, rewritten, "@g"]]);
  });

  test("selecting a server inserts one reference with native spacing and keeps the rest of the editor", async () => {
    const { provider, native } = await setup();
    const lines = ["First @github", "Use @gith, then inspect.", "Last"];
    const suggestions = await provider.getSuggestions(lines, 1, 9, options());
    const item = suggestions?.items[0];
    if (!item || !suggestions) throw new Error("Missing server suggestion");
    expect(provider.applyCompletion(lines, 1, 9, item, suggestions.prefix)).toEqual({
      lines: ["First @github", "Use @github , then inspect.", "Last"],
      cursorLine: 1,
      cursorCol: 12,
    });
    expect(lines[1]).toBe("Use @gith, then inspect.");
    expect(native.applied).toEqual([]);
  });

  test("routes by item identity: a lookalike from another provider goes to native", async () => {
    const { provider, native } = await setup();
    const lookalike = { ...GITHUB };
    expect(provider.applyCompletion(["@gith"], 0, 5, lookalike, "@gith")).toBe(
      native.appliedResult,
    );
    expect(native.applied).toHaveLength(1);
  });

  test("preserves native slash suggestions, trigger characters, and file-trigger decisions", async () => {
    const native = new NativeProvider();
    native.suggestions = { prefix: "/he", items: [{ value: "help", label: "help" }] };
    const { provider } = await setup(native);
    expect(provider.triggerCharacters).toEqual(["#", "@"]);
    expect(await provider.getSuggestions(["/he"], 0, 3, options())).toBe(native.suggestions);
    expect(provider.shouldTriggerFileCompletion?.(["x"], 0, 1)).toBe(false);
    native.triggersFiles = true;
    expect(provider.shouldTriggerFileCompletion?.(["x"], 0, 1)).toBe(true);
  });

  test("reads the Catalogue fresh for each popup", async () => {
    const { provider, harness } = await setup();
    harness.tools = [mcpTool({ name: "fresh" })];
    expect(
      (await provider.getSuggestions(["@"], 0, 1, options()))?.items.map((item) => item.label),
    ).toEqual(["@fresh"]);
    harness.tools = [mcpTool({ name: "fresh", exposure: "hidden" })];
    expect(await provider.getSuggestions(["@"], 0, 1, options())).toBeNull();
  });

  test("works over Pi's real combined provider for slash commands and applies server items", async () => {
    const harness = new McpSelectorHarness();
    const provider = await harness.provider();
    expect(await provider.getSuggestions(["/he"], 0, 3, options())).toEqual({
      prefix: "/he",
      items: [{ value: "help", label: "help", description: "Native help" }],
    });
    const suggestions = await provider.getSuggestions(["@dev_r"], 0, 6, options());
    expect(suggestions).toEqual({ prefix: "@dev_r", items: [RADIUS] });
  });
});
