import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import piWebToolsExtension, { createPiWebToolsExtension } from "../src/index.js";
import { createWebToolsTestRunner } from "./web-tools-test-harness.js";

async function registeredTools() {
  const runner = await createWebToolsTestRunner(piWebToolsExtension);
  return runner.getAllRegisteredTools().map(({ definition }) => definition);
}

describe("Pi Web Tools extension", () => {
  test("registers the Web Search and Web Fetch contracts", async () => {
    const tools = await registeredTools();
    expect(tools.map(({ name }) => name)).toEqual(["web_search", "web_fetch"]);

    const search = tools[0];
    const fetch = tools[1];
    expect(search).toMatchObject({
      label: "Web Search",
      promptSnippet: "Search the web for current information",
    });
    expect(search?.description).toContain(String(new Date().getFullYear()));
    expect(search?.description).toContain("50 KiB or 2,000 lines");
    expect(fetch).toMatchObject({
      label: "Web Fetch",
      promptSnippet: "Fetch one HTTP or HTTPS URL as text, Markdown, or HTML",
    });
    expect(fetch?.description).toContain("50 KiB or 2,000 lines");
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

    const searchResult = await search.execute(
      "search-call",
      { query: "current facts" },
      undefined,
      undefined,
      runner.createContext(),
    );
    const fetchResult = await webFetch.execute(
      "fetch-call",
      { url: "https://example.com/page", format: "text" },
      undefined,
      undefined,
      runner.createContext(),
    );

    expect(searchResult.content).toEqual([{ type: "text", text: "search result" }]);
    expect(fetchResult.content).toEqual([{ type: "text", text: "fetch result" }]);
    expect(requests[0]?.url).toContain("exaApiKey=snapshot-key");
    expect(requests[0]?.url).not.toContain("changed-key");
  });

  test("accepts documented inputs and rejects schema violations", async () => {
    const [search, fetch] = await registeredTools();
    if (search === undefined || fetch === undefined) throw new Error("Expected both web tools");

    expect(Value.Check(search.parameters, { query: "current Pi release" })).toBe(true);
    expect(
      Value.Check(search.parameters, {
        query: "current Pi release",
        numResults: 20,
        livecrawl: "preferred",
        type: "deep",
        contextMaxCharacters: 50_000,
      }),
    ).toBe(true);
    for (const input of [
      {},
      { query: "x", numResults: 0 },
      { query: "x", numResults: 21 },
      { query: "x", numResults: 1.5 },
      { query: "x", livecrawl: "always" },
      { query: "x", type: "slow" },
      { query: "x", contextMaxCharacters: 0 },
      { query: "x", contextMaxCharacters: 50_001 },
    ]) {
      expect(Value.Check(search.parameters, input)).toBe(false);
    }

    expect(Value.Check(fetch.parameters, { url: "https://example.com" })).toBe(true);
    expect(
      Value.Check(fetch.parameters, { url: "http://localhost", format: "html", timeout: 120 }),
    ).toBe(true);
    for (const input of [
      {},
      { url: "https://example.com", format: "pdf" },
      { url: "https://example.com", timeout: 0 },
      { url: "https://example.com", timeout: 121 },
    ]) {
      expect(Value.Check(fetch.parameters, input)).toBe(false);
    }
  });
});
