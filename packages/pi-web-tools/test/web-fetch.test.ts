import { readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createWebFetchTool,
  WEB_FETCH_DEFAULT_TIMEOUT_SECONDS,
  WEB_FETCH_MAX_RESPONSE_BYTES,
  type WebFetchToolOptions,
} from "../src/web-fetch.js";
import { createWebToolsTestRunner } from "./web-tools-test-harness.js";

type ServedResponse = {
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
};

type ServedRequest = {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly path: string;
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
  respond: (request: ServedRequest) => ServedResponse | undefined,
): Promise<{ readonly baseUrl: string; readonly requests: ServedRequest[] }> {
  const requests: ServedRequest[] = [];
  const server = createServer((request, response) => {
    const servedRequest = { path: request.url ?? "", headers: request.headers };
    requests.push(servedRequest);
    const result = respond(servedRequest);
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

async function executeFetch(
  options: WebFetchToolOptions,
  parameters: {
    readonly url: string;
    readonly format?: "text" | "markdown" | "html";
    readonly timeout?: number;
  },
  signal?: AbortSignal,
) {
  const definition = createWebFetchTool(options);
  const runner = await createWebToolsTestRunner((pi) => pi.registerTool(definition));
  expect(runner.getToolDefinition("web_fetch")).toBe(definition);
  return definition.execute("fetch-call", parameters, signal, undefined, runner.createContext());
}

describe("Web Fetch", () => {
  test("preserves ordinary HTTP, allows localhost, and reports a redirect's final URL", async () => {
    const server = await startServer(({ path }) =>
      path === "/redirect"
        ? { body: "", status: 302, headers: { location: "/target" } }
        : { body: "redirected", headers: { "content-type": "text/plain" } },
    );
    const result = await executeFetch({}, { url: `${server.baseUrl}/redirect`, format: "text" });

    expect(result).toEqual({
      content: [{ type: "text", text: "redirected" }],
      details: {
        url: `${server.baseUrl}/target`,
        contentType: "text/plain",
        format: "text",
      },
    });
    expect(server.requests.map(({ path }) => path)).toEqual(["/redirect", "/target"]);
  });

  test("accepts HTTPS syntax and rejects non-HTTP schemes before transport", async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      calls.push(new Request(input).url);
      return new Response("secure", { headers: { "content-type": "text/plain" } });
    };
    const https = await executeFetch({ fetch }, { url: "https://example.com/path" });
    expect(https.content).toEqual([{ type: "text", text: "secure" }]);
    expect(https.details.format).toBe("markdown");
    expect(calls).toEqual(["https://example.com/path"]);

    await expect(executeFetch({ fetch }, { url: "file:///etc/passwd" })).rejects.toThrow(
      "Unable to fetch file:///etc/passwd",
    );
    expect(calls).toHaveLength(1);
  });

  test("sends format-weighted headers and converts HTML without active content", async () => {
    const html =
      "<h1>Hello</h1><script>bad()</script><p>world <strong>wide</strong></p><style>.bad{}</style><noscript>hidden</noscript>";
    const server = await startServer(() => ({
      body: html,
      headers: { "content-type": "Text/HTML; charset=utf-8" },
    }));

    const markdown = await executeFetch({}, { url: server.baseUrl, format: "markdown" });
    const text = await executeFetch({}, { url: server.baseUrl, format: "text" });
    const raw = await executeFetch({}, { url: server.baseUrl, format: "html" });

    expect(markdown.content).toEqual([
      { type: "text", text: "# Hello\n\nworld **wide**\n\nhidden" },
    ]);
    expect(text.content).toEqual([{ type: "text", text: "Helloworld wide" }]);
    expect(raw.content).toEqual([{ type: "text", text: html }]);
    expect(server.requests[0]?.headers.accept).toContain("text/markdown;q=1.0");
    expect(server.requests[1]?.headers.accept).toContain("text/plain;q=1.0");
    expect(server.requests[2]?.headers.accept).toContain("text/html;q=1.0");
    expect(server.requests[0]?.headers["accept-language"]).toBe("en-US,en;q=0.9");
    expect(server.requests[0]?.headers["user-agent"]).toContain("Mozilla/5.0");
  });

  test.each([
    [undefined, "absent"],
    ["text/plain", "plain"],
    ["text/markdown", "markdown"],
    ["application/json", '{"ok":true}'],
    ["application/problem+json", '{"error":true}'],
    ["application/xml", "<ok/>"],
    ["application/problem+xml", "<error/>"],
    ["application/javascript", "const ok = true;"],
    ["application/x-javascript", "var ok = true;"],
    ["image/svg+xml", "<svg/>"],
  ])("returns accepted textual MIME %s unchanged", async (contentType, body) => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        contentType === undefined ? new TextEncoder().encode(body) : body,
        contentType === undefined ? {} : { headers: { "content-type": contentType } },
      );
    const result = await executeFetch(
      { fetch },
      { url: "https://example.com", format: "markdown" },
    );
    expect(result.content).toEqual([{ type: "text", text: body }]);
    expect(result.details.contentType).toBe(contentType ?? "");
  });

  test.each(["image/png", "application/pdf", "application/octet-stream"])(
    "rejects unsupported MIME %s",
    async (contentType) => {
      const fetch: typeof globalThis.fetch = async () =>
        new Response("binary", { headers: { "content-type": contentType } });
      await expect(
        executeFetch({ fetch }, { url: "https://example.com/file", format: "html" }),
      ).rejects.toThrow("Unable to fetch https://example.com/file");
    },
  );

  test("rejects declared and streamed bodies above 5 MiB and cancels overflow", async () => {
    let cancelled = false;
    const declaredFetch: typeof globalThis.fetch = async () =>
      new Response("small", {
        headers: {
          "content-type": "text/plain",
          "content-length": String(WEB_FETCH_MAX_RESPONSE_BYTES + 1),
        },
      });
    await expect(
      executeFetch({ fetch: declaredFetch }, { url: "https://example.com/declared" }),
    ).rejects.toThrow("Unable to fetch https://example.com/declared");

    const streamedFetch: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/plain" } },
      );
    await expect(
      executeFetch({ fetch: streamedFetch }, { url: "https://example.com/streamed" }),
    ).rejects.toThrow("Unable to fetch https://example.com/streamed");
    expect(cancelled).toBe(true);
  });

  test("shares one deadline across exactly one Cloudflare challenge retry", async () => {
    let calls = 0;
    const signals: AbortSignal[] = [];
    const userAgents: string[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      calls++;
      if (init?.signal !== undefined && init.signal !== null) signals.push(init.signal);
      userAgents.push(new Headers(init?.headers).get("user-agent") ?? "");
      return calls === 1
        ? new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } })
        : new Response("ok", { headers: { "content-type": "text/plain" } });
    };

    const result = await executeFetch({ fetch }, { url: "https://example.com", format: "text" });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(userAgents).toEqual([expect.stringContaining("Mozilla/5.0"), "pi-web-tools"]);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
  });

  test("does not retry ordinary failures and redacts URL userinfo", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      return new Response("forbidden", { status: 403 });
    };
    await expect(
      executeFetch({ fetch }, { url: "https://user:password@example.com/private" }),
    ).rejects.toThrow("Unable to fetch https://example.com/private");
    expect(calls).toBe(1);
  });

  test("honors caller cancellation and custom timeouts", async () => {
    const server = await startServer(() => undefined);
    const controller = new AbortController();
    const cancelled = executeFetch(
      {},
      { url: `${server.baseUrl}/cancel`, format: "text" },
      controller.signal,
    );
    while (server.requests.length === 0)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
    controller.abort();
    await expect(cancelled).rejects.toThrow(`Unable to fetch ${server.baseUrl}/cancel`);

    await expect(
      executeFetch({}, { url: `${server.baseUrl}/timeout`, format: "text", timeout: 0.01 }),
    ).rejects.toThrow(`Unable to fetch ${server.baseUrl}/timeout`);
    expect(WEB_FETCH_DEFAULT_TIMEOUT_SECONDS).toBe(30);
  });

  test("translates HTML conversion failures at the tool boundary", async () => {
    const deeplyNestedHtml = `${"<div>".repeat(10_000)}content${"</div>".repeat(10_000)}`;
    const fetch: typeof globalThis.fetch = async () =>
      new Response(deeplyNestedHtml, { headers: { "content-type": "text/html" } });

    await expect(
      executeFetch({ fetch }, { url: "https://example.com/deep", format: "markdown" }),
    ).rejects.toThrow("Unable to fetch https://example.com/deep");
  }, 15000);

  test("truncates complete converted output to a private spill", async () => {
    const paragraphs = Array.from(
      { length: 2_100 },
      (_, index) => `<p>paragraph ${index}</p>`,
    ).join("");
    const fetch: typeof globalThis.fetch = async () =>
      new Response(paragraphs, { headers: { "content-type": "text/html" } });
    const result = await executeFetch(
      { fetch },
      { url: "https://example.com/large", format: "markdown" },
    );
    const path = result.details.truncation?.fullOutputPath;
    if (path === undefined) throw new Error("Expected Web Fetch spill");
    spillDirectories.push(dirname(path));

    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(path) });
    expect(await readFile(path, "utf8")).toContain("paragraph 2099");
  });
});
