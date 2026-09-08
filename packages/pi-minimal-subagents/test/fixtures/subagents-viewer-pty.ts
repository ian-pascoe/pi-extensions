// Manual native-Pi UI fixture: deterministic snapshots, no provider/model calls.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../../src/minimal-subagents-extension.js";
import { MinimalSubagentsCoordinator } from "../../src/minimal-subagents-coordinator.js";
import type {
  AgentSummary,
  ChildAgentTranscriptSnapshot,
} from "../../src/minimal-subagents-types.js";

const summary = (
  id: string,
  state: "idle" | "running" = "idle",
  children: AgentSummary[] = [],
): AgentSummary => ({
  agent_id: id,
  parent_id: id.includes(".") ? id.split(".")[0]! : "root",
  state,
  availability: "available",
  model: "fixture/model",
  thinking_level: "medium",
  tools: [],
  child_count: children.length,
  children,
  task: `Inspect ${id}`,
});
const nested = summary("parent.worker", "running");
const agents = [
  summary("idle-first"),
  summary("parent", "idle", [nested]),
  summary("active-last", "running"),
];
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const messages: ChildAgentTranscriptSnapshot["messages"] = [
  { role: "user", content: "Inherited parent context · [Image: image/png]", timestamp: 1 },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Reasoning is visible in this Child Session Transcript." },
      {
        type: "toolCall",
        name: "historical_tool",
        id: "old-call",
        arguments: { path: "historical-file.ts" },
      },
    ],
    provider: "fixture",
    api: "openai-completions",
    model: "model",
    usage,
    stopReason: "toolUse",
    timestamp: 2,
  },
  {
    role: "toolResult",
    toolCallId: "old-call",
    toolName: "historical_tool",
    content: [
      {
        type: "text",
        text: Array.from({ length: 40 }, (_, i) => `Historical tool line ${i + 1}`).join("\n"),
      },
    ],
    isError: false,
    timestamp: 3,
  },
  ...Array.from({ length: 80 }, (_, i) => ({
    role: "user" as const,
    content: `Earlier turn ${i + 1}: selected-branch conversation remains readable.`,
    timestamp: i + 4,
  })),
];
let ticks = 0;
MinimalSubagentsCoordinator.prototype.inspectStatus = () => ({ root_id: "root", agents });
MinimalSubagentsCoordinator.prototype.inspectTranscript = () => ({
  messages: [
    ...messages,
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Live output ${ticks}\nChild work continues while the viewer is open.`,
        },
      ],
      provider: "fixture",
      api: "openai-completions",
      model: "model",
      usage,
      stopReason: "stop",
      timestamp: 1000,
    },
  ],
  streamingAssistantIndex: messages.length,
  toolDefinitions: [],
});
/** Exercise native Pi UI with synthetic, continuously updating Child Agent snapshots. */
export default async function (pi: ExtensionAPI) {
  let open: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] | undefined;
  const register = pi.registerCommand.bind(pi);
  pi.registerCommand = (name, command) => {
    if (name === "subagents") open = command.handler;
    register(name, command);
  };
  await extension(pi);
  pi.registerCommand = register;
  pi.registerCommand("draft-viewer", {
    description: "Open with retained draft",
    handler: async (_, ctx) => {
      ctx.ui.setEditorText("retained draft: do not clear me");
      await open?.("status", ctx);
    },
  });
  pi.registerCommand("viewer-dialog", {
    description: "Check dialog input ownership",
    handler: async (_, ctx) => {
      await ctx.ui.select("Keep this dialog focused", ["first", "second"]);
    },
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify("Viewer fixture ready", "info");
    timer = setInterval(() => {
      ticks++;
      if (ticks % 3 === 0)
        pi.sendMessage(
          { customType: "fixture-root", content: `Root heartbeat ${ticks}`, display: true },
          { triggerTurn: false },
        );
    }, 1000);
  });
  pi.on("session_shutdown", () => clearInterval(timer));
}
