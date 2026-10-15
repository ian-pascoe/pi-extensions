import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCurrentTools, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MinimalSubagentsCoordinator } from "../src/minimal-subagents-coordinator.js";
import { childMcpServerScope } from "../src/minimal-subagents-child-resources.js";
import { PiAgentSessionFactory } from "../src/minimal-subagents-sessions.js";
import type { MinimalSubagentsToolsets, ToolSelection } from "../src/minimal-subagents-types.js";
import { OFFLINE_TEST_MODEL } from "./fixtures/offline-provider.js";

const FAKE_SERVER = resolve(import.meta.dirname, "fixtures", "fake-mcp-server.mjs");
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
/** Every tool the two fake servers offer, plus the resource tools. */
const MCP_TOOLS = [
  "mcp__alpha__search",
  "mcp__alpha__other",
  "mcp__beta_docs__search",
  "mcp__beta_docs__other",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
];
/** Reports which tools a codemode script can find and call. */
const PROBE_SCRIPT = `
const all = ALL_TOOLS.map((tool) => tool.name);
const found = (await searchTools("search other resources", { limit: 50 })).map((tool) => tool.name);
const called = {};
for (const name of ${JSON.stringify(MCP_TOOLS)}) {
  try {
    const result = await tools[name]({});
    called[name] = typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    called[name] = "error";
  }
}
return { all, found, called };
`;
const NO_TOOLSETS: MinimalSubagentsToolsets = {
  baseToolset: [],
  readToolset: [],
  modifyToolset: [],
};

type Exposure = "codemode" | "deferred" | "direct";
type ToolCall =
  | { name: "codemode"; arguments: { code: string } }
  | { name: "tool_search"; arguments: { query: string } }
  | { name: "read_mcp_resource"; arguments: { server: string; uri: string } }
  | { name: string; arguments: Record<string, never> };

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

/**
 * Run one child turn whose model makes `calls` in order, with two fake stdio MCP servers
 * (`alpha` and `beta-docs`) configured in `mcp.json`.
 */
