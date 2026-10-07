import type { AssistantMessageEventStream, Context, Model, Api } from "@earendil-works/pi-ai";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  withoutInitialSystemMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Role = "main" | "child";
declare global {
  var guardianCombinedTest: {
    executed: string[];
    stream(role: Role, model: Model<Api>, context: Context): AssistantMessageEventStream;
  };
}

/**
 * Loaded in the root and in every Child Agent: an offline provider whose replies the test
 * scripts per role, and a `deploy` tool Guardian reviews by default.
 */
export default function combinedFixture(pi: ExtensionAPI): void {
  let role: Role = "main";
  pi.registerProvider("guardian-combined", {
    api: "openai-completions",
    apiKey: "offline",
    baseUrl: "https://guardian-combined.invalid",
    models: ["model", "reviewer"].map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 2_048,
    })),
    streamSimple: (model, context) =>
      globalThis.guardianCombinedTest.stream(role, model, {
        systemPrompt: getCurrentSystemPrompt(context.messages),
        messages: withoutInitialSystemMessage(context.messages),
        tools: getCurrentTools(context.messages),
      }),
  });
  pi.registerTool({
    name: "deploy",
    label: "Deploy",
    description: "Deploy the given target.",
    parameters: Type.Object({ target: Type.String() }),
    execute: async (_id, args) => {
      globalThis.guardianCombinedTest.executed.push(`${role}:deploy:${args.target}`);
      return { content: [{ type: "text", text: `deployed ${args.target}` }], details: {} };
    },
  });
  pi.on("session_start", (_event, ctx) => {
    role = ctx.sessionManager
      .getBranch()
      .some((entry) => entry.type === "custom" && entry.customType === "minimal-subagents.identity")
      ? "child"
      : "main";
  });
}
