import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  Model,
  Context,
  SimpleStreamOptions,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";

type Role = "main" | "child" | "review-main" | "review-child";
declare global {
  var advisorHierarchyTest: {
    roles: Map<string, Role>;
    stream(
      role: Role,
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream;
  };
}

/** Fresh native provider instances; only the external model endpoint is scripted. */
export default function hierarchyFixture(pi: ExtensionAPI): void {
  let role: Role = "main";
  pi.registerProvider("hierarchy-fixture", {
    api: "openai-completions",
    apiKey: "offline",
    baseUrl: "https://hierarchy.invalid",
    models: [
      {
        id: "model",
        name: "Offline hierarchy",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 2048,
      },
    ],
    streamSimple: (model, context, options) =>
      globalThis.advisorHierarchyTest.stream(role, model, context, options),
  });
  pi.on("session_start", (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const privateEntry = branch.find(
      (entry) => entry.type === "custom" && entry.customType === "pi-advisor-role",
    );
    if (
      privateEntry?.type === "custom" &&
      Value.Check(Type.Object({ observedSessionId: Type.String() }), privateEntry.data)
    )
      role =
        globalThis.advisorHierarchyTest.roles.get(privateEntry.data.observedSessionId) === "child"
          ? "review-child"
          : "review-main";
    else if (
      branch.some(
        (entry) => entry.type === "custom" && entry.customType === "minimal-subagents.identity",
      )
    )
      role = "child";
    globalThis.advisorHierarchyTest.roles.set(ctx.sessionManager.getSessionId(), role);
  });
}
