import type { BrvBridge, SearchResultItem } from "@byterover/brv-bridge";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, test, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { formatSearchResults, registerManualTools } from "../src/tools.js";

type MockBridge = Pick<BrvBridge, "ready" | "recall" | "search" | "persist">;

const text = (result: { content: Array<{ type: "text"; text: string }> }) =>
  result.content[0]?.text;

const createMockBridge = (overrides: Partial<MockBridge> = {}) =>
  ({
    ready: vi.fn(async () => true),
    recall: vi.fn(async () => ({ content: "remembered context" })),
    search: vi.fn(async () => ({
      results: [],
      totalFound: 0,
      message: "No matches",
    })),
    persist: vi.fn(async () => ({ status: "queued", message: "task-1" })),
    ...overrides,
  }) as MockBridge;

const createRegistry = () => {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: vi.fn((tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    }),
  } as unknown as ExtensionAPI;

  return { pi, tools };
};

const createContext = (cwd = "/repo") => ({ cwd }) as ExtensionContext;

const register = (overrides: Partial<MockBridge> = {}) => {
  const { pi, tools } = createRegistry();
  const bridge = createMockBridge(overrides);
  const overrideBridge = createMockBridge();
  const createBridge = vi.fn(() => overrideBridge as BrvBridge);

  registerManualTools({
    pi,
    bridge: bridge as BrvBridge,
    config: ConfigSchema.parse(undefined),
    createBridge,
  });

  return { pi, tools, bridge, overrideBridge, createBridge };
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

  test("uses search message when no results are returned", () => {
    expect(formatSearchResults([], 0, "No matches")).toBe("No matches");
  });
});

describe("registerManualTools", () => {
  test("registers recall, search, and persist tools", () => {
    const { pi, tools } = register();

    expect(pi.registerTool).toHaveBeenCalledTimes(3);
    expect([...tools.keys()].sort()).toEqual(["brv_persist", "brv_recall", "brv_search"]);
  });

  test("schemas reject whitespace-only query, scope, and context", () => {
    const { tools } = register();
    const recall = tools.get("brv_recall")!;
    const search = tools.get("brv_search")!;
    const persist = tools.get("brv_persist")!;

    expect(Value.Check(recall.parameters, { query: "auth" })).toBe(true);
    expect(Value.Check(recall.parameters, { query: "   " })).toBe(false);
    expect(Value.Check(search.parameters, { query: "topic", scope: "docs" })).toBe(true);
    expect(Value.Check(search.parameters, { query: "   " })).toBe(false);
    expect(Value.Check(search.parameters, { query: "topic", scope: "   " })).toBe(false);
    expect(Value.Check(persist.parameters, { context: "durable memory" })).toBe(true);
    expect(Value.Check(persist.parameters, { context: "   " })).toBe(false);
  });

  test("recall checks readiness and returns a not ready message", async () => {
    const { tools, bridge } = register({ ready: vi.fn(async () => false) });
    const recall = tools.get("brv_recall");

    const result = await recall?.execute(
      "call-1",
      { query: "auth" },
      undefined,
      undefined,
      createContext(),
    );

    expect(text(result as never)).toBe("ByteRover bridge is not ready.");
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
    expect(text(result as never)).toBe("**Summary**: facts:\nremembered context");
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
    expect(text(result as never)).toContain("Found 1 ByteRover result.");
  });

  test("persist does not check readiness and detaches writes", async () => {
    const { tools, bridge, overrideBridge, createBridge } = register({
      ready: vi.fn(async () => false),
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
    expect(text(result as never)).toBe("ByteRover persist queued: task-1");
  });
});
