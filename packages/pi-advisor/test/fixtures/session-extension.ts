import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type AssistantMessage,
} from "@earendil-works/pi-ai";

declare global {
  var advisorSessionResponses: AssistantMessage[] | undefined;
}

/** File-backed provider: the model boundary is entirely offline. */
export default function sessionFixture(pi: ExtensionAPI): void {
  let touches = 0;
  pi.registerFlag("fixture-enabled", {
    type: "boolean",
    description: "Fixture flag",
    default: true,
  });
  pi.registerProvider("advisor-fixture", {
    api: "openai-completions",
    apiKey: "fixture-key",
    baseUrl: "https://advisor.invalid",
    models: ["reviewer", "alternate"].map((id) => ({
      id,
      name: "Offline reviewer",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 2048,
    })),
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message = {
        ...(globalThis.advisorSessionResponses?.shift() ??
          fauxAssistantMessage("Offline review complete")),
        provider: model.provider,
        model: model.id,
        api: model.api,
      };
      const reason = message.stopReason;
      if (reason === "pending") throw new Error("Fixture requires a completed response");
      queueMicrotask(() => {
        if (reason === "error" || reason === "aborted")
          stream.push({ type: "error", reason, error: message });
        else stream.push({ type: "done", reason, message });
      });
      return stream;
    },
  });
  pi.on("session_start", (_event, ctx) => {
    pi.appendEntry("fixture-start", {
      privateRole: ctx.sessionManager
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === "pi-advisor-role"),
    });
  });
  pi.on("session_shutdown", () => {
    pi.appendEntry("fixture-shutdown", { stopped: true });
  });
  pi.registerCommand("touch-fixture", {
    description: "Record independent session-local state",
    async handler(_args, ctx) {
      pi.appendEntry("fixture-touch", {
        touches: ++touches,
        flag: pi.getFlag("fixture-enabled"),
        sessionId: ctx.sessionManager.getSessionId(),
      });
    },
  });
  pi.registerCommand("reload-fixture", {
    description: "Native reload",
    async handler(_args, ctx) {
      await ctx.reload();
    },
  });
  pi.registerCommand("dynamic-fixture", {
    description: "Register and activate tools dynamically",
    async handler() {
      for (const name of ["allowed_dynamic", "denied_dynamic"]) {
        pi.registerTool({
          name,
          label: name,
          description: name,
          parameters: Type.Object({}),
          async execute() {
            return { content: [{ type: "text", text: name }], details: {} };
          },
        });
      }
      pi.setActiveTools([...pi.getActiveTools(), "allowed_dynamic", "denied_dynamic", "bash"]);
    },
  });
}
