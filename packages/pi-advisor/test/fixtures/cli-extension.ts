import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Offline CLI boundary: real loading and commands, no provider requests. */
export default function cliFixture(pi: ExtensionAPI): void {
  pi.registerProvider("advisor-cli-fixture", {
    api: "openai-completions",
    apiKey: "offline",
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
    streamSimple() {
      throw new Error("CLI command test must not start model inference");
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
