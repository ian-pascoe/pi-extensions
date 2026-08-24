import type { SearchResultItem } from "@byterover/brv-bridge";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, test, vi } from "vitest";
import type { ByteRoverBridge, ByteRoverBridgeFactory } from "../src/byterover-bridge.js";
import {
  type ByteRoverManualToolDefinition,
  type ByteRoverManualToolHost,
  formatSearchResults,
  registerManualTools,
  isByteRoverManualToolDefinition,
} from "../src/tools.js";

const text = <TDetails>(result: AgentToolResult<TDetails> | undefined) => {
  const content = result?.content[0];
  return content?.type === "text" ? content.text : undefined;
};

class RecordingByteRoverBridge implements ByteRoverBridge {
  readonly ready = vi.fn<ByteRoverBridge["ready"]>(async () => true);
  readonly recall = vi.fn<ByteRoverBridge["recall"]>(async () => ({
    content: "remembered context",
  }));
  readonly search = vi.fn<ByteRoverBridge["search"]>(async () => ({
    results: [],
    totalFound: 0,
    message: "No matches",
  }));
  readonly persist = vi.fn<ByteRoverBridge["persist"]>(async () => ({
    status: "queued",
    message: "task-1",
  }));
}

class RecordingManualToolHost implements ByteRoverManualToolHost {
  readonly registeredToolNames: string[] = [];
  private recallTool: Extract<ByteRoverManualToolDefinition, { name: "brv_recall" }> | undefined;
  private searchTool: Extract<ByteRoverManualToolDefinition, { name: "brv_search" }> | undefined;
  private persistTool: Extract<ByteRoverManualToolDefinition, { name: "brv_persist" }> | undefined;

  registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = unknown>(
    tool: ToolDefinition<TParams, TDetails, TState>,
  ): void {
    this.registeredToolNames.push(tool.name);
    if (!isByteRoverManualToolDefinition(tool)) return;
    switch (tool.name) {
      case "brv_recall":
        this.recallTool = tool;
        return;
      case "brv_search":
        this.searchTool = tool;
        return;
      case "brv_persist":
        this.persistTool = tool;
        return;
    }
  }

  get(name: "brv_recall"): Extract<ByteRoverManualToolDefinition, { name: "brv_recall" }>;
  get(name: "brv_search"): Extract<ByteRoverManualToolDefinition, { name: "brv_search" }>;
  get(name: "brv_persist"): Extract<ByteRoverManualToolDefinition, { name: "brv_persist" }>;
  get(name: ByteRoverManualToolDefinition["name"]): ByteRoverManualToolDefinition {
    const tool =
      name === "brv_recall"
        ? this.recallTool
        : name === "brv_search"
          ? this.searchTool
          : this.persistTool;
    if (tool === undefined) throw new Error(`Expected registered ByteRover tool: ${name}`);
    return tool;
  }
}

const createContext = (cwd = "/repo") => ({ cwd });

const register = (configure?: (bridge: RecordingByteRoverBridge) => void) => {
  const pi = new RecordingManualToolHost();
  const bridge = new RecordingByteRoverBridge();
  configure?.(bridge);
  const overrideBridge = new RecordingByteRoverBridge();
  const createBridge = vi.fn<ByteRoverBridgeFactory>(() => overrideBridge);

  registerManualTools({
    pi,
    bridge,
    createBridge,
  });

  return { pi, tools: pi, bridge, overrideBridge, createBridge };
};

describe("formatSearchResults", () => {
  test("formats ranked ByteRover search results", () => {
    const results: Array<SearchResultItem> = [
      {
        title: "Auth tokens",
        path: "auth/tokens.md",
        score: 0.87,
        symbolKind: "topic",
        backlinkCount: 2,
        excerpt: "JWT token handling details.",
        relatedPaths: ["auth/login.md"],
      },
    ];

    expect(formatSearchResults(results, 3, "ignored")).toBe(
      [
        "Found 3 ByteRover results.",
        "1. Auth tokens (auth/tokens.md)",
        "   score: 0.87, kind: topic, backlinks: 2",
        "   JWT token handling details.",
        "   related: auth/login.md",
      ].join("\n"),
    );
  });
});

