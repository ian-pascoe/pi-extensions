import { toToolContext } from "./tool-context.js";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createWebSearchTool,
  redactWebSearchApiKey,
  selectSearchProvider,
  WEB_SEARCH_TIMEOUT_MS,
  WebSearchOutputSchema,
  type SearchProvider,
  type WebSearchToolOptions,
} from "../src/web-search.js";
import { TROUBLESHOOTING_HINT } from "../src/troubleshooting-skill.js";
import { createWebToolsTestRunner } from "./web-tools-test-harness.js";

type RecordedRequest = {
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly url: string;
};

type TestResponse = {
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
};

type ProviderMessage = {
  readonly jsonrpc?: "2.0";
  readonly id?: number | null;
  readonly result?: {
    readonly _meta?: Readonly<Record<string, boolean>>;
    readonly content?: readonly { readonly type: string; readonly text?: string }[];
    readonly isError?: boolean;
  };
  readonly error?: { readonly code: number; readonly message: string };
};

const servers: Server[] = [];
const spillDirectories: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  await Promise.all(
    spillDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function startServer(
  respond: (request: RecordedRequest) => TestResponse | undefined,
): Promise<{ readonly baseUrl: string; readonly requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else chunks.push(Buffer.from(chunk));
    }
    const recorded = {
      url: request.url ?? "",
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    } satisfies RecordedRequest;
    requests.push(recorded);
    const result = respond(recorded);
    if (result === undefined) return;
    response.writeHead(result.status ?? 200, result.headers);
    response.end(result.body);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  servers.push(server);
  const address = server.address();
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node exposes a documented string-or-address transport union here.
  if (address === null || typeof address === "string") throw new Error("Expected TCP test server");
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function mcpResult(text: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text }] },
  });
}

async function executeSearch(
  provider: SearchProvider,
  options: WebSearchToolOptions,
  parameters: {
    readonly query: string;
    readonly numResults?: number;
    readonly contextMaxCharacters?: number;
  },
  signal?: AbortSignal,
) {
  const toolDefinition = createWebSearchTool(options);
  const runner = await createWebToolsTestRunner(
    (pi) => pi.registerTool(toolDefinition),
    provider === "exa" ? "session-b" : "session-a",
  );
  expect(runner.getToolDefinition("web_search")).toBe(toolDefinition);
  return toolDefinition.execute(
    "search-call",
    parameters,
    signal,
    undefined,
    toToolContext(runner.createContext()),
  );
}

