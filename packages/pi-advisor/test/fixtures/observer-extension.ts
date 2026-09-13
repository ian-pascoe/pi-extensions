import type { ExtensionAPI, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type {
  Context,
  Model,
  Api,
  SimpleStreamOptions,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

declare global {
  var advisorObserverTest: {
    stream: (
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ) => AssistantMessageEventStream;
    beforeTask?: () => void;
    turnEnd?: (event: TurnEndEvent) => Promise<void>;
    settled?: () => Promise<void>;
    privateSettled?: () => Promise<void>;
    privateShutdown?: () => Promise<void>;
  };
}

/** Offline provider and real awaited SDK hooks, controlled at the host boundary. */
export default function observerFixture(pi: ExtensionAPI): void {
  pi.registerProvider("observer-fixture", {
    api: "openai-completions",
    apiKey: "offline",
    baseUrl: "https://observer.invalid",
    models: ["model", "alternate"].map((id) => ({
      id,
      name: "Offline",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 2048,
    })),
    streamSimple: (model, context, options) =>
      globalThis.advisorObserverTest.stream(model, context, options),
  });
  let privateRole = false;
  pi.on("session_start", (_event, ctx) => {
    privateRole = ctx.sessionManager
      .getBranch()
      .some((entry) => entry.type === "custom" && entry.customType === "pi-advisor-role");
  });
  pi.on("before_agent_start", () =>
    privateRole ? undefined : globalThis.advisorObserverTest.beforeTask?.(),
  );
  pi.on("turn_end", (event) =>
    privateRole ? undefined : globalThis.advisorObserverTest.turnEnd?.(event),
  );
  pi.on("session_shutdown", () =>
    privateRole ? globalThis.advisorObserverTest.privateShutdown?.() : undefined,
  );
  pi.on("agent_settled", () =>
    privateRole
      ? globalThis.advisorObserverTest.privateSettled?.()
      : globalThis.advisorObserverTest.settled?.(),
  );
}
