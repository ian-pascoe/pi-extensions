import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverPiAgentSession } from "@ian-pascoe/pi-utils/pi-agent-session-discovery";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";

function messageText(message: Context["messages"][number] | undefined): string {
  if (!message || !("content" in message)) return "";
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Pi's public message union uses string-or-content blocks.
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

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
      const lastUser = messageText(context.messages.findLast((message) => message.role === "user"));
      const consultation = reviewing && lastUser.includes("Consultation request");
      console.log(
        `ADVISOR_CLI_INFERENCE=${consultation ? "consultation" : reviewing ? "review" : "observed"}`,
      );
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Offline task complete"),
        provider: model.provider,
        model: model.id,
        api: model.api,
      };
      if (consultation) {
        message.content = [{ type: "text", text: "Inspect the native path." }];
        console.log("ADVISOR_CLI_CONSULTATION=Inspect the native path.");
      } else if (reviewing) {
        message.content = [
          {
            type: "toolCall",
            id: "report",
            name: "advisor_report",
            arguments: { severity: "none" },
          },
        ];
        message.stopReason = "toolUse";
      } else if (
        lastUser.includes("Ask Advisor which path to inspect") &&
        !context.messages.some(
          (item) => item.role === "toolResult" && item.toolName === "advisor_ask",
        )
      ) {
        message.content = [
          {
            type: "toolCall",
            id: "ask",
            name: "advisor_ask",
            arguments: { message: "Which path should I inspect?" },
          },
        ];
        message.stopReason = "toolUse";
      }
      queueMicrotask(() =>
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        }),
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