describe("Web Search", () => {
  test("uses OpenCode FNV-1a checksum parity per session", () => {
    expect(selectSearchProvider("")).toBe("exa");
    expect(selectSearchProvider("session-a")).toBe("parallel");
    expect(selectSearchProvider("session-b")).toBe("exa");
    expect(selectSearchProvider("session-a")).toBe("parallel");
    expect(WEB_SEARCH_TIMEOUT_MS).toBe(25_000);
    expect(JSON.stringify(redactWebSearchApiKey("hidden"))).toBe('"[REDACTED]"');
  });

  test("calls Exa with defaults, optional controls, and a query credential", async () => {
    const server = await startServer(() => ({ body: mcpResult("exa results") }));
    const secret = "exa secret";
    const result = await executeSearch(
      "exa",
      {
        exaUrl: `${server.baseUrl}/exa`,
        parallelUrl: `${server.baseUrl}/parallel`,
        exaApiKey: redactWebSearchApiKey(secret),
      },
      {
        query: "current Pi release",
        numResults: 3,
        contextMaxCharacters: 2_500,
      },
    );

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      url: "/exa?exaApiKey=exa+secret",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: {
            query: "current Pi release",
            objective: "current Pi release",
            numResults: 3,
          },
        },
      },
    });
    // Exa receives only what its schema declares: no type, livecrawl, or contextMaxCharacters.
    expect(server.requests[0]).toMatchObject({
      body: {
        params: {
          arguments: {
            query: "current Pi release",
            objective: "current Pi release",
            numResults: 3,
          },
        },
      },
    });
    const sent = JSON.stringify(server.requests[0]?.body);
    for (const absent of ["type", "livecrawl", "contextMaxCharacters"]) {
      expect(sent).not.toContain(`"${absent}"`);
    }
    expect(server.requests[0]?.headers.accept).toBe("application/json, text/event-stream");
    expect(server.requests[0]?.headers["content-type"]).toContain("application/json");
    expect(result).toEqual({
      content: [{ type: "text", text: "exa results" }],
      details: { provider: "exa" },
      structuredContent: { provider: "exa", content: "exa results" },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("sends Exa the query as its objective and the default result count", async () => {
    const server = await startServer(() => ({ body: mcpResult("defaults") }));
    await executeSearch(
      "exa",
      { exaUrl: `${server.baseUrl}/exa`, parallelUrl: `${server.baseUrl}/parallel` },
      { query: "defaults" },
    );

    const body = server.requests[0]?.body;
    expect(body).toMatchObject({
      params: { arguments: { query: "defaults", objective: "defaults", numResults: 8 } },
    });
    for (const absent of ["type", "livecrawl", "contextMaxCharacters"]) {
      expect(JSON.stringify(body)).not.toContain(`"${absent}"`);
    }
  });

  test("calls Parallel with its session, bearer credential, and SSE response", async () => {
    const server = await startServer(() => ({
      body: `data: [DONE]\n\nevent: message\ndata: ${mcpResult("parallel results")}\n\n`,
      headers: { "content-type": "text/event-stream" },
    }));
    const secret = "parallel-secret";
    const result = await executeSearch(
      "parallel",
      {
        exaUrl: `${server.baseUrl}/exa`,
        parallelUrl: `${server.baseUrl}/parallel`,
        parallelApiKey: redactWebSearchApiKey(secret),
      },
      { query: "Effect TypeScript", numResults: 20, contextMaxCharacters: 50_000 },
    );

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      url: "/parallel",
      headers: { authorization: `Bearer ${secret}`, "user-agent": "pi-web-tools" },
      body: {
        params: {
          name: "web_search",
          arguments: {
            objective: "Effect TypeScript",
            search_queries: ["Effect TypeScript"],
            session_id: expect.any(String),
          },
        },
      },
    });
    const sent = JSON.stringify(server.requests[0]?.body);
    expect(sent).not.toContain("numResults");
    expect(sent).not.toContain("contextMaxCharacters");
    expect(result).toEqual({
      content: [{ type: "text", text: "parallel results" }],
      details: { provider: "parallel" },
      structuredContent: { provider: "parallel", content: "parallel results" },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("returns the stable fallback when the provider has no text", async () => {
    const server = await startServer(() => ({
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "image", data: "ignored" }] },
      }),
    }));
    const result = await executeSearch(
      "exa",
      { exaUrl: `${server.baseUrl}/exa`, parallelUrl: `${server.baseUrl}/parallel` },
      { query: "nothing" },
    );
    expect(result.content).toEqual([
      { type: "text", text: "No search results found. Please try a different query." },
    ]);
  });

  test("does not cut the no-results notice at contextMaxCharacters", async () => {
    const server = await startServer(() => ({
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "image", data: "ignored" }] },
      }),
    }));
    for (const provider of ["exa", "parallel"] as const) {
      const result = await executeSearch(
        provider,
        { exaUrl: `${server.baseUrl}/exa`, parallelUrl: `${server.baseUrl}/parallel` },
        { query: "nothing", contextMaxCharacters: 5 },
      );
      const notice = "No search results found. Please try a different query.";
      expect(result.content).toEqual([{ type: "text", text: notice }]);
      expect(result.structuredContent).toEqual({ provider, content: notice });
    }
  });

  test("cuts Exa's objective to its 4096-character limit by code points", async () => {
    const server = await startServer(() => ({ body: mcpResult("ok") }));
    const query = `${"😀".repeat(4_095)}ab${"c".repeat(100)}`;
    await executeSearch(
      "exa",
      { exaUrl: `${server.baseUrl}/exa`, parallelUrl: `${server.baseUrl}/parallel` },
      { query },
    );
    expect(server.requests[0]).toMatchObject({
      body: { params: { arguments: { query, objective: `${"😀".repeat(4_095)}a` } } },
    });
  });

  test("fails once without provider fallback or transport leakage", async () => {
    const server = await startServer(() => ({ body: "{}", status: 200 }));
    const secret = "do-not-leak";
    await expect(
      executeSearch(
        "exa",
        {
          exaUrl: `${server.baseUrl}/exa`,
          parallelUrl: `${server.baseUrl}/parallel`,
          exaApiKey: redactWebSearchApiKey(secret),
        },
        { query: "malformed" },
      ),
    ).rejects.toThrow("Unable to search the web for malformed");
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.url).toContain(secret);
  });

  test("fails once on a non-OK response without provider fallback", async () => {
    const server = await startServer(() => ({ body: "unavailable", status: 503 }));
    await expect(
      executeSearch(
        "parallel",
        { exaUrl: `${server.baseUrl}/exa`, parallelUrl: `${server.baseUrl}/parallel` },
        { query: "status failure" },
      ),
    ).rejects.toThrow(
      `Unable to search the web for status failure: HTTP 503 Service Unavailable\n\n${TROUBLESHOOTING_HINT}`,
    );
    expect(server.requests).toHaveLength(1);
  });

  test("rejects an empty or whitespace-only query before any request", async () => {
    const server = await startServer(() => ({ body: mcpResult("never") }));
    for (const provider of ["exa", "parallel"] as const) {
      for (const query of ["", "  \n\t "]) {
        const failure: unknown = await executeSearch(
          provider,
          { exaUrl: `${server.baseUrl}/exa`, parallelUrl: `${server.baseUrl}/parallel` },
          { query },
        ).catch((cause: unknown) => cause);
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toBe(
          "Error: Unable to search the web: query is empty (provide the text to search the web for)",
        );
      }
    }
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(executeSearch("exa", { fetch }, { query: " " })).rejects.toThrow("query is empty");
    expect(fetch).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
  });

  describe("provider failures", () => {
    const exaSecret = "exa secret/key+1";
    const parallelSecret = "parallel-secret-key";

    function sse(payload: ProviderMessage): TestResponse {
      return {
        body: `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        headers: { "content-type": "text/event-stream" },
      };
    }

    async function failureOf(
      provider: SearchProvider,
      respond: TestResponse,
      query = "failing query",
    ): Promise<{ readonly message: string; readonly requests: number }> {
      const server = await startServer(() => respond);
      const failure: unknown = await executeSearch(
        provider,
        {
          exaUrl: `${server.baseUrl}/exa`,
          parallelUrl: `${server.baseUrl}/parallel`,
          exaApiKey: redactWebSearchApiKey(exaSecret),
          parallelApiKey: redactWebSearchApiKey(parallelSecret),
        },
        { query },
      ).catch((cause: unknown) => cause);
      if (!(failure instanceof Error)) throw new Error("Expected Web Search to fail");
      expect(failure.message).not.toContain(exaSecret);
      expect(failure.message).not.toContain(parallelSecret);
      return { message: failure.message, requests: server.requests.length };
    }

    test("surfaces Exa isError text from an SSE response without the hint", async () => {
      const text =
        'MCP error -32602: Input validation error: Invalid arguments for tool web_search_exa: [\n  {\n    "code": "too_small",\n    "message": "String must contain at least 1 character(s)",\n    "path": [\n      "query"\n    ]\n  }\n]';
      const failure = await failureOf(
        "exa",
        sse({
          result: { content: [{ type: "text", text }], isError: true },
          jsonrpc: "2.0",
          id: 1,
        }),
      );
      expect(failure.requests).toBe(1);
      expect(failure.message).toBe(
        `Unable to search the web for failing query: Exa reported an error: MCP error -32602: Input validation error: Invalid arguments for tool web_search_exa: [ { "code": "too_small", "message": "String must contain at least 1 character(s)", "path": [ "query" ] } ]`,
      );
      expect(failure.message).not.toContain(TROUBLESHOOTING_HINT);
    });

    test("surfaces Parallel isError text from a JSON response without the hint", async () => {
      const failure = await failureOf("parallel", {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: "Error executing tool web_search: search_queries must be a non-empty list of non-empty strings. (Internal Detail: None)",
              },
            ],
            isError: true,
          },
        }),
        headers: { "content-type": "application/json" },
      });
      expect(failure.message).toBe(
        "Unable to search the web for failing query: Parallel reported an error: Error executing tool web_search: search_queries must be a non-empty list of non-empty strings. (Internal Detail: None)",
      );
    });

    test("reports isError without text", async () => {
      const failure = await failureOf("parallel", {
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], isError: true } }),
      });
      expect(failure.message).toBe(
        "Unable to search the web for failing query: Parallel reported an error",
      );
    });

    test("surfaces a JSON-RPC error object returned with HTTP 200 by either provider", async () => {
      const providerError = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: invalid JSON" },
      } satisfies ProviderMessage;
      const body = JSON.stringify(providerError);
      const parallel = await failureOf("parallel", { body });
      expect(parallel.message).toBe(
        "Unable to search the web for failing query: Parallel returned error -32700: Parse error: invalid JSON",
      );
      const exa = await failureOf("exa", sse(providerError));
      expect(exa.message).toBe(
        "Unable to search the web for failing query: Exa returned error -32700: Parse error: invalid JSON",
      );
    });

    test("treats Exa's rate-limit meta on an HTTP 200 result as a diagnosable failure", async () => {
      const text =
        "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key.\n\nFix: Create API key at https://dashboard.exa.ai/api-keys , and then update Exa MCP URL to this https://mcp.exa.ai/mcp?exaApiKey=YOUR_EXA_API_KEY";
      const failure = await failureOf(
        "exa",
        sse({
          result: { _meta: { "ai.exa/rateLimited": true }, content: [{ type: "text", text }] },
          jsonrpc: "2.0",
          id: 1,
        }),
      );
      expect(failure.message).toBe(
        `Unable to search the web for failing query: Exa rate limit reached: ${text.replace(/\s+/g, " ")}\n\n${TROUBLESHOOTING_HINT}`,
      );
    });

    test("does not treat a false rate-limit flag as a failure", async () => {
      const server = await startServer(() =>
        sse({
          result: {
            _meta: { "ai.exa/rateLimited": false },
            content: [{ type: "text", text: "ok" }],
          },
        }),
      );
      const result = await executeSearch(
        "exa",
        { exaUrl: `${server.baseUrl}/exa` },
        { query: "fine" },
      );
      expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    });

    test("bounds very long provider messages", async () => {
      const failure = await failureOf("exa", {
        body: JSON.stringify({
          result: {
            content: [{ type: "text", text: `${"boom ".repeat(1_000)}tail` }],
            isError: true,
          },
        }),
      });
      expect(failure.message.length).toBeLessThan(600);
      expect(failure.message).toContain("boom boom");
      expect(failure.message).toContain("…");
      expect(failure.message).not.toContain("tail");
    });

    test("redacts API keys a provider echoes back", async () => {
      const exa = await failureOf("exa", {
        body: JSON.stringify({
          result: {
            content: [
              {
                type: "text",
                text: `bad key ${exaSecret} at ?exaApiKey=${encodeURIComponent(exaSecret)}`,
              },
            ],
            isError: true,
          },
        }),
      });
      expect(exa.message).toContain("bad key [REDACTED] at ?exaApiKey=[REDACTED]");
      const parallel = await failureOf("parallel", {
        body: JSON.stringify({
          error: { code: -32001, message: `Unauthorized: Bearer ${parallelSecret}` },
        }),
      });
      expect(parallel.message).toContain("Unauthorized: Bearer [REDACTED]");
    });

    test("redacts a key before truncation so no fragment survives the cut", async () => {
      const key = exaSecret;
      const text = `${"a".repeat(495)}${key} trailing`;
      const failure = await failureOf("exa", {
        body: JSON.stringify({
          id: 1,
          result: { content: [{ type: "text", text }], isError: true },
        }),
      });
      expect(failure.message).toContain(`${"a".repeat(495)}[REDA…`);
      for (let length = 3; length <= key.length; length++) {
        expect(failure.message).not.toContain(key.slice(0, length));
      }
    });

    test("redacts the form-encoded key and a key split by invisible characters", async () => {
      const failure = await failureOf("exa", {
        body: JSON.stringify({
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: `form ${new URLSearchParams({ k: exaSecret }).toString().slice(2)} split ${exaSecret.slice(0, 4)}\u200b${exaSecret.slice(4)}`,
              },
            ],
            isError: true,
          },
        }),
      });
      expect(failure.message).not.toContain("exa+secret");
      expect(failure.message).not.toContain("exa%20secret");
      expect(failure.message).not.toContain(exaSecret);
      expect(failure.message).not.toContain(exaSecret.slice(0, 4));
    });

    test("strips terminal and invisible control characters from provider messages", async () => {
      const failure = await failureOf("parallel", {
        body: JSON.stringify({
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: "bad\u001b[31m red\u001b]0;title\u0007 nul\u0000 bidi\u202Eevil\u200B zero\u0085 end",
              },
            ],
            isError: true,
          },
        }),
      });
      expect(failure.message).toBe(
        "Unable to search the web for failing query: Parallel reported an error: bad red nul bidievil zero end",
      );
    });

    test("never splits a surrogate pair when bounding", async () => {
      const failure = await failureOf("exa", {
        body: JSON.stringify({
          id: 1,
          result: { content: [{ type: "text", text: "😀".repeat(600) }], isError: true },
        }),
      });
      const bounded = failure.message.split("reported an error: ")[1] ?? "";
      expect(bounded).toBe(`${"😀".repeat(500)}…`);
    });

    test("drops the separator when the provider text is blank", async () => {
      const failure = await failureOf("exa", {
        body: JSON.stringify({
          id: 1,
          result: { content: [{ type: "text", text: " \n\t " }], isError: true },
        }),
      });
      expect(failure.message).toBe(
        "Unable to search the web for failing query: Exa reported an error",
      );
    });

    test("honors the Exa rate-limit meta only for Exa", async () => {
      const body = JSON.stringify({
        id: 1,
        result: {
          _meta: { "ai.exa/rateLimited": true },
          content: [{ type: "text", text: "found" }],
        },
      });
      const server = await startServer(() => ({ body }));
      const result = await executeSearch(
        "parallel",
        { parallelUrl: `${server.baseUrl}/parallel` },
        { query: "not exa" },
      );
      expect(result.content).toEqual([{ type: "text", text: "found" }]);
    });

    test("keeps the no-results fallback for a valid result without text", async () => {
      const server = await startServer(() => ({
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }),
      }));
      const result = await executeSearch(
        "parallel",
        { parallelUrl: `${server.baseUrl}/parallel` },
        { query: "nothing" },
      );
      expect(result.content).toEqual([
        { type: "text", text: "No search results found. Please try a different query." },
      ]);
    });

    test("skips notifications and other requests' responses on the SSE stream", async () => {
      const notification = JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "info" },
      });
      const other = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [], isError: true },
      });
      const server = await startServer(() => ({
        body: `data:${notification}\n\ndata: ${other}\n\ndata:${mcpResult("the answer")}\n\n`,
        headers: { "content-type": "text/event-stream" },
      }));
      const result = await executeSearch(
        "exa",
        { exaUrl: `${server.baseUrl}/exa` },
        { query: "streamed" },
      );
      expect(result.content).toEqual([{ type: "text", text: "the answer" }]);
    });

    test("joins multi-line data fields of one SSE event before parsing", async () => {
      const [head, tail] = [
        '{"jsonrpc":"2.0","id":1,',
        '"result":{"content":[{"type":"text","text":"joined"}]}}',
      ];
      const server = await startServer(() => ({
        body: `data: ${head}\ndata: ${tail}\n\n`,
        headers: { "content-type": "text/event-stream" },
      }));
      const result = await executeSearch(
        "parallel",
        { parallelUrl: `${server.baseUrl}/parallel` },
        { query: "multi-line" },
      );
      expect(result.content).toEqual([{ type: "text", text: "joined" }]);
    });

    test("orders an answer and a later error deterministically: the first decisive event wins", async () => {
      const answer = mcpResult("first answer");
      const failure = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "late failure" }], isError: true },
      });
      const empty = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } });
      const answered = await startServer(() => ({
        body: `data: ${answer}\n\ndata: ${failure}\n\n`,
      }));
      const result = await executeSearch(
        "exa",
        { exaUrl: `${answered.baseUrl}/exa` },
        { query: "ordered" },
      );
      expect(result.content).toEqual([{ type: "text", text: "first answer" }]);

      const failed = await failureOf("exa", { body: `data: ${empty}\n\ndata: ${failure}\n\n` });
      expect(failed.message).toBe(
        "Unable to search the web for failing query: Exa reported an error: late failure",
      );
    });

    test("reports an unrecognized response for malformed provider bodies", async () => {
      for (const provider of ["exa", "parallel"] as const) {
        const failure = await failureOf(provider, { body: "{}" });
        expect(failure.message).toBe(
          `Unable to search the web for failing query: ${provider === "exa" ? "Exa" : "Parallel"} returned an unrecognized response`,
        );
        const broken = await failureOf(provider, { body: "data: {not json\n" });
        expect(broken.message).toContain("returned an unrecognized response");
        for (const body of [
          "",
          "   ",
          "<html><body>Bad gateway</body></html>",
          "data: [DONE]\n\n",
        ]) {
          const failure = await failureOf(provider, { body });
          expect(failure.message).toBe(
            `Unable to search the web for failing query: ${provider === "exa" ? "Exa" : "Parallel"} returned an unrecognized response`,
          );
        }
      }
    });

    test("names the HTTP status and hints for server errors and key problems", async () => {
      for (const provider of ["exa", "parallel"] as const) {
        const unavailable = await failureOf(provider, { body: "unavailable", status: 503 });
        expect(unavailable.message).toBe(
          `Unable to search the web for failing query: HTTP 503 Service Unavailable\n\n${TROUBLESHOOTING_HINT}`,
        );
        const badRequest = await failureOf(provider, { body: "no", status: 400 });
        expect(badRequest.message).toBe(
          "Unable to search the web for failing query: HTTP 400 Bad Request",
        );
        expect(badRequest.requests).toBe(1);
        for (const [status, phrase] of [
          [401, "Unauthorized"],
          [403, "Forbidden"],
          [429, "Too Many Requests"],
        ] as const) {
          const keyProblem = await failureOf(provider, { body: "denied", status });
          expect(keyProblem.message).toBe(
            `Unable to search the web for failing query: HTTP ${status} ${phrase}\n\n${TROUBLESHOOTING_HINT}`,
          );
        }
      }
    });

    test("appends the JSON-RPC error a provider explains an HTTP error with", async () => {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      });
      for (const provider of ["exa", "parallel"] as const) {
        const name = provider === "exa" ? "Exa" : "Parallel";
        const badRequest = await failureOf(provider, {
          body,
          status: 400,
          headers: { "content-type": "application/json" },
        });
        expect(badRequest.message).toBe(
          `Unable to search the web for failing query: HTTP 400 Bad Request: ${name} returned error -32700: Parse error`,
        );
        const keyed = await failureOf(provider, {
          body: JSON.stringify({ error: { code: -32001, message: `bad ${exaSecret}` } }),
          status: 401,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
        expect(keyed.message).toBe(
          `Unable to search the web for failing query: HTTP 401 Unauthorized: ${name} returned error -32001: bad [REDACTED]\n\n${TROUBLESHOOTING_HINT}`,
        );
        const oversized = await failureOf(provider, {
          body: JSON.stringify({ error: { code: 1, message: "x".repeat(10_000) } }),
          status: 502,
          headers: { "content-type": "application/json" },
        });
        expect(oversized.message).toBe(
          `Unable to search the web for failing query: HTTP 502 Bad Gateway\n\n${TROUBLESHOOTING_HINT}`,
        );
        const notJsonRpc = await failureOf(provider, {
          body: "<html>",
          status: 400,
          headers: { "content-type": "application/json" },
        });
        expect(notJsonRpc.message).toBe(
          "Unable to search the web for failing query: HTTP 400 Bad Request",
        );
      }
    });

    test("names the network error class and hints", async () => {
      for (const provider of ["exa", "parallel"] as const) {
        const fetch: typeof globalThis.fetch = () => {
          throw new TypeError("fetch failed", {
            cause: Object.assign(
              new Error(`connect ECONNREFUSED 127.0.0.1:9?exaApiKey=${exaSecret}`),
              { code: "ECONNREFUSED" },
            ),
          });
        };
        const failure: unknown = await executeSearch(
          provider,
          {
            fetch,
            exaApiKey: redactWebSearchApiKey(exaSecret),
            parallelApiKey: redactWebSearchApiKey(parallelSecret),
          },
          { query: "offline" },
        ).catch((cause: unknown) => cause);
        expect(String(failure)).toBe(
          `Error: Unable to search the web for offline: network error ECONNREFUSED\n\n${TROUBLESHOOTING_HINT}`,
        );
      }
    });

    test("names the timeout deadline and hints", async () => {
      for (const provider of ["exa", "parallel"] as const) {
        const deadline = new AbortController();
        const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
        try {
          let requests = 0;
          const fetch: typeof globalThis.fetch = (_input, init) => {
            requests++;
            return new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
                once: true,
              });
            });
          };
          const pending = executeSearch(provider, { fetch }, { query: "slow" }).catch(
            (cause: unknown) => cause,
          );
          while (requests === 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
          deadline.abort(new DOMException("Timed out", "TimeoutError"));
          expect(String(await pending)).toBe(
            `Error: Unable to search the web for slow: timed out after 25 seconds\n\n${TROUBLESHOOTING_HINT}`,
          );
        } finally {
          timeout.mockRestore();
        }
      }
    });

    test("reports caller cancellation without a hint or key", async () => {
      for (const provider of ["exa", "parallel"] as const) {
        const stalled = await startServer(() => undefined);
        const controller = new AbortController();
        const pending = executeSearch(
          provider,
          {
            exaUrl: `${stalled.baseUrl}/exa`,
            parallelUrl: `${stalled.baseUrl}/parallel`,
            exaApiKey: redactWebSearchApiKey(exaSecret),
            parallelApiKey: redactWebSearchApiKey(parallelSecret),
          },
          { query: "cancel me" },
          controller.signal,
        ).catch((cause: unknown) => cause);
        while (stalled.requests.length === 0)
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
        controller.abort();
        expect(String(await pending)).toBe(
          "Error: Unable to search the web for cancel me: request cancelled",
        );
      }
    });
  });

  test("applies the 25-second deadline to an in-flight request", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      expect(milliseconds).toBe(25_000);
      return deadline.signal;
    });
    let requests = 0;
    const fetch: typeof globalThis.fetch = (_input, init) => {
      requests++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    };

    try {
      const pending = executeSearch("exa", { fetch }, { query: "timeout" });
      while (requests === 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
      deadline.abort(new DOMException("Timed out", "TimeoutError"));
      await expect(pending).rejects.toThrow("Unable to search the web for timeout");
      expect(requests).toBe(1);
    } finally {
      timeout.mockRestore();
    }
  });

  test("cancels caller-aborted searches and oversized response streams", async () => {
    let stalledClosed = false;
    const stalled = await startServer(() => undefined);
    servers.at(-1)?.on("connection", (socket) => socket.on("close", () => (stalledClosed = true)));
    const controller = new AbortController();
    const pending = executeSearch(
      "exa",
      { exaUrl: `${stalled.baseUrl}/exa`, parallelUrl: `${stalled.baseUrl}/parallel` },
      { query: "cancel me" },
      controller.signal,
    );
    while (stalled.requests.length === 0)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
    controller.abort();
    await expect(pending).rejects.toThrow(
      new Error("Unable to search the web for cancel me: request cancelled"),
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    expect(stalledClosed).toBe(true);

    const oversized = await startServer(() => ({ body: "x".repeat(256 * 1024 + 1) }));
    await expect(
      executeSearch(
        "parallel",
        { exaUrl: `${oversized.baseUrl}/exa`, parallelUrl: `${oversized.baseUrl}/parallel` },
        { query: "too much" },
      ),
    ).rejects.toThrow(
      "Unable to search the web for too much: response body exceeds the 262144-byte limit",
    );
    expect(oversized.requests).toHaveLength(1);
  });

  test("reports a failed output spill as itself, without leaking credentials", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-web-tools-test-"));
    spillDirectories.push(directory);
    const blocker = resolve(directory, "not-a-directory");
    await writeFile(blocker, "block");
    const previousTemporaryDirectory = process.env.TMPDIR;
    const secret = "spill-failure-secret";
    const fetch: typeof globalThis.fetch = async () => {
      process.env.TMPDIR = blocker;
      return new Response(mcpResult("é".repeat(30_000)));
    };

    try {
      const failure: unknown = await executeSearch(
        "exa",
        { fetch, exaApiKey: redactWebSearchApiKey(secret) },
        { query: "spill failure", contextMaxCharacters: 50_000 },
      ).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("Unable to save complete Web Tool output");
      expect(String(failure)).not.toContain("Unable to search the web");
      expect(String(failure)).not.toContain("network error");
      expect(String(failure)).not.toContain(TROUBLESHOOTING_HINT);
      expect(String(failure)).not.toContain(secret);
    } finally {
      if (previousTemporaryDirectory === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTemporaryDirectory;
    }
  });

  test("truncates provider text and retains the complete parsed result", async () => {
    const complete = Array.from({ length: 2_100 }, (_, index) => `result ${index}`).join("\n");
    const server = await startServer(() => ({ body: mcpResult(complete) }));
    const secret = "spill-secret";
    const result = await executeSearch(
      "exa",
      {
        exaUrl: `${server.baseUrl}/exa`,
        parallelUrl: `${server.baseUrl}/parallel`,
        exaApiKey: redactWebSearchApiKey(secret),
      },
      { query: "many results", contextMaxCharacters: 50_000 },
    );
    const path = result.details.truncation?.fullOutputPath;
    if (path === undefined) throw new Error("Expected search result spill");
    spillDirectories.push(dirname(path));

    expect(result.details).toMatchObject({ provider: "exa", truncation: { fullOutputPath: path } });
    const visible = result.content[0];
    if (visible?.type !== "text") throw new Error("Expected text search result");
    expect(Buffer.byteLength(visible.text)).toBeLessThanOrEqual(50 * 1024);
    expect(await readFile(path, "utf8")).toBe(complete);
    // Scripts cannot read the spill file, so they receive the complete provider text.
    expect(result.structuredContent).toEqual({
      provider: "exa",
      content: complete,
      full_output_path: path,
    });
    expect(Value.Check(WebSearchOutputSchema, result.structuredContent)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await readFile(path, "utf8")).not.toContain(secret);
  });

  describe("result shaping", () => {
    // Modeled on a live anonymous Parallel `web_search` answer: pretty-printed JSON text.
    function parallelText(count: number): string {
      return JSON.stringify(
        {
          search_id: "search_0123456789abcdef",
          results: Array.from({ length: count }, (_, index) => ({
            url: `https://example.com/pi/${index}`,
            title: `Pi coding agent ${index}`,
            publish_date: null,
            excerpts: [`Excerpt ${index}: a minimal agent harness.\nSecond line ${index}.`],
          })),
          warnings: null,
          metadata: null,
          session_id: "pi-web-tools-probe",
        },
        null,
        2,
      );
    }

    async function search(
      provider: SearchProvider,
      providerText: string,
      parameters: Parameters<typeof executeSearch>[2],
    ) {
      const server = await startServer(() => ({ body: mcpResult(providerText) }));
      const result = await executeSearch(
        provider,
        { exaUrl: `${server.baseUrl}/exa`, parallelUrl: `${server.baseUrl}/parallel` },
        parameters,
      );
      const text = result.content[0];
      if (text?.type !== "text") throw new Error("Expected text search result");
      return { result, text: text.text };
    }

    // Live Parallel text, trimmed (see web-tools-research.md): the exact pretty-printed bytes with
    // non-ASCII characters unescaped. The three-result file adds one result in the same format.
    const fixture = (name: string) =>
      readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8");
    const livePayloadTwo = fixture("parallel-search-2-results.txt");
    const livePayloadThree = fixture("parallel-search-3-results.txt");

    test("re-serializes a live Parallel payload byte for byte, keeping non-ASCII unescaped", async () => {
      expect(livePayloadThree).toContain("español");
      expect(livePayloadThree).toContain("日本語");
      const { text } = await search("parallel", livePayloadThree, { query: "q", numResults: 2 });
      expect(text).toBe(livePayloadTwo);
      expect(text).toContain("español");
      expect(text).not.toContain("\\u");
      // Within the limit the live text is returned untouched.
      expect((await search("parallel", livePayloadTwo, { query: "q", numResults: 2 })).text).toBe(
        livePayloadTwo,
      );
    });

    function resultCount(text: string): number {
      const parsed: unknown = JSON.parse(text);
      if (!Value.Check(Type.Object({ results: Type.Array(Type.Unknown()) }), parsed)) {
        throw new Error("Expected a Parallel payload");
      }
      return parsed.results.length;
    }

    test("trims Parallel results to numResults and keeps the payload format", async () => {
      const { result, text } = await search("parallel", parallelText(10), {
        query: "q",
        numResults: 3,
      });
      expect(resultCount(text)).toBe(3);
      const expected = parallelText(3);
      expect(text).toBe(expected);
      expect(result.structuredContent).toEqual({ provider: "parallel", content: expected });
    });

    test("trims Parallel results to the default count when numResults is omitted", async () => {
      const { text } = await search("parallel", parallelText(10), { query: "q" });
      expect(resultCount(text)).toBe(8);
    });

    test("leaves Parallel text unchanged when it has fewer results or is not the JSON payload", async () => {
      const few = parallelText(2);
      expect((await search("parallel", few, { query: "q", numResults: 5 })).text).toBe(few);
      for (const other of ["plain prose results", "[1, 2, 3]", '{"results": "none"}', "{broken"]) {
        expect((await search("parallel", other, { query: "q", numResults: 1 })).text).toBe(other);
      }
    });

    test("never trims Exa text, which Exa limits itself", async () => {
      const text = parallelText(10);
      expect((await search("exa", text, { query: "q", numResults: 2 })).text).toBe(text);
    });

    test("cuts provider text at contextMaxCharacters and marks the cut for both providers", async () => {
      for (const provider of ["exa", "parallel"] as const) {
        const { result, text } = await search(provider, "abcdefghij", {
          query: "q",
          contextMaxCharacters: 4,
        });
        const expected = "abcd\n\n[Search results cut at 4 characters]";
        expect(text).toBe(expected);
        // The model text and the script content agree.
        expect(result.structuredContent).toEqual({ provider, content: expected });
      }
    });

    test("does not cut or mark text within the limit", async () => {
      const { text } = await search("exa", "abcd", { query: "q", contextMaxCharacters: 4 });
      expect(text).toBe("abcd");
      expect((await search("exa", "abcdef", { query: "q" })).text).toBe("abcdef");
    });

    test("keeps a default 8-result search within the 6,000-character budget for both providers", async () => {
      const excerpt = "highlight ".repeat(150);
      const exa = Array.from(
        { length: 8 },
        (_, index) =>
          `Title: Result ${index}\nURL: https://example.com/${index}\nHighlights:\n${excerpt}`,
      ).join("\n\n");
      const parallel = JSON.stringify(
        {
          results: Array.from({ length: 8 }, (_, index) => ({
            url: `https://example.com/${index}`,
            title: `Result ${index}`,
            excerpts: [excerpt],
          })),
        },
        null,
        2,
      );
      expect(Array.from(exa).length).toBeGreaterThan(6_000);
      const shared = await search("exa", exa, { query: "q" });
      const marker = shared.text.slice(shared.text.lastIndexOf("\n\n["));
      expect(Array.from(shared.text).length - Array.from(marker).length).toBeLessThanOrEqual(6_000);
      expect(shared.result.structuredContent).toEqual({ provider: "exa", content: shared.text });

      expect(Array.from(parallel).length).toBeGreaterThan(6_000);
      const { result, text } = await search("parallel", parallel, { query: "q" });
      const parallelMarker =
        "\n\n[Search results cut at 6000 characters; pass contextMaxCharacters (up to 50000) for more]";
      expect(text).toBe(`${Array.from(parallel).slice(0, 6_000).join("")}${parallelMarker}`);
      expect(result.structuredContent).toEqual({ provider: "parallel", content: text });
    });

    describe("shares the budget across Exa results", () => {
      function exaBlock(index: number, bodyLength: number): string {
        return [
          `Title: Result ${index}`,
          `URL: https://example.com/${index}`,
          `Published Date: 2025-01-0${index}`,
          "Highlights:",
          `${String(index).repeat(bodyLength)}`,
        ].join("\n");
      }
      const headers = (index: number) =>
        `Title: Result ${index}\nURL: https://example.com/${index}\nPublished Date: 2025-01-0${index}`;

      test("keeps every result's header lines when the first result is huge", async () => {
        const complete = [1, 2, 3, 4, 5]
          .map((index) => exaBlock(index, index === 1 ? 20_000 : 3_000))
          .join("\n\n");
        const { result, text } = await search("exa", complete, { query: "q", numResults: 5 });
        for (const index of [1, 2, 3, 4, 5]) {
          expect(text).toContain(headers(index));
          expect(text).toContain(`Highlights:\n${String(index).repeat(100)}`);
        }
        const marker = text.slice(text.lastIndexOf("\n\n["));
        expect(text.endsWith(marker)).toBe(true);
        expect(marker).toContain("cut at 6000 characters");
        expect(marker).toContain("results 1, 2, 3, 4, 5");
        expect(marker).toContain("contextMaxCharacters");
        expect(marker).toContain("web_fetch");
        expect(Array.from(text).length - Array.from(marker).length).toBeLessThanOrEqual(6_000);
        // Equal long results get equal shares (within the remainder of an uneven split).
        const bodyLength = (index: number) =>
          text
            .split("\n")
            .filter((line) => line !== "" && line === String(index).repeat(line.length))
            .at(0)?.length ?? 0;
        expect(Math.abs(bodyLength(2) - bodyLength(5))).toBeLessThanOrEqual(1);
        expect(bodyLength(1)).toBe(bodyLength(2));
        expect(result.structuredContent).toEqual({ provider: "exa", content: text });
      });

      test("lets short results leave their unused share to longer ones and names only cut results", async () => {
        const complete = [exaBlock(1, 5_000), exaBlock(2, 50), exaBlock(3, 5_000)].join("\n\n");
        const { text } = await search("exa", complete, { query: "q" });
        expect(text).toContain(exaBlock(2, 50));
        const marker = text.slice(text.lastIndexOf("\n\n["));
        expect(marker).toContain("results 1, 3");
        expect(marker).not.toContain("2");
        expect(Array.from(text).length - Array.from(marker).length).toBe(6_000);
      });

      test("keeps header lines whole for an explicit budget that holds them", async () => {
        const complete = [exaBlock(1, 5_000), exaBlock(2, 5_000)].join("\n\n");
        const { text } = await search("exa", complete, { query: "q", contextMaxCharacters: 400 });
        expect(text).toContain(headers(1));
        expect(text).toContain(headers(2));
      });

      test("keeps only Title and URL lines when the full headers do not fit", async () => {
        const complete = [1, 2, 3, 4].map((index) => exaBlock(index, 5_000)).join("\n\n");
        // Full headers need ~4 x 75 characters; Title and URL alone need ~4 x 40.
        const { text } = await search("exa", complete, { query: "q", contextMaxCharacters: 260 });
        for (const index of [1, 2, 3, 4]) {
          expect(text).toContain(`Title: Result ${index}\nURL: https://example.com/${index}\n`);
        }
        expect(text).not.toContain("Published Date");
        const marker = text.slice(text.lastIndexOf("\n\n["));
        expect(marker).toContain("metadata other than Title and URL dropped");
        expect(Array.from(text).length - Array.from(marker).length).toBeLessThanOrEqual(260);
      });

      test("cuts body lines that merely look like metadata", async () => {
        const body = `Summary text: ${"s".repeat(8_000)}`;
        const complete = [exaBlock(1, 10).replace(/Highlights:\n.*$/, body), exaBlock(2, 10)].join(
          "\n\n",
        );
        const { text } = await search("exa", complete, { query: "q" });
        expect(text).toContain(headers(2));
        expect(text).toContain("Summary text: ");
        expect(text).not.toContain("s".repeat(7_000));
        expect(text).toContain("results 1 shortened".replace("results", "result"));
      });

      test("adds the contextMaxCharacters hint only when the budget was the default", async () => {
        const complete = [exaBlock(1, 5_000), exaBlock(2, 5_000)].join("\n\n");
        const byDefault = await search("exa", complete, { query: "q" });
        expect(byDefault.text).toContain("pass contextMaxCharacters (up to 50000) for more");
        const explicit = await search("exa", complete, { query: "q", contextMaxCharacters: 1_000 });
        expect(explicit.text).not.toContain("pass contextMaxCharacters");
        expect(explicit.text).toContain("cut at 1000 characters");
      });

      test("falls back to a plain cut when the budget cannot hold every header", async () => {
        const complete = [exaBlock(1, 5_000), exaBlock(2, 5_000)].join("\n\n");
        const { text } = await search("exa", complete, { query: "q", contextMaxCharacters: 50 });
        expect(text).toBe(`${complete.slice(0, 50)}\n\n[Search results cut at 50 characters]`);
      });

      test("returns text that fits unchanged", async () => {
        const complete = [exaBlock(1, 500), exaBlock(2, 500)].join("\n\n");
        expect((await search("exa", complete, { query: "q" })).text).toBe(complete);
      });
    });

    test("defaults contextMaxCharacters to 6,000 and says how to read more when it cuts", async () => {
      for (const provider of ["exa", "parallel"] as const) {
        const complete = "x".repeat(6_001);
        const { result, text } = await search(provider, complete, { query: "q" });
        const expected = `${"x".repeat(6_000)}\n\n[Search results cut at 6000 characters; pass contextMaxCharacters (up to 50000) for more]`;
        expect(text).toBe(expected);
        expect(result.structuredContent).toEqual({ provider, content: expected });
        const exact = "x".repeat(6_000);
        expect((await search(provider, exact, { query: "q" })).text).toBe(exact);
      }
    });

    test("lets an explicit contextMaxCharacters override the default, up to the unchanged maximum", async () => {
      const complete = "y".repeat(20_000);
      expect(
        (await search("exa", complete, { query: "q", contextMaxCharacters: 20_000 })).text,
      ).toBe(complete);
      const { text } = await search("exa", "y".repeat(50_001), {
        query: "q",
        contextMaxCharacters: 50_000,
      });
      expect(text).toBe(`${"y".repeat(50_000)}\n\n[Search results cut at 50000 characters]`);
    });

    test("never sends the budget to a provider: Exa's live schema declares no such field", async () => {
      const server = await startServer(() => ({ body: mcpResult("ok") }));
      await executeSearch(
        "exa",
        { exaUrl: `${server.baseUrl}/exa`, parallelUrl: `${server.baseUrl}/parallel` },
        { query: "q" },
      );
      expect(JSON.stringify(server.requests[0]?.body)).not.toContain("contextMaxCharacters");
      expect(JSON.stringify(server.requests[0]?.body)).not.toContain("maxCharacters");
    });

    test("counts code points, never splitting a multibyte character at the boundary", async () => {
      // "😀" is one code point but two UTF-16 units; "é" is two UTF-8 bytes.
      const { text } = await search("exa", "a😀é😀b", { query: "q", contextMaxCharacters: 2 });
      expect(text).toBe("a😀\n\n[Search results cut at 2 characters]");
      const exact = await search("exa", "😀😀😀", { query: "q", contextMaxCharacters: 3 });
      expect(exact.text).toBe("😀😀😀");
    });

    test("applies the numResults trim before the character cut", async () => {
      const { text } = await search("parallel", parallelText(10), {
        query: "q",
        numResults: 1,
        contextMaxCharacters: 20,
      });
      expect(text).toBe(`${parallelText(1).slice(0, 20)}\n\n[Search results cut at 20 characters]`);
    });

    test("describes each parameter's real behavior in static schema text", () => {
      const { properties }: { properties: Record<string, { description?: string }> } = JSON.parse(
        JSON.stringify(createWebSearchTool().parameters),
      );
      expect(Object.keys(properties)).toEqual(["query", "numResults", "contextMaxCharacters"]);
      expect(properties.numResults?.description).toContain("Exa applies it");
      expect(properties.contextMaxCharacters?.description).toContain("1–50,000");
      expect(properties.contextMaxCharacters?.description).toContain("default: 6,000");
      expect(properties.contextMaxCharacters?.description).not.toContain("No default");
    });
  });
});
