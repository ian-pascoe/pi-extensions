import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { endpointContext } from "./endpoint-context.js";

/**
 * Offline providers named and shaped like the real OpenAI, Codex, and Anthropic ones, so request
 * payloads can be built by Pi's own adapters while the scripted answers stay offline.
 */
export default function providerFixture(pi: ExtensionAPI): void {
  const models = (id: string) => [
    {
      id,
      name: "Offline",
      reasoning: true,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 2048,
    },
  ];
  const streamSimple: Parameters<typeof pi.registerProvider>[1]["streamSimple"] = (
    model,
    context,
    options,
  ) => {
    globalThis.advisorObserverTest.request?.(model, context, options);
    return globalThis.advisorObserverTest.stream(model, endpointContext(context), options);
  };
  pi.registerProvider("openai", {
    api: "openai-responses",
    apiKey: "offline",
    baseUrl: "https://openai.invalid/v1",
    models: models("offline-openai"),
    streamSimple,
  });
  pi.registerProvider("anthropic", {
    api: "anthropic-messages",
    apiKey: "offline",
    baseUrl: "https://anthropic.invalid",
    models: models("offline-anthropic"),
    streamSimple,
  });
  pi.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    apiKey: "offline",
    baseUrl: "https://codex.invalid",
    models: models("offline-openai-codex"),
    streamSimple,
  });
}