async function runChild(input: {
  tools: ToolSelection | undefined;
  callerTools?: string[];
  calls: ToolCall[];
  exposure?: Exposure;
  toolsets?: MinimalSubagentsToolsets;
}) {
  const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-child-mcp-"));
  temporaryDirectories.push(directory);
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  const requestsPath = join(directory, "requests.jsonl");
  const launchLog = join(directory, "launches.log");
  const providerPath = join(directory, "offline-provider.ts");
  writeFileSync(requestsPath, "");
  writeFileSync(
    providerPath,
    `import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const calls = ${JSON.stringify(input.calls)};
export default function (pi) {
  pi.registerProvider("provider", {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "offline-test-key",
    models: [${JSON.stringify(OFFLINE_TEST_MODEL)}],
    streamSimple(model, context) {
      appendFileSync(${JSON.stringify(requestsPath)}, JSON.stringify(context) + "\\n");
      const lastUser = context.messages.findLastIndex((message) => message.role === "user");
      const index = context.messages.slice(lastUser).filter((message) => message.role === "assistant").length;
      const call = calls[index];
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), usage: ${JSON.stringify(ZERO_USAGE)},
        content: call
          ? [{ type: "toolCall", id: "call-" + index, name: call.name, arguments: call.arguments }]
          : [{ type: "text", text: "done" }],
        stopReason: call ? "toolUse" : "stop",
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message }));
      return stream;
    },
  });
}
`,
  );
  writeFileSync(
    join(directory, "settings.json"),
    JSON.stringify({
      extensions: [providerPath],
      codemode: { mode: "on" },
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
  const exposure = input.exposure ?? "codemode";
  writeFileSync(
    join(directory, "mcp.json"),
    JSON.stringify({
      mcpServers: Object.fromEntries(
        ["alpha", "beta-docs"].map((name) => [
          name,
          { command: process.execPath, args: [FAKE_SERVER, name, launchLog], exposure },
        ]),
      ),
    }),
  );
  const extensionPaths: string[] = [];
  const capabilityCeiling = ["codemode", "tool_search", "read", ...MCP_TOOLS];
  const coordinator: MinimalSubagentsCoordinator = new MinimalSubagentsCoordinator({
    toolsets: input.toolsets ?? NO_TOOLSETS,
    sessions: new PiAgentSessionFactory({
      cwd: directory,
      agentDir: directory,
      sessionDir: directory,
      rootSessionId: "root",
      extensionEntrypoint: join(directory, "minimal-subagents.ts"),
      models: [OFFLINE_TEST_MODEL],
      eligibleModelIds: ["provider/model"],
      modelScopeRestricted: false,
      availableToolNames: capabilityCeiling,
      projectTrusted: true,
      getCoordinatorTools: () => [],
      observeSession: (_session, _agentId, { extensions }) => {
        extensionPaths.push(...extensions.map(({ path }) => path));
        return undefined;
      },
    }),
    registry: { rootSessionId: "root", append: () => undefined },
    root: {
      queueCoordinatorMessage: async () => undefined,
      isIdle: () => true,
      hasDeliveryEvidence: () => false,
    },
    automaticDeliveryGraceMs: 0,
  });
  try {
    const spawned = await coordinator.spawn(
      "root",
      { agent_id: "child", task: "Probe MCP", tools: input.tools, project_context: "omit" },
      {
        messages: [],
        model: "provider/model",
        thinkingLevel: "medium",
        ordinaryTools: input.callerTools ?? [],
        capabilityCeiling,
        spawnEntryId: "entry",
      },
    );
    await expect(coordinator.wait("root", "child", 20_000)).resolves.toMatchObject({
      event: "turn",
      status: "completed",
      output: "done",
    });
    const requests: { messages: Message[] }[] = readFileSync(requestsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const results = (requests.at(-1)?.messages ?? []).filter(
      (message): message is ToolResultMessage => message.role === "toolResult",
    );
    const status = coordinator.status("root", "child");
    if (!("agent" in status)) throw new Error("status of one child has no agent");
    return {
      spawned,
      status,
      requests,
      extensionPaths,
      /** Text of each tool result, in call order. */
      resultTexts: results.map((result) =>
        result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
      ),
      /** The JSON a codemode script returned, from the last text part of its result. */
      scriptOutput: (index: number) => {
        const part = results[index]?.content.at(-1);
        // SAFETY: PROBE_SCRIPT returns exactly this shape, and codemode ends with its JSON.
        return JSON.parse(part?.type === "text" ? part.text : "null") as {
          all: string[];
          found: string[];
          called: Record<string, string>;
        };
      },
      readLaunches: () =>
        existsSync(launchLog)
          ? readFileSync(launchLog, "utf8").trim().split("\n").filter(Boolean)
          : [],
    };
  } finally {
    await coordinator.shutdown();
  }
}

const probe: ToolCall = { name: "codemode", arguments: { code: PROBE_SCRIPT } };

describe("child MCP reachability", () => {
  it("keeps MCP tools out of a child whose grant names none", async () => {
    const child = await runChild({
      tools: "none",
      toolsets: { ...NO_TOOLSETS, baseToolset: ["codemode", "tool_search"] },
      calls: [probe, { name: "tool_search", arguments: { query: "search other resources" } }],
    });

    const output = child.scriptOutput(0);
    expect(output.all.filter((name) => MCP_TOOLS.includes(name))).toEqual([]);
    expect(output.found.filter((name) => MCP_TOOLS.includes(name))).toEqual([]);
    expect(Object.values(output.called)).toEqual(MCP_TOOLS.map(() => "error"));
    for (const name of MCP_TOOLS) expect(child.resultTexts[1]).not.toContain(name);
    expect(child.spawned).toMatchObject({ tools: ["codemode", "tool_search"] });
    expect(child.status.agent).toMatchObject({ tools: ["codemode", "tool_search"] });
    // Without an MCP grant the child loads no MCP extension, so it starts no servers.
    expect(child.extensionPaths).not.toContain("builtin:mcp");
    expect(child.readLaunches()).toEqual([]);
  }, 30_000);

  it("reaches only the granted MCP tool from codemode", async () => {
    const child = await runChild({
      tools: ["codemode", "mcp__alpha__search"],
      calls: [probe],
    });

    const output = child.scriptOutput(0);
    expect(output.all.filter((name) => MCP_TOOLS.includes(name))).toEqual(["mcp__alpha__search"]);
    expect(output.called).toEqual({
      ...Object.fromEntries(MCP_TOOLS.map((name) => [name, "error"])),
      mcp__alpha__search: expect.stringContaining("alpha:search"),
    });
    expect(child.status.agent).toMatchObject({ tools: ["codemode"] });
    expect(child.readLaunches()).toEqual(["alpha"]);
  }, 30_000);

  it("loads a granted deferred MCP tool through tool_search", async () => {
    const child = await runChild({
      tools: ["tool_search", "mcp__beta_docs__search"],
      exposure: "deferred",
      calls: [
        { name: "tool_search", arguments: { query: "search" } },
        { name: "mcp__beta_docs__search", arguments: {} },
      ],
    });

    expect(child.resultTexts[0]).toContain("mcp__beta_docs__search");
    expect(child.resultTexts[0]).not.toContain("mcp__alpha__search");
    expect(child.resultTexts[1]).toBe("beta-docs:search");
    expect(child.readLaunches()).toEqual(["beta-docs"]);
  }, 30_000);

  it("declares a granted direct MCP tool", async () => {
    const child = await runChild({
      tools: ["mcp__alpha__search"],
      exposure: "direct",
      calls: [{ name: "mcp__alpha__search", arguments: {} }],
    });

    expect(getCurrentTools(child.requests[0]!.messages).map(({ name }) => name)).toEqual([
      "mcp__alpha__search",
    ]);
    expect(child.resultTexts[0]).toBe("alpha:search");
    expect(child.readLaunches()).toEqual(["alpha"]);
  }, 30_000);

  it("connects every server for a granted resource tool", async () => {
    const child = await runChild({
      tools: ["read_mcp_resource"],
      exposure: "direct",
      calls: [{ name: "read_mcp_resource", arguments: { server: "alpha", uri: "alpha://intro" } }],
    });

    expect(child.resultTexts[0]).toContain("alpha intro");
    await vi.waitFor(() => expect(child.readLaunches().sort()).toEqual(["alpha", "beta-docs"]));
  }, 30_000);

  it("keeps MCP tools reachable for a child that inherits them", async () => {
    const child = await runChild({
      tools: undefined,
      callerTools: ["codemode", "mcp__alpha__search", "mcp__beta_docs__other"],
      calls: [probe],
    });

    const output = child.scriptOutput(0);
    expect(output.called).toMatchObject({
      mcp__alpha__search: expect.stringContaining("alpha:search"),
      mcp__beta_docs__other: expect.stringContaining("beta-docs:other"),
      mcp__alpha__other: "error",
      read_mcp_resource: "error",
    });
    expect(child.readLaunches().sort()).toEqual(["alpha", "beta-docs"]);
  }, 30_000);
});

describe("childMcpServerScope", () => {
  const reached = (grantedTools: string[]) => {
    const scope = childMcpServerScope(grantedTools);
    return scope === "none" || scope === "all"
      ? scope
      : ["alpha", "beta-docs", "beta_docs", "beta"].filter(scope);
  };

  it("reaches no server without an MCP grant", () => {
    expect(reached(["codemode", "tool_search", "read"])).toBe("none");
  });

  it("reaches the servers whose namespace a granted tool names", () => {
    expect(reached(["codemode", "mcp__alpha__search"])).toEqual(["alpha"]);
    // `-` and `_` share a namespace, as in Pi's tool names.
    expect(reached(["mcp__beta_docs__search"])).toEqual(["beta-docs", "beta_docs"]);
  });

  it("reaches every server through a resource tool or a pattern", () => {
    expect(reached(["list_mcp_resources"])).toBe("all");
    expect(reached(["mcp__*"])).toBe("all");
  });
});
