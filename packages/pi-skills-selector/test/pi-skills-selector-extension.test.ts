import type {
  AutocompleteProviderFactory,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionStartEvent,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import skillsSelectorExtension from "../src/index.js";

type Handler = (
  event: InputEvent | SessionStartEvent,
  context: ExtensionContext,
) => InputEventResult | void | Promise<InputEventResult | void>;

function skillCommand(name: string, path = `/skills/${name}/SKILL.md`): SlashCommandInfo {
  return {
    name: `skill:${name}`,
    description: `Instructions for ${name}`,
    source: "skill",
    sourceInfo: { path, source: "local", scope: "user", origin: "top-level" },
  };
}

class SkillsSelectorHarness {
  commands = [skillCommand("code-review"), skillCommand("ponytail")];
  readonly factories: AutocompleteProviderFactory[] = [];
  private readonly handlers = new Map<string, Handler>();
  private bound = false;

  constructor() {
    const api = {
      on: (name: string, handler: Handler) => this.handlers.set(name, handler),
      getCommands: () => {
        if (!this.bound) throw new Error("Catalogue queried before runtime binding");
        return this.commands;
      },
    };
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: This boundary harness supplies every ExtensionAPI method used by the extension.
    skillsSelectorExtension(api as unknown as ExtensionAPI);
    this.bound = true;
  }

  async provider(
    current: AutocompleteProvider = new CombinedAutocompleteProvider(
      [{ name: "help", description: "Native help" }],
      "/tmp",
      null,
    ),
  ): Promise<AutocompleteProvider> {
    await this.emit({ type: "session_start", reason: "startup" });
    const factory = this.factories[0];
    if (!factory) throw new Error("Missing autocomplete provider");
    return factory(current);
  }

  async emit(event: InputEvent | SessionStartEvent, mode: ExtensionContext["mode"] = "tui") {
    const handler = this.handlers.get(event.type);
    if (!handler) throw new Error(`Missing ${event.type} handler`);
    const context = {
      mode,
      hasUI: mode === "tui" || mode === "rpc",
      ui: {
        addAutocompleteProvider: (factory: AutocompleteProviderFactory) => {
          this.factories.push(factory);
        },
      },
    };
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: This context provides the mode and autocomplete API read by the registered handlers.
    return handler(event, context as unknown as ExtensionContext);
  }
}

describe("Pi Skills Selector autocomplete", () => {
  test("completes and converts names Pi loads with naming warnings", async () => {
    const harness = new SkillsSelectorHarness();
    harness.commands = [skillCommand("style.guide")];
    const provider = await harness.provider();
    const suggestions = await provider.getSuggestions(["$style.g"], 0, 8, {
      signal: new AbortController().signal,
    });
    expect(suggestions).toEqual({
      prefix: "$style.g",
      items: [
        {
          value: "$style.guide",
          label: "$style.guide",
          description: "Instructions for style.guide",
        },
      ],
    });
    const item = suggestions?.items[0];
    if (!item || !suggestions) throw new Error("Missing catalogue suggestion");
    expect(provider.applyCompletion(["$style.g"], 0, 8, item, suggestions.prefix).lines).toEqual([
      "$style.guide ",
    ]);
    expect(
      await harness.emit({ type: "input", source: "interactive", text: "Use $style.guide." }),
    ).toEqual({
      action: "transform",
      text: "Use [$style.guide](/skills/style.guide/SKILL.md).",
    });
  });
  test("preserves native slash suggestions and completion", async () => {
    const provider = await new SkillsSelectorHarness().provider();
    const suggestions = await provider.getSuggestions(["/he"], 0, 3, {
      signal: new AbortController().signal,
    });
    expect(suggestions).toEqual({
      prefix: "/he",
      items: [{ value: "help", label: "help", description: "Native help" }],
    });
    const item = suggestions?.items[0];
    if (!item) throw new Error("Missing native suggestion");
    expect(provider.applyCompletion(["/he"], 0, 3, item, "/he")).toEqual({
      lines: ["/help "],
      cursorLine: 0,
      cursorCol: 6,
    });
  });

  test("uses the current Catalogue and re-registers after Pi clears providers for reload", async () => {
    const harness = new SkillsSelectorHarness();
    const provider = await harness.provider();
    harness.commands = [skillCommand("fresh", "/project/fresh/SKILL.md")];
    expect(
      await provider.getSuggestions(["$"], 0, 1, { signal: new AbortController().signal }),
    ).toEqual({
      prefix: "$",
      items: [{ value: "$fresh", label: "$fresh", description: "Instructions for fresh" }],
    });
    harness.factories.length = 0;
    await harness.emit({ type: "session_start", reason: "reload" });
    expect(harness.factories).toHaveLength(1);
    expect(
      await harness.emit({ type: "input", source: "interactive", text: "$fresh $code-review" }),
    ).toEqual({
      action: "transform",
      text: "[$fresh](/project/fresh/SKILL.md) $code-review",
    });
  });
  test("delegates literal-context completions even when another provider uses dollar-prefixed values", async () => {
    const options = { signal: new AbortController().signal, force: true };
    const item = { value: "$path", label: "$path" };
    const result = { lines: ["`$path`"], cursorLine: 0, cursorCol: 6 };
    const current: AutocompleteProvider = {
      triggerCharacters: ["#"],
      async getSuggestions(lines, cursorLine, cursorCol, receivedOptions) {
        expect([lines, cursorLine, cursorCol, receivedOptions]).toEqual([["`$p`"], 0, 3, options]);
        expect(receivedOptions.signal).toBe(options.signal);
        return { prefix: "$p", items: [item] };
      },
      applyCompletion: () => result,
      shouldTriggerFileCompletion: () => false,
    };
    const provider = await new SkillsSelectorHarness().provider(current);
    expect(provider.triggerCharacters).toEqual(["#", "$"]);
    expect(await provider.getSuggestions(["`$p`"], 0, 3, options)).toEqual({
      prefix: "$p",
      items: [item],
    });
    expect(provider.applyCompletion(["`$p`"], 0, 3, item, "$p")).toBe(result);
    expect(provider.shouldTriggerFileCompletion?.(["`$p`"], 0, 3)).toBe(false);
  });
  test("has no suggestions for unmatched or cancelled Skill queries", async () => {
    const provider = await new SkillsSelectorHarness().provider();
    expect(
      await provider.getSuggestions(["$zzzz"], 0, 5, { signal: new AbortController().signal }),
    ).toBeNull();
    const controller = new AbortController();
    controller.abort();
    expect(await provider.getSuggestions(["$"], 0, 1, { signal: controller.signal })).toBeNull();
  });
  test("selection inserts one shorthand with native spacing and preserves the rest of the editor", async () => {
    const harness = new SkillsSelectorHarness();
    const provider = await harness.provider();
    const lines = ["First $ponytail", "Use $crv, then inspect.", "Last line"];
    const suggestions = await provider.getSuggestions(lines, 1, 8, {
      signal: new AbortController().signal,
    });
    const item = suggestions?.items[0];
    if (!item || !suggestions) throw new Error("Missing Skill suggestion");
    expect(provider.applyCompletion(lines, 1, 8, item, suggestions.prefix)).toEqual({
      lines: ["First $ponytail", "Use $code-review , then inspect.", "Last line"],
      cursorLine: 1,
      cursorCol: 17,
    });
    expect(lines[1]).toBe("Use $crv, then inspect.");
  });
  test.each(["rpc", "print", "json"] as const)(
    "does not register terminal autocomplete in %s mode",
    async (mode) => {
      const harness = new SkillsSelectorHarness();
      await harness.emit({ type: "session_start", reason: "startup" }, mode);
      expect(harness.factories).toEqual([]);
    },
  );
  test("bare $ lists current Skill names and descriptions, with native fuzzy filtering", async () => {
    const harness = new SkillsSelectorHarness();
    const provider = await harness.provider();
    const options = { signal: new AbortController().signal };
    expect(await provider.getSuggestions(["Use $"], 0, 5, options)).toEqual({
      prefix: "$",
      items: [
        {
          value: "$code-review",
          label: "$code-review",
          description: "Instructions for code-review",
        },
        { value: "$ponytail", label: "$ponytail", description: "Instructions for ponytail" },
      ],
    });
    expect(await provider.getSuggestions(["Use $crv"], 0, 8, options)).toEqual({
      prefix: "$crv",
      items: [
        {
          value: "$code-review",
          label: "$code-review",
          description: "Instructions for code-review",
        },
      ],
    });
  });
});

describe("Pi Skills Selector input", () => {
  test("uses only Skill commands with usable absolute paths", async () => {
    const harness = new SkillsSelectorHarness();
    harness.commands = [
      skillCommand("valid"),
      skillCommand("relative", "relative/SKILL.md"),
      skillCommand("empty", ""),
      { ...skillCommand("extension"), source: "extension" },
      { ...skillCommand("prompt"), source: "prompt" },
      { ...skillCommand("other"), name: "other" },
    ];
    expect(
      await harness.emit({
        type: "input",
        source: "interactive",
        text: "$valid $relative $empty $extension $prompt $other",
      }),
    ).toEqual({
      action: "transform",
      text: "[$valid](/skills/valid/SKILL.md) $relative $empty $extension $prompt $other",
    });
    const provider = await harness.provider();
    expect(
      await provider.getSuggestions(["$"], 0, 1, { signal: new AbortController().signal }),
    ).toEqual({
      prefix: "$",
      items: [{ value: "$valid", label: "$valid", description: "Instructions for valid" }],
    });
  });
  test.each(["interactive", "rpc"] as const)(
    "preserves %s attachments and steering/follow-up delivery",
    async (source) => {
      const harness = new SkillsSelectorHarness();
      for (const streamingBehavior of ["steer", "followUp"] as const) {
        const event: InputEvent = {
          type: "input",
          source,
          text: "$ponytail",
          streamingBehavior,
          images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        };
        expect(await harness.emit(event, source === "rpc" ? "rpc" : "tui")).toEqual({
          action: "transform",
          text: "[$ponytail](/skills/ponytail/SKILL.md)",
          images: event.images,
        });
        expect(event.streamingBehavior).toBe(streamingBehavior);
        expect(event.text).toBe("$ponytail");
      }
    },
  );
  test("leaves extension-generated messages and unknown references unchanged", async () => {
    const harness = new SkillsSelectorHarness();
    expect(
      await harness.emit({ type: "input", source: "extension", text: "$code-review" }),
    ).toEqual({ action: "continue" });
    expect(
      await harness.emit({ type: "input", source: "interactive", text: "$unknown $HOME" }),
    ).toEqual({ action: "continue" });
  });
  test("first user prompt receives Skill links from the bound Catalogue", async () => {
    const harness = new SkillsSelectorHarness();
    expect(
      await harness.emit({ type: "input", source: "interactive", text: "Use $code-review." }),
    ).toEqual({
      action: "transform",
      text: "Use [$code-review](/skills/code-review/SKILL.md).",
    });
  });
});
