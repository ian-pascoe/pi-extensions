import type {
  ExtensionAPI,
  SessionBeforeCompactResult,
  ToolInfo,
  ToolResultEvent,
  ToolResultEventResult,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type {
  Context,
  Model,
  Api,
  SimpleStreamOptions,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { endpointContext } from "./endpoint-context.js";

declare global {
  var advisorObserverTest: {
    stream: (
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ) => AssistantMessageEventStream;
    beforeTask?: () => void;
    turnEnd?: (event: TurnEndEvent) => Promise<void>;
    /** Observed tool-result rewrite, such as display-only `details`. */
    toolResult?: (event: ToolResultEvent) => ToolResultEventResult | undefined;
    settled?: () => Promise<void>;
    privateSettled?: () => Promise<void>;
    privateShutdown?: () => Promise<void>;
    /** The private Advisor Session's native `session_before_compact` result. */
    privateBeforeCompact?: () => SessionBeforeCompactResult | undefined;
    /** Tools the private Advisor Session reports to its inherited extensions. */
    privateTools?: (tools: ToolInfo[]) => void;
  };
}

/** Offline provider and real awaited SDK hooks, controlled at the host boundary. */
export default function observerFixture(pi: ExtensionAPI): void {
  pi.registerProvider("observer-fixture", {
    api: "openai-completions",
    apiKey: "offline",
    baseUrl: "https://observer.invalid",
    models: ["model", "alternate", "priced", "wide"].map((id) => ({
      id,
      name: "Offline",
      reasoning: true,
      input: ["text", "image"],
      // `priced` declares prices, so its zero-usage responses cost a known $0.
      cost:
        id === "priced"
          ? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
          : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // `wide` declares a 1M window, where the absolute `auto` ceilings bind.
      contextWindow: id === "wide" ? 1_000_000 : 200000,
      maxTokens: 2048,
    })),
    streamSimple: (model, context, options) =>
      globalThis.advisorObserverTest.stream(model, endpointContext(context), options),
  });
  let privateRole = false;
  pi.on("session_start", (_event, ctx) => {
    privateRole = ctx.sessionManager
      .getBranch()
      .some((entry) => entry.type === "custom" && entry.customType === "pi-advisor-role");
  });
  pi.on("before_agent_start", () => {
    if (privateRole) globalThis.advisorObserverTest.privateTools?.(pi.getAllTools());
    else globalThis.advisorObserverTest.beforeTask?.();
  });
  pi.on("turn_end", (event) =>
    privateRole ? undefined : globalThis.advisorObserverTest.turnEnd?.(event),
  );
  pi.on("tool_result", (event) =>
    privateRole ? undefined : globalThis.advisorObserverTest.toolResult?.(event),
  );
  pi.on("session_before_compact", () =>
    privateRole ? globalThis.advisorObserverTest.privateBeforeCompact?.() : undefined,
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
