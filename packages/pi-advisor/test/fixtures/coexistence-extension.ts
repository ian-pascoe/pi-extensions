import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  Model,
  Context,
  SimpleStreamOptions,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

declare global {
  var advisorCoexistenceStream: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
}

/** The only scripted collaborator is the external model endpoint. */
export default function coexistenceFixture(pi: ExtensionAPI): void {
  pi.registerProvider("advisor-coexistence", {
    api: "openai-completions",
    apiKey: "offline",
    baseUrl: "https://coexistence.invalid",
    models: [
      {
        id: "model",
        name: "Offline",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 512,
      },
    ],
    streamSimple: (model, context, options) =>
      globalThis.advisorCoexistenceStream(model, context, options),
  });
  pi.on("session_shutdown", () => {
    pi.appendEntry("advisor-coexistence-shutdown", { stopped: true });
  });
}
