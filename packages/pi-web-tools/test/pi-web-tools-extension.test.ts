import { afterEach, describe, expect, test, vi } from "vitest";
import { createPiWebToolsExtension } from "../src/index.js";
import { toToolContext } from "./tool-context.js";
import { createWebToolsTestRunner } from "./web-tools-test-harness.js";

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

/** Register the tools from a fresh module evaluation under a mocked clock. */
async function modelFacingDefinitionsAt(date: string) {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(date) });
  try {
    const { default: freshExtension } = await import("../src/index.js");
    const runner = await createWebToolsTestRunner(freshExtension);
    return runner
      .getAllRegisteredTools()
      .map(({ definition: { name, description, parameters, outputSchema, promptSnippet } }) => ({
        name,
        description,
        parameters,
        outputSchema,
        promptSnippet,
      }));
  } finally {
    vi.useRealTimers();
  }
}

describe("Pi Web Tools extension", () => {
  test("declares the same model-facing definitions when loaded in different calendar years", async () => {
    const before = await modelFacingDefinitionsAt("2026-06-15T12:00:00Z");
    const after = await modelFacingDefinitionsAt("2027-06-15T12:00:00Z");
    expect(after).toEqual(before);
    expect(before.map(({ name }) => name)).toEqual(["web_search", "web_fetch"]);
  });

  test("executes both tools through the composed extension with one environment snapshot", async () => {
    const environment = { EXA_API_KEY: "snapshot-key" };
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return init?.method === "POST"
        ? new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { content: [{ type: "text", text: "search result" }] },
            }),
          )
        : new Response("fetch result", { headers: { "content-type": "text/plain" } });
    };
    const extension = createPiWebToolsExtension({
      environment,
      fetch,
      exaUrl: "https://exa.example/search",
      parallelUrl: "https://parallel.example/search",
    });
    environment.EXA_API_KEY = "changed-key";
    const runner = await createWebToolsTestRunner(extension, "session-b");
    const search = runner.getToolDefinition("web_search");
    const webFetch = runner.getToolDefinition("web_fetch");
    if (search === undefined || webFetch === undefined) throw new Error("Expected both web tools");

    const searchUpdates: unknown[] = [];
    const fetchUpdates: unknown[] = [];
    const searchResult = await search.execute(
      "search-call",
      { query: "current facts" },
      undefined,
      (update) => searchUpdates.push(update),
      toToolContext(runner.createContext()),
    );
    const fetchResult = await webFetch.execute(
      "fetch-call",
      { url: "https://example.com/page", format: "text" },
      undefined,
      (update) => fetchUpdates.push(update),
      toToolContext(runner.createContext()),
    );

    expect(searchUpdates).toEqual([{ content: [], details: { provider: "exa" } }]);
    expect(fetchUpdates).toEqual([
      {
        content: [],
        details: { url: "https://example.com/page", contentType: "", format: "text" },
      },
    ]);
    expect(searchResult.content).toEqual([{ type: "text", text: "search result" }]);
    expect(fetchResult.content).toEqual([{ type: "text", text: "fetch result" }]);
    expect(requests[0]?.url).toContain("exaApiKey=snapshot-key");
    expect(requests[0]?.url).not.toContain("changed-key");
  });
});
