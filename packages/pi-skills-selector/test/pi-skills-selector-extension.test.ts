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
import { describe, expect, test } from "vite-plus/test";
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
  test("does not register terminal autocomplete outside the TUI", async () => {
    const harness = new SkillsSelectorHarness();
    await harness.emit({ type: "session_start", reason: "startup" }, "rpc");
    expect(harness.factories).toEqual([]);
  });
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
  test("preserves attachments and steering delivery", async () => {
    const harness = new SkillsSelectorHarness();
    const event: InputEvent = {
      type: "input",
      source: "rpc",
      text: "$ponytail",
      streamingBehavior: "steer",
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    };
    expect(await harness.emit(event, "rpc")).toEqual({
      action: "transform",
      text: "[$ponytail](/skills/ponytail/SKILL.md)",
      images: event.images,
    });
    expect(event.streamingBehavior).toBe("steer");
    expect(event.text).toBe("$ponytail");
  });
  test("leaves extension-generated messages and unknown references unchanged", async () => {
    const harness = new SkillsSelectorHarness();
    expect(
      await harness.emit({ type: "input", source: "extension", text: "$code-review" }),
    ).toEqual({ action: "continue" });
    expect(
      await harness.emit({ type: "input", source: "interactive", text: "$unknown $HOME" }),
    ).toEqual({ action: "continue" });
  });
});
