import { toToolContext } from "./tool-context.js";
import { readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";
import {
  createWebFetchTool,
  WEB_FETCH_DEFAULT_TIMEOUT_SECONDS,
  WEB_FETCH_MAX_RESPONSE_BYTES,
  WebFetchOutputSchema,
  type WebFetchToolOptions,
} from "../src/web-fetch.js";
import { WEB_TOOL_STRUCTURED_MAX_BYTES } from "../src/web-tool-output.js";
import { TROUBLESHOOTING_HINT } from "../src/troubleshooting-skill.js";
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
  return definition.execute(
    "fetch-call",
    parameters,
    signal,
    undefined,
    toToolContext(runner.createContext()),
  );
}

async function failureMessage(execution: Promise<unknown>): Promise<string> {
  try {
    await execution;
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Expected Web Fetch to fail");
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
      structuredContent: {
        url: `${server.baseUrl}/target`,
        content_type: "text/plain",
        format: "text",
        content: "redirected",
        truncated: false,
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

    const invalid = await executeFetch({ fetch }, { url: "file:///etc/passwd" }).catch(
      (cause: unknown) => cause,
    );
    expect(String(invalid)).toContain(
      "Unable to fetch file:///etc/passwd: unsupported URL scheme file: (Web Fetch requires an HTTP or HTTPS URL)",
    );
    expect(String(invalid)).not.toContain(TROUBLESHOOTING_HINT);
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
    "rejects unsupported MIME %s with a local-conversion suggestion and no hint",
    async (contentType) => {
      const fetch: typeof globalThis.fetch = async () =>
        new Response("binary", { headers: { "content-type": `${contentType}; charset=binary` } });
      expect(
        await failureMessage(
          executeFetch({ fetch }, { url: "https://example.com/file", format: "html" }),
        ),
      ).toBe(
        `Unable to fetch https://example.com/file: unsupported content type ${contentType} (Web Fetch returns text only; for a document such as a PDF, download it and convert it to text locally)`,
      );
    },
  );

  test("uses the standard HTTP phrase, not server-supplied text, and bounds the content type", async () => {
    const hostile = "x".repeat(5_000);
    const statusFetch: typeof globalThis.fetch = async () =>
      new Response("no", { status: 404, statusText: hostile });
    expect(
      await failureMessage(executeFetch({ fetch: statusFetch }, { url: "https://example.com/a" })),
    ).toBe("Unable to fetch https://example.com/a: HTTP 404 Not Found");

    const typeFetch: typeof globalThis.fetch = async () =>
      new Response("x", { headers: { "content-type": `application/${hostile}` } });
    const message = await failureMessage(
      executeFetch({ fetch: typeFetch }, { url: "https://example.com/b" }),
    );
    expect(message).toContain(`application/${"x".repeat(100 - "application/".length)}…`);
    expect(message.length).toBeLessThan(400);
  });

  test("rejects an unparseable URL with a reason and no hint", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error("transport must not run");
    };
    expect(await failureMessage(executeFetch({ fetch }, { url: "not a url" }))).toBe(
      "Unable to fetch not a url: invalid URL (expected an absolute HTTP or HTTPS URL)",
    );
  });

  test("rejects invalid parameters with a reason and no hint", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error("transport must not run");
    };
    expect(
      await failureMessage(executeFetch({ fetch }, { url: "https://example.com", timeout: -1 })),
    ).toBe(
      "Unable to fetch requested URL: invalid parameters (expected a url string with optional format and timeout)",
    );
  });

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
    ).rejects.toThrow(
      "Unable to fetch https://example.com/declared: response body exceeds the 5 MiB limit",
    );

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
    ).rejects.toThrow(
      "Unable to fetch https://example.com/streamed: response body exceeds the 5 MiB limit",
    );
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
    const message = await failureMessage(
      executeFetch({ fetch }, { url: "https://user:password@example.com/private" }),
    );
    expect(message).toBe("Unable to fetch https://example.com/private: HTTP 403 Forbidden");
    expect(calls).toBe(1);
  });

  test.each<[string, typeof globalThis.fetch]>([
    ["an HTTP error", async () => new Response("no", { status: 502 })],
    [
      "a network error",
      async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo user:password@example.com"), {
            code: "ENOTFOUND",
          }),
        });
      },
    ],
    [
      "an unsupported type",
      async () => new Response("x", { headers: { "content-type": "application/pdf" } }),
    ],
    ["a size limit", async () => new Response("x", { headers: { "content-length": "9999999" } })],
    [
      "a timeout",
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    ],
  ])("never leaks URL userinfo through %s", async (_name, respond) => {
    const message = await failureMessage(
      executeFetch(
        { fetch: respond },
        { url: "https://user:password@example.com/private", timeout: 0.01 },
      ),
    );
    expect(message).toContain("Unable to fetch https://example.com/private: ");
    expect(message).not.toContain("password");
    expect(message).not.toContain("user:");
  });

  test("names the network error class of a refused connection and points to the Skill", async () => {
    // Reserve a free port by listening on it, then close the listener so nothing accepts there.
    // Another process could claim the port in the gap; that is unlikely enough for a local test.
    const server = await startServer(() => undefined);
    const closed = server.baseUrl;
    await Promise.all(
      servers.splice(0).map(
        (listening) =>
          new Promise<void>((resolveClose) => {
            listening.close(() => resolveClose());
          }),
      ),
    );
    expect(await failureMessage(executeFetch({}, { url: `${closed}/refused` }))).toBe(
      `Unable to fetch ${closed}/refused: network error ECONNREFUSED\n\n${TROUBLESHOOTING_HINT}`,
    );
  });

  test("names an unresolved host from the transport's cause code", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND missing.invalid"), {
          code: "ENOTFOUND",
        }),
      });
    };
    expect(
      await failureMessage(executeFetch({ fetch }, { url: "https://missing.invalid/page" })),
    ).toBe(
      `Unable to fetch https://missing.invalid/page: network error ENOTFOUND\n\n${TROUBLESHOOTING_HINT}`,
    );
  });

  test("reports a stream that fails mid-body as a network error", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("socket hang up"));
          },
        }),
        { headers: { "content-type": "text/plain" } },
      );
    expect(await failureMessage(executeFetch({ fetch }, { url: "https://example.com/cut" }))).toBe(
      `Unable to fetch https://example.com/cut: network error while reading the response body\n\n${TROUBLESHOOTING_HINT}`,
    );
  });

  test.each([
    [400, "Bad Request", false],
    [403, "Forbidden", false],
    [404, "Not Found", false],
    [410, "Gone", false],
    [429, "Too Many Requests", false],
    [500, "Internal Server Error", true],
    [503, "Service Unavailable", true],
  ])(
    "reports HTTP %i and points to the Skill only when diagnosable: %s",
    async (status, statusText, hinted) => {
      const fetch: typeof globalThis.fetch = async () =>
        new Response("failure", { status, statusText });
      const cause = `HTTP ${status} ${statusText}`;
      expect(
        await failureMessage(executeFetch({ fetch }, { url: "https://example.com/page" })),
      ).toBe(
        hinted
          ? `Unable to fetch https://example.com/page: ${cause}\n\n${TROUBLESHOOTING_HINT}`
          : `Unable to fetch https://example.com/page: ${cause}`,
      );
    },
  );

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
    expect(await failureMessage(cancelled)).toBe(
      `Unable to fetch ${server.baseUrl}/cancel: request cancelled`,
    );

    expect(
      await failureMessage(
        executeFetch({}, { url: `${server.baseUrl}/timeout`, format: "text", timeout: 0.01 }),
      ),
    ).toBe(
      `Unable to fetch ${server.baseUrl}/timeout: timed out after 0.01 seconds\n\n${TROUBLESHOOTING_HINT}`,
    );
    expect(WEB_FETCH_DEFAULT_TIMEOUT_SECONDS).toBe(30);
  });

  test("translates HTML conversion failures at the tool boundary", async () => {
    const deeplyNestedHtml = `${"<div>".repeat(4_000)}content${"</div>".repeat(4_000)}`;
    const fetch: typeof globalThis.fetch = async () =>
      new Response(deeplyNestedHtml, { headers: { "content-type": "text/html" } });

    const message = await failureMessage(
      executeFetch({ fetch }, { url: "https://example.com/deep", format: "markdown" }),
    );
    expect(message).toBe("Unable to fetch https://example.com/deep: unexpected RangeError");
  }, 15000);

  test("extracts text from deeply nested HTML", async () => {
    const deeplyNestedHtml = `${"<div>".repeat(4_000)}content<script>omitted()</script>${"</div>".repeat(4_000)}`;
    const fetch: typeof globalThis.fetch = async () =>
      new Response(deeplyNestedHtml, { headers: { "content-type": "text/html" } });

    const result = await executeFetch(
      { fetch },
      { url: "https://example.com/deep", format: "text" },
    );

    expect(result.content[0]).toMatchObject({ type: "text", text: "content" });
  }, 15000);

  test("reports a failed output spill as itself, not as a network error", async () => {
    const originalTmpdir = process.env["TMPDIR"];
    const missing = join(tmpdir(), `pi-web-tools-missing-${process.pid}`, "nested");
    process.env["TMPDIR"] = missing;
    try {
      const fetch: typeof globalThis.fetch = async () =>
        new Response("x".repeat(60 * 1024), { headers: { "content-type": "text/plain" } });
      const message = await failureMessage(
        executeFetch({ fetch }, { url: "https://example.com/spill", format: "text" }),
      );
      expect(message).toContain("ENOENT");
      expect(message).not.toContain("network error");
      expect(message).not.toContain("Unable to fetch");
      expect(message).not.toContain(TROUBLESHOOTING_HINT);
    } finally {
      if (originalTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = originalTmpdir;
    }
  });

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
    // Scripts receive the complete converted text, not the 50 KiB the model sees.
    expect(result.structuredContent).toMatchObject({
      content: expect.stringContaining("paragraph 2099"),
      truncated: false,
      full_output_path: path,
    });
    expect(Value.Check(WebFetchOutputSchema, result.structuredContent)).toBe(true);
  });

  test("bounds script content at 1 MiB on a character boundary and keeps the spill complete", async () => {
    // "é" is two bytes, so the limit falls inside a character when the text starts with "a".
    const body = `a${"é".repeat(700_000)}`;
    const fetch: typeof globalThis.fetch = async () =>
      new Response(body, { headers: { "content-type": "text/plain" } });
    const result = await executeFetch(
      { fetch },
      { url: "https://example.com/huge", format: "text" },
    );
    const path = result.details.truncation?.fullOutputPath;
    if (path === undefined) throw new Error("Expected Web Fetch spill");
    spillDirectories.push(dirname(path));

    expect(Value.Check(WebFetchOutputSchema, result.structuredContent)).toBe(true);
    const structured = Value.Parse(WebFetchOutputSchema, result.structuredContent);
    expect(structured.truncated).toBe(true);
    expect(structured.full_output_path).toBe(path);
    const content = structured.content;
    expect(Buffer.byteLength(content)).toBe(WEB_TOOL_STRUCTURED_MAX_BYTES - 1);
    expect(content).not.toContain("\uFFFD");
    expect(body.startsWith(content)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(body);
  });

  test("returns small pages unspilled with no full output path", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response("tiny", { headers: { "content-type": "text/plain" } });
    const result = await executeFetch(
      { fetch },
      { url: "https://example.com/tiny", format: "text" },
    );
    expect(result.structuredContent).toEqual({
      url: "https://example.com/tiny",
      content_type: "text/plain",
      format: "text",
      content: "tiny",
      truncated: false,
    });
  });
});
