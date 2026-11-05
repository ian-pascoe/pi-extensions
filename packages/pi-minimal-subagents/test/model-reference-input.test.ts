import type {
  AutocompleteProviderFactory,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
  buildSubagentModelCatalogue,
  registerSubagentModelReferences,
  type SubagentModelCatalogue,
} from "../src/minimal-subagents-model-references.js";

type Handler = (
  event: InputEvent | SessionStartEvent,
  context: ExtensionContext,
) => InputEventResult | void | Promise<InputEventResult | void>;

const LINK = '[%large](model-role://large "Subagent model role: role=large")';

function harness(initial: SubagentModelCatalogue | undefined) {
  let catalogue = initial;
  const handlers = new Map<string, Handler>();
  const factories: AutocompleteProviderFactory[] = [];
  const api = { on: (name: string, handler: Handler) => handlers.set(name, handler) };
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: registration uses only `on`.
  registerSubagentModelReferences(api as unknown as ExtensionAPI, () => catalogue);
  const emit = (event: InputEvent | SessionStartEvent, mode: ExtensionContext["mode"] = "tui") => {
    const handler = handlers.get(event.type);
    if (!handler) throw new Error(`Missing ${event.type} handler`);
    const context = {
      mode,
      ui: {
        addAutocompleteProvider: (factory: AutocompleteProviderFactory) => factories.push(factory),
      },
    };
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: handlers read only mode and the autocomplete API.
    return handler(event, context as unknown as ExtensionContext);
  };
  return {
    emit,
    factories,
    setCatalogue: (next: SubagentModelCatalogue | undefined) => {
      catalogue = next;
    },
  };
}

const catalogue = buildSubagentModelCatalogue({
  eligibleModelIds: ["anthropic/claude-opus-5-5"],
  models: [{ provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" }],
  modelRoles: [{ name: "large", model: "anthropic/claude-opus-5-5" }],
});

const input = (text: string, source: InputEvent["source"] = "interactive"): InputEvent => ({
  type: "input",
  text,
  source,
});

describe("Subagent Model Reference input", () => {
  test("transforms interactive and RPC input, keeping images", async () => {
    const { emit } = harness(catalogue);
    expect(await emit(input("Plan with %large", "rpc"), "rpc")).toEqual({
      action: "transform",
      text: `Plan with ${LINK}`,
    });
    const images = [{ type: "image" as const, data: "AA==", mimeType: "image/png" }];
    expect(await emit({ ...input("Plan with %large"), images })).toEqual({
      action: "transform",
      text: `Plan with ${LINK}`,
      images,
    });
  });

  test("leaves extension input, literal text, and input without a catalogue unchanged", async () => {
    const { emit, setCatalogue } = harness(catalogue);
    expect(await emit(input("Plan with %large", "extension"))).toEqual({ action: "continue" });
    expect(await emit(input("Plan with %medium"))).toEqual({ action: "continue" });
    setCatalogue(undefined);
    expect(await emit(input("Plan with %large"))).toEqual({ action: "continue" });
  });

  test("stacks the completion popup in the terminal UI only, reading the catalogue each time", async () => {
    const { emit, factories, setCatalogue } = harness(catalogue);
    await emit({ type: "session_start", reason: "startup" }, "rpc");
    expect(factories).toHaveLength(0);
    await emit({ type: "session_start", reason: "startup" });
    const factory = factories[0];
    if (!factory) throw new Error("Missing autocomplete provider");
    const provider = factory(new CombinedAutocompleteProvider([], "/tmp", null));
    expect(provider.triggerCharacters).toContain("%");
    const options = { signal: new AbortController().signal };
    const suggestions = await provider.getSuggestions(["Use %la"], 0, 7, options);
    expect(suggestions?.prefix).toBe("%la");
    expect(suggestions?.items.map((item) => item.value)).toEqual([
      "%large",
      "%anthropic/claude-opus-5-5",
    ]);
    setCatalogue(undefined);
    expect(await provider.getSuggestions(["Use %la"], 0, 7, options)).toBeNull();
  });
});
