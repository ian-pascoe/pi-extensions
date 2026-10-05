import { toToolContext } from "./tool-context.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
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
    readonly livecrawl?: "fallback" | "preferred";
    readonly type?: "auto" | "fast" | "deep";
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
        livecrawl: "preferred",
        type: "fast",
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
            numResults: 3,
            livecrawl: "preferred",
            type: "fast",
            contextMaxCharacters: 2_500,
          },
        },
      },
    });
    expect(server.requests[0]?.headers.accept).toBe("application/json, text/event-stream");
    expect(server.requests[0]?.headers["content-type"]).toContain("application/json");
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Warning: Exa ignores: type, livecrawl, contextMaxCharacters.\n\nexa results",
        },
      ],
      details: {
        provider: "exa",
        warnings: ["Exa ignores: type, livecrawl, contextMaxCharacters."],
      },
      structuredContent: {
        provider: "exa",
        content: "exa results",
        warnings: ["Exa ignores: type, livecrawl, contextMaxCharacters."],
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("omits absent Exa context characters so the provider owns its effective default", async () => {
    const server = await startServer(() => ({ body: mcpResult("defaults") }));
    await executeSearch(
      "exa",
      { exaUrl: `${server.baseUrl}/exa`, parallelUrl: `${server.baseUrl}/parallel` },
      { query: "defaults" },
    );

    expect(server.requests[0]).toMatchObject({
      body: {
        params: {
          arguments: {
            query: "defaults",
            numResults: 8,
            livecrawl: "fallback",
            type: "auto",
          },
        },
      },
    });
    expect(JSON.stringify(server.requests[0]?.body)).not.toContain("contextMaxCharacters");
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
      { query: "Effect TypeScript", numResults: 20, type: "deep", livecrawl: "preferred" },
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
    expect(JSON.stringify(server.requests[0]?.body)).not.toContain("numResults");
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Warning: Parallel ignores: numResults, type, livecrawl.\n\nparallel results",
        },
      ],
      details: {
        provider: "parallel",
        warnings: ["Parallel ignores: numResults, type, livecrawl."],
      },
      structuredContent: {
        provider: "parallel",
        content: "parallel results",
        warnings: ["Parallel ignores: numResults, type, livecrawl."],
      },
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
      return new Response(mcpResult("x".repeat(51 * 1024)));
    };

    try {
      const failure: unknown = await executeSearch(
        "exa",
        { fetch, exaApiKey: redactWebSearchApiKey(secret) },
        { query: "spill failure" },
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
      { query: "many results" },
    );
    const path = result.details.truncation?.fullOutputPath;
    if (path === undefined) throw new Error("Expected search result spill");
    spillDirectories.push(dirname(path));

    expect(result.details).toMatchObject({ provider: "exa", truncation: { fullOutputPath: path } });
    const visible = result.content[0];
    if (visible?.type !== "text") throw new Error("Expected text search result");
    expect(Buffer.byteLength(visible.text)).toBeLessThanOrEqual(50 * 1024);
    expect(await readFile(path, "utf8")).toBe(complete);
    expect(result.details).not.toHaveProperty("warnings");
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

  describe("ignored-parameter warnings", () => {
    async function search(
      provider: SearchProvider,
      parameters: Parameters<typeof executeSearch>[2],
    ) {
      const server = await startServer(() => ({ body: mcpResult("results") }));
      const result = await executeSearch(
        provider,
        { exaUrl: `${server.baseUrl}/exa`, parallelUrl: `${server.baseUrl}/parallel` },
        parameters,
      );
      const text = result.content[0];
      if (text?.type !== "text") throw new Error("Expected text search result");
      return { result, text: text.text, requests: server.requests };
    }

    test("Parallel names every supplied parameter it ignores in a stable order", async () => {
      const { result, text } = await search("parallel", {
        query: "q",
        contextMaxCharacters: 100,
        type: "deep",
        livecrawl: "preferred",
        numResults: 5,
      });
      const warnings = ["Parallel ignores: numResults, type, livecrawl, contextMaxCharacters."];
      expect(text).toBe(`Warning: ${warnings[0]}\n\nresults`);
      expect(result.details).toEqual({ provider: "parallel", warnings });
      expect(result.structuredContent).toEqual({
        provider: "parallel",
        content: "results",
        warnings,
      });
      expect(Value.Check(WebSearchOutputSchema, result.structuredContent)).toBe(true);
    });

    test("Parallel warns about only the parameters that were supplied", async () => {
      const { result } = await search("parallel", { query: "q", type: "fast", numResults: 2 });
      expect(result.details.warnings).toEqual(["Parallel ignores: numResults, type."]);
    });

    test("Exa ignores every optional parameter except numResults", async () => {
      const { result, text, requests } = await search("exa", {
        query: "q",
        numResults: 4,
        type: "fast",
        contextMaxCharacters: 50,
      });
      expect(text).toBe("Warning: Exa ignores: type, contextMaxCharacters.\n\nresults");
      expect(result.details.warnings).toEqual(["Exa ignores: type, contextMaxCharacters."]);
      expect(result.structuredContent).toMatchObject({
        warnings: ["Exa ignores: type, contextMaxCharacters."],
      });
      // The request is unchanged: Exa still receives every supplied control.
      expect(requests[0]).toMatchObject({
        body: { params: { arguments: { numResults: 4, type: "fast", contextMaxCharacters: 50 } } },
      });
    });

    test("adds no warning when only the query is supplied", async () => {
      for (const provider of ["exa", "parallel"] as const) {
        const { result, text } = await search(provider, { query: "q" });
        expect(text).toBe("results");
        expect(result.details).toEqual({ provider });
        expect(result.structuredContent).toEqual({ provider, content: "results" });
        expect(result.details).not.toHaveProperty("warnings");
        expect(result.structuredContent).not.toHaveProperty("warnings");
      }
    });

    test("adds no Exa warning when only numResults is supplied", async () => {
      const { result, text } = await search("exa", { query: "q", numResults: 3 });
      expect(text).toBe("results");
      expect(result.details).toEqual({ provider: "exa" });
      expect(result.structuredContent).toEqual({ provider: "exa", content: "results" });
    });

    test("keeps the warning inside the model-visible output limits", async () => {
      const complete = Array.from({ length: 2_100 }, (_, index) => `result ${index}`).join("\n");
      const server = await startServer(() => ({ body: mcpResult(complete) }));
      const result = await executeSearch(
        "parallel",
        { exaUrl: `${server.baseUrl}/exa`, parallelUrl: `${server.baseUrl}/parallel` },
        { query: "q", numResults: 3 },
      );
      const path = result.details.truncation?.fullOutputPath;
      if (path === undefined) throw new Error("Expected search result spill");
      spillDirectories.push(dirname(path));
      const visible = result.content[0];
      if (visible?.type !== "text") throw new Error("Expected text search result");
      const warning = "Warning: Parallel ignores: numResults.";
      expect(visible.text.startsWith(`${warning}\n\nresult 0`)).toBe(true);
      // The spill holds the complete model-visible text, warning included.
      expect(await readFile(path, "utf8")).toBe(`${warning}\n\n${complete}`);
      // 2,100 result lines + the warning line + the blank separator.
      expect(result.details.truncation?.totalLines).toBe(2_102);
      expect(visible.text.split("\n").length).toBeLessThanOrEqual(2_000);
      expect(Buffer.byteLength(visible.text)).toBeLessThanOrEqual(50 * 1024);
      expect(result.structuredContent).toMatchObject({ content: complete });
    });

    test("describes each parameter's provider support in static schema text", () => {
      const { properties }: { properties: Record<string, { description?: string }> } = JSON.parse(
        JSON.stringify(createWebSearchTool().parameters),
      );
      const descriptions = Object.fromEntries(
        Object.entries(properties).map(([name, schema]) => [name, schema.description]),
      );
      expect(descriptions.numResults).toBe(
        "Number of results (default: 8, maximum: 20). Honored by Exa; Parallel ignores it.",
      );
      for (const parameter of ["type", "livecrawl", "contextMaxCharacters"]) {
        expect(descriptions[parameter]).toMatch(/Currently ignored by both Search Providers\.$/);
      }
    });
  });
});