describe("registerManualTools", () => {
  test("schemas reject whitespace-only query, scope, and context", () => {
    const { tools } = register();
    const recall = tools.get("brv_recall");
    const search = tools.get("brv_search");
    const persist = tools.get("brv_persist");

    expect(Value.Check(recall.parameters, { query: "auth" })).toBe(true);
    expect(Value.Check(recall.parameters, { query: "   " })).toBe(false);
    expect(Value.Check(search.parameters, { query: "topic", scope: "docs" })).toBe(true);
    expect(Value.Check(search.parameters, { query: "   " })).toBe(false);
    expect(Value.Check(search.parameters, { query: "topic", scope: "   " })).toBe(false);
    expect(Value.Check(persist.parameters, { context: "durable memory" })).toBe(true);
    expect(Value.Check(persist.parameters, { context: "   " })).toBe(false);
  });

  test("recall checks readiness and returns a not ready message", async () => {
    const { tools, bridge } = register((recordingBridge) => {
      recordingBridge.ready.mockResolvedValue(false);
    });
    const recall = tools.get("brv_recall");

    const result = await recall?.execute(
      "call-1",
      { query: "auth" },
      undefined,
      undefined,
      createContext(),
    );

    expect(text(result)).toBe("ByteRover bridge is not ready.");
    expect(bridge.ready).toHaveBeenCalledTimes(1);
    expect(bridge.recall).not.toHaveBeenCalled();
  });

  test("recall uses a timeout override bridge and strips echoed summary query", async () => {
    const { tools, overrideBridge, createBridge } = register();
    vi.mocked(overrideBridge.recall).mockResolvedValue({
      content: '**Summary**: facts for "auth":\nremembered context',
    });
    const signal = new AbortController().signal;
    const recall = tools.get("brv_recall");

    const result = await recall?.execute(
      "call-1",
      { query: " auth ", timeoutMs: 1234 },
      signal,
      undefined,
      createContext("/work"),
    );

    expect(createBridge).toHaveBeenCalledWith({
      cwd: "/work",
      recallTimeoutMs: 1234,
    });
    expect(overrideBridge.recall).toHaveBeenCalledWith("auth", {
      cwd: "/work",
      signal,
    });
    expect(text(result)).toBe("**Summary**: facts:\nremembered context");
  });

  test("search checks readiness and formats returned results", async () => {
    const { tools, bridge } = register();
    const results: Array<SearchResultItem> = [
      {
        title: "Topic",
        path: "topic.md",
        score: 1,
        excerpt: "match",
      },
    ];
    vi.mocked(bridge.search).mockResolvedValue({
      results,
      totalFound: 1,
      message: "ok",
    });
    const search = tools.get("brv_search");

    const result = await search?.execute(
      "call-1",
      { query: " topic ", limit: 5, scope: " docs " },
      undefined,
      undefined,
      createContext("/work"),
    );

    expect(bridge.ready).toHaveBeenCalledTimes(1);
    expect(bridge.search).toHaveBeenCalledWith("topic", {
      cwd: "/work",
      limit: 5,
      scope: "docs",
    });
    expect(text(result)).toContain("Found 1 ByteRover result.");
  });

  test("persist does not check readiness and detaches writes", async () => {
    const { tools, bridge, overrideBridge, createBridge } = register((recordingBridge) => {
      recordingBridge.ready.mockResolvedValue(false);
    });
    vi.mocked(overrideBridge.persist).mockResolvedValue({
      status: "queued",
      message: "task-1",
    });
    const persist = tools.get("brv_persist");

    const result = await persist?.execute(
      "call-1",
      { context: " durable memory ", timeoutMs: 4321 },
      undefined,
      undefined,
      createContext("/work"),
    );

    expect(bridge.ready).not.toHaveBeenCalled();
    expect(createBridge).toHaveBeenCalledWith({
      cwd: "/work",
      persistTimeoutMs: 4321,
    });
    expect(overrideBridge.persist).toHaveBeenCalledWith("durable memory", {
      cwd: "/work",
      detach: true,
    });
    expect(text(result)).toBe("ByteRover persist queued: task-1");
  });
});
