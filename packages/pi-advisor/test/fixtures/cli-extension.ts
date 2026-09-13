import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverPiAgentSession } from "@ian-pascoe/pi-utils/pi-agent-session-discovery";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";

/** Offline CLI boundary: real loading, commands, and reviews without network requests. */
export default function cliFixture(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const found = discoverPiAgentSession(pi, AgentSession);
    if (!found.ok) throw new Error(found.warning);
    console.log(
      `ADVISOR_CLI_RESOURCES=${JSON.stringify({
        privateRole: ctx.sessionManager
          .getBranch()
          .some((entry) => entry.type === "custom" && entry.customType === "pi-advisor-role"),
        extensions: found.session.resourceLoader
          .getExtensions()
          .extensions.map(({ path, resolvedPath, sourceInfo, hidden }) => ({
            path,
            resolvedPath,
            sourceInfo,
            hidden,
          })),
      })}`,
    );
  });
  pi.registerProvider("advisor-cli-fixture", {
    api: "openai-completions",
    apiKey: "offline",
    oauth: {
      name: "Offline CLI OAuth",
      async login() {
        throw new Error("CLI tests must not start login");
      },
      async refreshToken(credentials) {
        if (credentials.refresh !== "offline-refresh")
          throw new Error("Unexpected fixture credential");
        console.log("ADVISOR_CLI_REFRESH");
        return { ...credentials, access: "refreshed-offline-access", expires: 4102444800000 };
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    },
    baseUrl: "https://advisor.invalid",
    models: [
      {
        id: "model",
        name: "Offline CLI",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16000,
        maxTokens: 1024,
      },
    ],
    streamSimple(model, context, options) {
      if (options?.apiKey !== "offline" && options?.apiKey !== "refreshed-offline-access")
        throw new Error("Unexpected CLI fixture authentication");
      console.log(`ADVISOR_CLI_AUTH=${options.apiKey === "offline" ? "api-key" : "oauth"}`);
      const reviewing = context.tools?.some((tool) => tool.name === "advisor_report") ?? false;
      console.log(`ADVISOR_CLI_INFERENCE=${reviewing ? "review" : "observed"}`);
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Offline task complete"),
        provider: model.provider,
        model: model.id,
        api: model.api,
      };
      if (reviewing) {
        message.content = [
          {
            type: "toolCall",
            id: "report",
            name: "advisor_report",
            arguments: { severity: "none" },
          },
        ];
        message.stopReason = "toolUse";
      }
      queueMicrotask(() =>
        stream.push({ type: "done", reason: reviewing ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  });
  pi.registerCommand("advisor-cli-reload", {
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
  pi.registerCommand("advisor-cli-probe", {
    handler: async (_args, ctx) => {
      const status = ctx.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status");
      console.log(
        `ADVISOR_CLI_PROBE=${JSON.stringify({ status: status?.type === "custom" ? status.data : null, activeTools: pi.getActiveTools() })}`,
      );
    },
  });
}
