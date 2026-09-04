import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createWebSearchTool,
  redactWebSearchApiKey,
  selectSearchProvider,
  WEB_SEARCH_TIMEOUT_MS,
  type SearchProvider,
  type WebSearchToolOptions,
} from "../src/web-search.js";
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
    runner.createContext(),
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
      content: [{ type: "text", text: "exa results" }],
      details: { provider: "exa" },
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
      body: `data: [DONE]\nevent: message\ndata: ${mcpResult("parallel results")}\n\n`,
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
      content: [{ type: "text", text: "parallel results" }],
      details: { provider: "parallel" },
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
    ).rejects.toThrow("Unable to search the web for status failure");
    expect(server.requests).toHaveLength(1);
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
    await expect(pending).rejects.toThrow("Unable to search the web for cancel me");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    expect(stalledClosed).toBe(true);

    const oversized = await startServer(() => ({ body: "x".repeat(256 * 1024 + 1) }));
    await expect(
      executeSearch(
        "parallel",
        { exaUrl: `${oversized.baseUrl}/exa`, parallelUrl: `${oversized.baseUrl}/parallel` },
        { query: "too much" },
      ),
    ).rejects.toThrow("Unable to search the web for too much");
    expect(oversized.requests).toHaveLength(1);
  });

  test("translates private spill failures without leaking credentials", async () => {
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
      expect(String(failure)).toContain("Unable to search the web for spill failure");
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
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await readFile(path, "utf8")).not.toContain(secret);
  });
});
