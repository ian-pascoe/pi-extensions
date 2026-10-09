import { toToolContext } from "./tool-context.js";
import { readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
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
    readonly offset?: number;
    readonly limit?: number;
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

function resultText(result: Awaited<ReturnType<typeof executeFetch>>): string {
  const part = result.content[0];
  if (part?.type !== "text") throw new Error("Expected text result");
  return part.text;
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
        structured_truncated: false,
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
    expect(text.content).toEqual([{ type: "text", text: "Hello\n\nworld wide" }]);
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

  describe("line window", () => {
    const numbered = (count: number) =>
      Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
    const fetchPlain =
      (body: string): typeof globalThis.fetch =>
      async () =>
        new Response(body, { headers: { "content-type": "text/plain" } });

    test("returns the page unchanged, with no note, when offset and limit are omitted", async () => {
      const result = await executeFetch(
        { fetch: fetchPlain(numbered(5)) },
        { url: "https://example.com/w", format: "text" },
      );
      expect(resultText(result)).toBe(numbered(5));
    });

    test("reads limit lines from a 1-indexed offset and says how many remain and where to continue", async () => {
      const result = await executeFetch(
        { fetch: fetchPlain(numbered(100)) },
        { url: "https://example.com/w", format: "text", offset: 11, limit: 20 },
      );
      const expected = `${Array.from({ length: 20 }, (_, index) => `line ${index + 11}`).join("\n")}\n\n[Showing lines 11-30 of 100. 70 lines remain. Use offset=31 to continue.]`;
      expect(resultText(result)).toBe(expected);
      // Scripts receive the window text, without the note.
      expect(Value.Parse(WebFetchOutputSchema, result.structuredContent).content).toBe(
        Array.from({ length: 20 }, (_, index) => `line ${index + 11}`).join("\n"),
      );
      expect(result.details.truncation).toBeUndefined();
    });

    test("treats a limit without an offset as starting at line 1", async () => {
      const result = await executeFetch(
        { fetch: fetchPlain(numbered(10)) },
        { url: "https://example.com/w", format: "text", limit: 3 },
      );
      expect(resultText(result)).toBe(
        "line 1\nline 2\nline 3\n\n[Showing lines 1-3 of 10. 7 lines remain. Use offset=4 to continue.]",
      );
    });

    test("adds no note when the window reaches the end of the page", async () => {
      const toEnd = await executeFetch(
        { fetch: fetchPlain(numbered(10)) },
        { url: "https://example.com/w", format: "text", offset: 8 },
      );
      expect(resultText(toEnd)).toBe("line 8\nline 9\nline 10");
      const exact = await executeFetch(
        { fetch: fetchPlain(numbered(10)) },
        { url: "https://example.com/w", format: "text", offset: 9, limit: 2 },
      );
      expect(resultText(exact)).toBe("line 9\nline 10");
    });

    test("fails with the line count when offset is past the end", async () => {
      const message = await failureMessage(
        executeFetch(
          { fetch: fetchPlain(numbered(10)) },
          { url: "https://example.com/w", format: "text", offset: 11 },
        ),
      );
      expect(message).toBe(
        "Unable to fetch https://example.com/w: Offset 11 is beyond end of content (10 lines total)",
      );
      expect(message).not.toContain(TROUBLESHOOTING_HINT);
    });

    test("windows the converted Markdown, not the source HTML", async () => {
      const html = `<html><body><main>${Array.from({ length: 50 }, (_, index) => `<p>para ${index + 1}</p>`).join("")}</main></body></html>`;
      const fetch: typeof globalThis.fetch = async () =>
        new Response(html, { headers: { "content-type": "text/html" } });
      const whole = await executeFetch({ fetch }, { url: "https://example.com/h" });
      const converted = resultText(whole).split("\n");
      const windowed = await executeFetch(
        { fetch },
        { url: "https://example.com/h", offset: 3, limit: 4 },
      );
      expect(resultText(windowed)).toBe(
        `${converted.slice(2, 6).join("\n")}\n\n[Showing lines 3-6 of ${converted.length}. ${converted.length - 6} lines remain. Use offset=7 to continue.]`,
      );
      // format: html windows the unconverted page.
      const rawHtml = await executeFetch(
        { fetch },
        { url: "https://example.com/h", format: "html", offset: 1, limit: 1 },
      );
      expect(resultText(rawHtml)).toBe(`${html}`);
    });

    /** Last visible content line number, the note's range, and its next offset, read from the output. */
    const continuation = (visible: string) => {
      const note =
        /\[Showing lines (\d+)-(\d+) of (\d+)\. (\d+) lines? remains?\. Use offset=(\d+) to continue\.\]$/.exec(
          visible,
        );
      if (note === null) throw new Error(`No continuation note in ${visible.slice(-200)}`);
      const [first = 0, last = 0, total = 0, remaining = 0, next = 0] = note.slice(1).map(Number);
      const shown = visible
        .split("\n")
        .filter((line) => /^line \d+$/.test(line))
        .map((line) => Number(line.slice(5)));
      return { first, last, total, remaining, next, shown };
    };

    test("names the next unseen line when the window is cut at the output budget", async () => {
      const page = numbered(5_000);
      const result = await executeFetch(
        { fetch: fetchPlain(page) },
        { url: "https://example.com/w", format: "text", offset: 11, limit: 3_000 },
      );
      const path = result.details.truncation?.fullOutputPath;
      if (path === undefined) throw new Error("Expected Web Fetch spill");
      spillDirectories.push(dirname(path));
      const visible = resultText(result);
      const note = continuation(visible);

      // The model saw fewer than the 3,000 requested lines, and the note says exactly which.
      expect(note.shown.length).toBeLessThan(3_000);
      expect(note.shown[0]).toBe(11);
      expect(note.last).toBe(note.shown.at(-1));
      expect(note.next).toBe(note.last + 1);
      expect(note.total).toBe(5_000);
      expect(note.remaining).toBe(5_000 - note.last);
      expect(visible.split("\n").length).toBeLessThanOrEqual(2_000);
      expect(Buffer.byteLength(visible)).toBeLessThanOrEqual(50 * 1024);
      expect(visible).toContain(`Full output saved to: ${path}`);
      expect(result.details.truncation).toMatchObject({ totalLines: 3_000 });
      // The spill holds exactly the requested window, without the note.
      expect(await readFile(path, "utf8")).toBe(
        Array.from({ length: 3_000 }, (_, index) => `line ${index + 11}`).join("\n"),
      );
      expect(result.structuredContent).toMatchObject({
        truncated: true,
        full_output_path: path,
        total_lines: 5_000,
        next_offset: 3_011,
      });
    });

    test("continues past what the model saw, for an offset alone and for no window at all", async () => {
      for (const parameters of [{ offset: 5 }, {}]) {
        const result = await executeFetch(
          { fetch: fetchPlain(numbered(5_000)) },
          { url: "https://example.com/w", format: "text", ...parameters },
        );
        const path = result.details.truncation?.fullOutputPath;
        if (path === undefined) throw new Error("Expected Web Fetch spill");
        spillDirectories.push(dirname(path));
        const note = continuation(resultText(result));
        expect(note.first).toBe(parameters.offset ?? 1);
        expect(note.shown[0]).toBe(note.first);
        expect(note.next).toBe(note.shown.at(-1)! + 1);
        expect(note.total).toBe(5_000);
      }
    });

    test("pages through a long page with the note's offsets and sees every line exactly once", async () => {
      const page = numbered(5_000);
      const seen: number[] = [];
      let offset: number | undefined;
      for (let pass = 0; pass < 10; pass++) {
        const result = await (offset === undefined
          ? executeFetch(
              { fetch: fetchPlain(page) },
              { url: "https://example.com/w", format: "text" },
            )
          : executeFetch(
              { fetch: fetchPlain(page) },
              { url: "https://example.com/w", format: "text", offset },
            ));
        const spill = result.details.truncation?.fullOutputPath;
        if (spill !== undefined) spillDirectories.push(dirname(spill));
        const visible = resultText(result);
        const lines = visible
          .split("\n")
          .filter((line) => /^line \d+$/.test(line))
          .map((line) => Number(line.slice(5)));
        seen.push(...lines);
        if (!/Use offset=\d+ to continue/.test(visible)) break;
        offset = continuation(visible).next;
      }
      expect(seen).toEqual(Array.from({ length: 5_000 }, (_, index) => index + 1));
    });

    test("tells scripts the total and the next offset only when a window was requested", async () => {
      const windowed = await executeFetch(
        { fetch: fetchPlain(numbered(100)) },
        { url: "https://example.com/w", format: "text", offset: 11, limit: 20 },
      );
      expect(windowed.structuredContent).toMatchObject({ total_lines: 100, next_offset: 31 });
      const toEnd = await executeFetch(
        { fetch: fetchPlain(numbered(100)) },
        { url: "https://example.com/w", format: "text", offset: 91 },
      );
      expect(toEnd.structuredContent).toMatchObject({ total_lines: 100 });
      expect(toEnd.structuredContent).not.toHaveProperty("next_offset");
      const whole = await executeFetch(
        { fetch: fetchPlain(numbered(100)) },
        { url: "https://example.com/w", format: "text" },
      );
      expect(whole.structuredContent).not.toHaveProperty("total_lines");
      expect(whole.structuredContent).not.toHaveProperty("next_offset");
      for (const result of [windowed, toEnd, whole]) {
        expect(Value.Check(WebFetchOutputSchema, result.structuredContent)).toBe(true);
      }
    });

    test("omits next_offset when script content was cut at 1 MiB, so scripts never skip lines", async () => {
      const page = Array.from({ length: 40_000 }, (_, index) => `${"é".repeat(30)} ${index}`).join(
        "\n",
      );
      const result = await executeFetch(
        { fetch: fetchPlain(page) },
        { url: "https://example.com/w", format: "text", limit: 39_000 },
      );
      const spill = result.details.truncation?.fullOutputPath;
      if (spill !== undefined) spillDirectories.push(dirname(spill));
      expect(result.structuredContent).toMatchObject({
        structured_truncated: true,
        total_lines: 40_000,
      });
      expect(result.structuredContent).not.toHaveProperty("next_offset");
    });

    test("says '1 line remains' for a single remaining line", async () => {
      const result = await executeFetch(
        { fetch: fetchPlain(numbered(3)) },
        { url: "https://example.com/w", format: "text", limit: 2 },
      );
      expect(resultText(result)).toContain("1 line remains. Use offset=3 to continue.");
    });

    test("describes the window in the static parameter schema", () => {
      const { properties }: { properties: Record<string, { description?: string }> } = JSON.parse(
        JSON.stringify(createWebFetchTool().parameters),
      );
      expect(Object.keys(properties)).toEqual(["url", "format", "timeout", "offset", "limit"]);
      expect(properties.offset?.description).toContain("1-indexed");
      expect(properties.limit?.description).toContain("lines");
    });
  });

  test("rejects invalid parameters with a reason and no hint", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error("transport must not run");
    };
    expect(
      await failureMessage(executeFetch({ fetch }, { url: "https://example.com", timeout: -1 })),
    ).toBe(
      "Unable to fetch requested URL: invalid parameters (expected a url string with optional format, timeout, offset, and limit)",
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
      truncated: true,
      structured_truncated: false,
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
    expect(structured.structured_truncated).toBe(true);
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
      structured_truncated: false,
    });
  });

  test("truncation fields never contradict: small, over 50 KiB, and over 1 MiB pages", async () => {
    const cases = [
      { name: "small", body: "tiny", truncated: false, structuredTruncated: false },
      { name: "medium", body: "word ".repeat(30_000), truncated: true, structuredTruncated: false },
      { name: "huge", body: "word ".repeat(250_000), truncated: true, structuredTruncated: true },
    ] as const;
    for (const { name, body, truncated, structuredTruncated } of cases) {
      const fetch: typeof globalThis.fetch = async () =>
        new Response(body, { headers: { "content-type": "text/plain" } });
      const result = await executeFetch(
        { fetch },
        { url: `https://example.com/${name}`, format: "text" },
      );
      const spill = result.details.truncation?.fullOutputPath;
      if (spill !== undefined) spillDirectories.push(dirname(spill));

      expect(Value.Check(WebFetchOutputSchema, result.structuredContent)).toBe(true);
      const structured = Value.Parse(WebFetchOutputSchema, result.structuredContent);
      expect(structured.truncated).toBe(truncated);
      expect(structured.structured_truncated).toBe(structuredTruncated);
      // `truncated` is true exactly when a spill file is named; a cut `content` is always spilled.
      expect(structured.full_output_path !== undefined).toBe(structured.truncated);
      expect(structured.full_output_path).toBe(spill);
      if (structured.structured_truncated) expect(structured.truncated).toBe(true);
      if (spill !== undefined) expect(await readFile(spill, "utf8")).toBe(body);
    }
  });
});

const NAVIGATION_PAGE = `<!doctype html><html><head><title>Guide to Widgets</title><style>.x{}</style></head>
<body>
<header><a href="/">SiteBrand Home</a></header>
<nav><ul><li><a href="/a">NavAlpha</a></li><li><a href="/b">NavBeta</a></li></ul></nav>
<main><h1>Widgets</h1><p>Widgets are small <strong>useful</strong> things.</p>
<nav><a href="#t">InPageToc</a></nav></main>
<aside>SidebarAds</aside>
<footer>FooterLegal</footer>
<script>trackingBeacon()</script>
</body></html>`;

const ARTICLE_PAGE = `<html><head><title>Blog Post Title</title></head><body>
<nav>NavAlpha</nav>
<div class="layout"><article><h2>Post Heading</h2><p>Post body text.</p></article></div>
<footer>FooterLegal</footer></body></html>`;

const CHROME_PAGE = `<html><head><title>Plain Page</title></head><body>
<header>SiteBrand Home</header><nav>NavAlpha</nav>
<div><h2>Content Heading</h2><p>Content body text.</p></div>
<section><header>Section Heading Block</header><p>Section text.</p></section>
<aside>SidebarAds</aside><footer>FooterLegal</footer></body></html>`;

const NO_CHROME_PAGE = `<html><head><title>Bare Page</title></head><body><h1>Bare</h1><p>Only content.</p></body></html>`;

async function fetchHtmlPage(html: string, format: "markdown" | "text" | "html"): Promise<string> {
  const fetch: typeof globalThis.fetch = async () =>
    new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  return resultText(await executeFetch({ fetch }, { url: "https://example.com/page", format }));
}

describe("Web Fetch JSON", () => {
  // The id is above 2^53, so a parse-and-print round trip would round it.
  const minified = JSON.stringify({
    info: { name: "requests", version: "2.32.3", id: 0 },
    releases: Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`2.${index}.0`, [{ size: index }]]),
    ),
  }).replace('"id":0', '"id":12345678901234567890');
  const fetchJson =
    (body: string, contentType = "application/json"): typeof globalThis.fetch =>
    async () =>
      new Response(body, { headers: { "content-type": contentType } });

  test.each(["markdown", "text"] as const)(
    "re-indents minified JSON for format %s without changing its values",
    async (format) => {
      const result = await executeFetch(
        { fetch: fetchJson(minified) },
        { url: "https://example.com/pypi/requests/json", format },
      );
      const output = resultText(result);
      expect(output.split("\n").length).toBeGreaterThan(100);
      expect(output.split("\n").slice(0, 6)).toEqual([
        "{",
        '  "info": {',
        '    "name": "requests",',
        '    "version": "2.32.3",',
        '    "id": 12345678901234567890',
        "  },",
      ]);
      expect(output.replace(/\s+/g, "")).toBe(minified);
      expect(Value.Parse(WebFetchOutputSchema, result.structuredContent).content).toBe(output);
      expect(result.details.contentType).toBe("application/json");
    },
  );

  test("pages through re-indented JSON with offset and limit", async () => {
    const fetch = fetchJson(minified);
    const whole = resultText(await executeFetch({ fetch }, { url: "https://example.com/j" })).split(
      "\n",
    );
    const first = await executeFetch({ fetch }, { url: "https://example.com/j", limit: 5 });
    expect(resultText(first)).toBe(
      `${whole.slice(0, 5).join("\n")}\n\n[Showing lines 1-5 of ${whole.length}. ${whole.length - 5} lines remain. Use offset=6 to continue.]`,
    );
    const structured = Value.Parse(WebFetchOutputSchema, first.structuredContent);
    expect(structured.total_lines).toBe(whole.length);
    expect(structured.next_offset).toBe(6);
    const next = await executeFetch(
      { fetch },
      { url: "https://example.com/j", offset: 6, limit: 5 },
    );
    expect(Value.Parse(WebFetchOutputSchema, next.structuredContent).content).toBe(
      whole.slice(5, 10).join("\n"),
    );
  });

  test("spills the re-indented JSON when it exceeds the output limit", async () => {
    const large = JSON.stringify(
      Array.from({ length: 5_000 }, (_, index) => ({ id: index, name: `item-${index}` })),
    );
    const result = await executeFetch(
      { fetch: fetchJson(large) },
      { url: "https://example.com/large", format: "text" },
    );
    const path = result.details.truncation?.fullOutputPath;
    if (path === undefined) throw new Error("Expected Web Fetch spill");
    spillDirectories.push(dirname(path));
    const reindented = JSON.stringify(JSON.parse(large), null, 2);
    expect(await readFile(path, "utf8")).toBe(reindented);
    expect(Value.Parse(WebFetchOutputSchema, result.structuredContent).content).toBe(reindented);
    expect(reindented.startsWith(resultText(result).split("\n\n[Output truncated")[0] ?? "")).toBe(
      true,
    );
  });

  test("normalises the indentation of already formatted JSON", async () => {
    const result = await executeFetch(
      {
        fetch: fetchJson(
          '{\n    "slideshow": {\n        "title": "Sample",\n        "slides": []\n    }\n}\n',
        ),
      },
      { url: "https://example.com/json" },
    );
    expect(resultText(result)).toBe(
      '{\n  "slideshow": {\n    "title": "Sample",\n    "slides": []\n  }\n}',
    );
  });

  test.each([
    "application/json; charset=utf-8",
    "text/json",
    "application/problem+json",
    "application/vnd.api+json",
    "Application/LD+JSON",
  ])("detects JSON served as %s", async (contentType) => {
    const result = await executeFetch(
      { fetch: fetchJson('{"a":[1]}', contentType) },
      { url: "https://example.com/j", format: "text" },
    );
    expect(resultText(result)).toBe('{\n  "a": [\n    1\n  ]\n}');
  });

  test.each([
    ["format html", "application/json", "html"],
    ["text/plain", "text/plain", "text"],
    ["no content type", undefined, "markdown"],
    ["JavaScript", "application/javascript", "text"],
  ] as const)("leaves JSON unchanged for %s", async (_name, contentType, format) => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        new TextEncoder().encode(minified),
        contentType === undefined ? {} : { headers: { "content-type": contentType } },
      );
    const result = await executeFetch({ fetch }, { url: "https://example.com/j", format });
    expect(resultText(result)).toBe(minified);
  });

  test.each([
    ["JSONP", 'callback({"a":1})'],
    ["anti-hijacking prefix", ')]}\'\n{"a":1}'],
    ["truncated", '{"a":[1,2'],
    ["empty", ""],
    ["too deeply nested", `${"[".repeat(5_000)}${"]".repeat(5_000)}`],
  ])("returns a JSON-typed body that cannot be re-indented unchanged: %s", async (_name, body) => {
    const result = await executeFetch(
      { fetch: fetchJson(body) },
      { url: "https://example.com/j", format: "text" },
    );
    expect(resultText(result)).toBe(body);
  });
});

describe("Web Fetch main content", () => {
  test.each(["markdown", "text"] as const)(
    "returns <main> without site chrome in %s format",
    async (format) => {
      const output = await fetchHtmlPage(NAVIGATION_PAGE, format);

      for (const chrome of [
        "SiteBrand",
        "NavAlpha",
        "NavBeta",
        "SidebarAds",
        "FooterLegal",
        "InPageToc",
      ]) {
        expect(output).not.toContain(chrome);
      }
      expect(output).not.toContain("trackingBeacon");
      expect(output).toContain("Guide to Widgets");
      expect(output).toContain("Widgets are small");
      expect(output).toContain("Site chrome outside the main content was removed");

      expect(
        output.startsWith(format === "markdown" ? "# Guide to Widgets" : "Guide to Widgets"),
      ).toBe(true);
    },
  );

  test("renders the main content as Markdown", async () => {
    expect(await fetchHtmlPage(NAVIGATION_PAGE, "markdown")).toBe(
      "# Guide to Widgets\n\n*Site chrome outside the main content was removed.*\n\n# Widgets\n\nWidgets are small **useful** things.",
    );
  });

  test("prefers [role=main] and skips a title the content already repeats", async () => {
    const html = `<html><head><title>Widgets</title></head><body><nav>NavAlpha</nav><div role="main"><h1>Widgets</h1><p>Body.</p></div></body></html>`;
    expect(await fetchHtmlPage(html, "markdown")).toBe(
      "*Site chrome outside the main content was removed.*\n\n# Widgets\n\nBody.",
    );
  });

  test.each(["markdown", "text"] as const)(
    "falls back to a single <article> in %s format",
    async (format) => {
      const output = await fetchHtmlPage(ARTICLE_PAGE, format);

      expect(output).toContain("Blog Post Title");
      expect(output).toContain("Post Heading");
      expect(output).toContain("Post body text.");
      expect(output).not.toContain("NavAlpha");
      expect(output).not.toContain("FooterLegal");
      expect(output).toContain("Site chrome outside the main content was removed");
    },
  );

  test("ignores several <article> elements and strips only page-level chrome", async () => {
    const html = `<html><head><title>Feed</title></head><body><nav>NavAlpha</nav>
<article><header>First Heading</header><p>First body.</p></article>
<article><header>Second Heading</header><p>Second body.</p></article><footer>FooterLegal</footer></body></html>`;
    const output = await fetchHtmlPage(html, "text");

    expect(output).toContain("First Heading");
    expect(output).toContain("Second body.");
    expect(output).not.toContain("NavAlpha");
    expect(output).not.toContain("FooterLegal");
  });

  test.each(["markdown", "text"] as const)(
    "strips nav, aside, and page-level header and footer when there is no main or article in %s format",
    async (format) => {
      const output = await fetchHtmlPage(CHROME_PAGE, format);

      for (const chrome of ["SiteBrand", "NavAlpha", "SidebarAds", "FooterLegal"]) {
        expect(output).not.toContain(chrome);
      }
      expect(output).toContain("Plain Page");
      expect(output).toContain("Content body text.");
      // A <header> inside a <section> is content, not site chrome.
      expect(output).toContain("Section Heading Block");
      expect(output).toContain("Site chrome outside the main content was removed");
    },
  );

  test("converts the whole page when nothing qualifies", async () => {
    const markdown = await fetchHtmlPage(NO_CHROME_PAGE, "markdown");
    expect(markdown).toContain("Only content.");
    expect(markdown).not.toContain("Site chrome outside the main content was removed");
    // Page that is only chrome keeps everything instead of returning nothing.
    const onlyNav = await fetchHtmlPage("<html><body><nav>OnlyNav</nav></body></html>", "text");
    expect(onlyNav).toContain("OnlyNav");
    // An unclosed <nav> never swallows the rest of the page.
    const unclosed = await fetchHtmlPage("<body><nav>Open<p>Real content", "text");
    expect(unclosed).toContain("Real content");
  });

  test.each(["markdown", "text"] as const)(
    "keeps a role=navigation content column that holds most of the text in %s format",
    async (format) => {
      const specification = Array.from(
        { length: 40 },
        (_, index) => `<h2>Section ${index}</h2><p>Specification paragraph ${index} body text.</p>`,
      ).join("");
      const html = `<html><head><title>Specification</title></head><body>
<div class="container"><div class="row">
<div class="col-lg-3" role="navigation" aria-label="Sidebar"><ul><li><a href="#s0">SidebarToc</a></li></ul></div>
<div class="col-lg-7" role="navigation" aria-label="Main">${specification}</div>
</div></div><footer>FooterLegal</footer></body></html>`;
      const output = await fetchHtmlPage(html, format);

      expect(output).toContain("Specification paragraph 0 body text.");
      expect(output).toContain("Specification paragraph 39 body text.");
      expect(output).not.toContain("SidebarToc");
      expect(output).not.toContain("FooterLegal");
      expect(output).toContain("Site chrome outside the main content was removed");
      expect(output).not.toContain("use format: html");
    },
  );

  test("converts the whole page when cutting chrome would remove most of the text", async () => {
    const links = (prefix: string) =>
      Array.from({ length: 80 }, (_, index) => `<li>${prefix} link ${index}</li>`).join("");
    const html = `<html><body><nav><ul>${links("Alpha")}</ul></nav>
<div role="navigation"><ul>${links("Gamma")}</ul></div><p>Short body.</p></body></html>`;
    const output = await fetchHtmlPage(html, "text");

    expect(output).toContain("Short body.");
    expect(output).toContain("Alpha link 0");
    expect(output).toContain("Gamma link 79");
    expect(output).not.toContain("Site chrome");
  });

  test.each(["markdown", "text"] as const)(
    "says how much text chrome removal dropped, and how to see it, in %s format",
    async (format) => {
      const links = Array.from(
        { length: 120 },
        (_, index) => `<a href="/${index}">Nav item ${index}</a>`,
      );
      const html = `<html><head><title>Docs</title></head><body><nav>${links.join(" ")}</nav>
<main><h1>Widgets</h1><p>Short body.</p></main></body></html>`;
      const output = await fetchHtmlPage(html, format);

      expect(output).toContain("Short body.");
      expect(output).not.toContain("Nav item 0");
      expect(output).toMatch(
        /Site chrome outside the main content was removed \(\d+% of page text\); use format: html for the full page\./,
      );
    },
  );

  test("keeps a <main> that is the whole page without claiming chrome was removed", async () => {
    const output = await fetchHtmlPage(
      "<html><head><title>Solo</title></head><body><main><p>Only main.</p></main></body></html>",
      "markdown",
    );
    expect(output).toBe("# Solo\n\nOnly main.");
  });

  test("text format puts block elements on their own lines and collapses blank runs", async () => {
    const html = `<html><head><title>Layout</title></head><body><main>
      <h1>Heading</h1>


      <p>First   paragraph,
         wrapped.</p><p>Second <em>inline</em> one.<br>After break</p>
      <ul><li>one</li><li>two</li></ul>
      <div>Block<div>Nested</div></div>
      <table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>
      <pre>  keep
    indent</pre>
    </main></body></html>`;

    expect(await fetchHtmlPage(html, "text")).toBe(
      [
        "Layout",
        "",
        "Heading",
        "",
        "First paragraph, wrapped.",
        "",
        "Second inline one.",
        "After break",
        "",
        "one",
        "two",
        "",
        "Block",
        "Nested",
        "",
        "a b",
        "c d",
        "",
        "  keep",
        "    indent",
      ].join("\n"),
    );
  });

  test("ignores a <nav>-role landmark and keeps only the headings of a <header> in <main>", async () => {
    const languages = Array.from(
      { length: 150 },
      (_, index) => `<li><a href="/${index}">Language${index}</a></li>`,
    ).join("");
    const html = `<html><head><title>Ferris - Encyclopedia</title></head><body>
<div role="navigation" aria-label="Site"><a>SiteNavigation</a></div>
<main id="content"><header class="titlebar"><h1>Ferris</h1>
<div class="dropdown"><ul>${languages}</ul></div></header>
<p>Ferris is a crab.</p>
<div role="navigation" class="navbox"><a>NavboxEntry</a></div>
<p>Second paragraph.</p>
<div role="search">SearchBox</div></main></body></html>`;

    for (const format of ["markdown", "text"] as const) {
      const output = await fetchHtmlPage(html, format);
      expect(output).not.toContain("Language");
      expect(output).not.toContain("NavboxEntry");
      expect(output).not.toContain("SiteNavigation");
      expect(output).not.toContain("SearchBox");
      expect(output).toContain("Ferris");
      expect(output).toContain("Ferris is a crab.");
      expect(output).toContain("Second paragraph.");
      expect(output).toContain("Site chrome outside the main content was removed");
    }
  });

  test("keeps the byline of a <header> inside an <article> within <main>", async () => {
    const html = `<html><head><title>Post</title></head><body><nav>NavAlpha</nav>
<main><header><h1>Page Title</h1><div class="widgets">PageWidgets</div></header>
<article><header><h2>Post Heading</h2><p>By Ada, 2024</p></header><p>Post body.</p></article></main></body></html>`;
    for (const format of ["markdown", "text"] as const) {
      const output = await fetchHtmlPage(html, format);
      expect(output).toContain("Page Title");
      expect(output).not.toContain("PageWidgets");
      expect(output).toContain("By Ada, 2024");
      expect(output).toContain("Post body.");
    }
  });

  test("keeps the text of a heading that has no end tag inside a <main> header", async () => {
    const html = `<html><head><title>Doc</title></head><body><nav>NavAlpha</nav>
<main><header><h1>Unclosed Title<h2>Subtitle</h2><div>HeaderWidgets</div></header><p>Body.</p></main></body></html>`;
    for (const format of ["markdown", "text"] as const) {
      const output = await fetchHtmlPage(html, format);
      expect(output).toContain("Unclosed Title");
      expect(output).toContain("Subtitle");
      expect(output).toContain("Body.");
    }
  });

  test("does not pick an <article> that is a sidebar card", async () => {
    const html = `<html><head><title>Plain</title></head><body>
<aside><article>CardOnly</article></aside>
<div><p>Real body text.</p></div><footer>FooterLegal</footer></body></html>`;
    for (const format of ["markdown", "text"] as const) {
      const output = await fetchHtmlPage(html, format);
      expect(output).toContain("Real body text.");
      expect(output).not.toContain("CardOnly");
      expect(output).not.toContain("FooterLegal");
    }
  });

  test("ignores <main> in <template> or <noscript> and an end tag inside <script>", async () => {
    const hidden = `<html><head><title>Hidden</title></head><body><nav>NavAlpha</nav>
<template><main>TemplateMain</main></template><noscript><main>NoscriptMain</main></noscript>
<script>document.write("</main><main>")</script><p>Visible body.</p></body></html>`;
    const output = await fetchHtmlPage(hidden, "text");
    expect(output).toContain("Visible body.");
    expect(output).not.toContain("NavAlpha");
    expect(output).not.toContain("TemplateMain");
    expect(output).not.toContain("NoscriptMain");

    const scripted = `<body><nav>NavAlpha</nav><main><p>Before</p><script>var s = "</main>";</script><p>After</p></main></body>`;
    const scriptedOutput = await fetchHtmlPage(scripted, "text");
    expect(scriptedOutput).toContain("Before");
    expect(scriptedOutput).toContain("After");
  });

  test("keeps Markdown links beside an inline script larger than the plain-text backstop", async () => {
    // Like a hydrated app page: the main content embeds a JSON payload larger than 256 KiB.
    const page = (payload: string) => `<html><head><title>Repo</title></head><body>
<nav>${"NavAlpha ".repeat(200)}</nav><main><react-app><h1>OPTIONS.md</h1>
<p><a href="https://example.com/raw/OPTIONS.md">Raw</a> <a href="/blame">Blame</a></p>${payload}
<p>Body text.</p></react-app></main></body></html>`;
    const payload = `<script type="application/json">${JSON.stringify({ blob: "x".repeat(300 * 1024) })}</script>`;
    for (const format of ["markdown", "text"] as const) {
      // Script bytes change neither the content nor the chrome-removal note.
      expect(await fetchHtmlPage(page(payload), format)).toBe(
        await fetchHtmlPage(page(""), format),
      );
    }
    const markdown = await fetchHtmlPage(page(payload), "markdown");
    expect(markdown).toContain("[Raw](https://example.com/raw/OPTIONS.md)");
    expect(markdown).toContain("*Site chrome outside the main content was removed (");
  });

  test("tolerates a stray end tag, multibyte text before <main>, and an encoded <title>", async () => {
    const html = `<html><head><title>Tom &amp; Jerry &lt;Show&gt;</title></head><body>
<nav>ナビゲーション 🚀</nav></div><p>日本語の前文 🚀</p>
<main><p>メイン本文 🚀</p></main></body></html>`;
    for (const format of ["markdown", "text"] as const) {
      const output = await fetchHtmlPage(html, format);
      expect(output).toContain("メイン本文 🚀");
      expect(output).not.toContain("日本語の前文");
      expect(output).not.toContain("ナビゲーション");
      expect(output).toContain("Tom & Jerry <Show>");
    }
    expect(await fetchHtmlPage(html, "text")).toMatch(/^Tom & Jerry <Show>/);
  });

  test("does not repeat a title that Markdown escapes", async () => {
    const html = `<html><head><title>Foo_bar</title></head><body><nav>NavAlpha</nav><main><h1>Foo_bar</h1><p>Body.</p></main></body></html>`;
    const output = await fetchHtmlPage(html, "markdown");
    expect(output.match(/Foo\\?_bar/g)).toHaveLength(1);
  });

  test("text format keeps blank lines and trailing spaces inside <pre>", async () => {
    const html = "<p>Intro</p><pre>line one  \n\n\n\nline two   </pre><p>Outro</p>";
    expect(await fetchHtmlPage(html, "text")).toBe(
      "Intro\n\nline one  \n\n\n\nline two   \n\nOutro",
    );
  });

  test("returns html format unchanged", async () => {
    expect(await fetchHtmlPage(NAVIGATION_PAGE, "html")).toBe(NAVIGATION_PAGE);
  });
});

describe("Web Fetch main content on large pages", () => {
  // Several MiB of HTML; extraction must stay linear because it runs synchronously and a request
  // timeout cannot interrupt it.
  const LARGE_PAGES = {
    "paragraphs in <main>": {
      items: 120_000,
      build: (items) =>
        `<html><head><title>Big</title></head><body><nav>NavAlpha</nav><main>${Array.from(
          { length: items },
          (_, index) => `<p>paragraph ${index}</p>`,
        ).join("")}</main></body></html>`,
    },
    "<aside> elements": {
      items: 120_000,
      build: (items) =>
        `<html><head><title>Big</title></head><body>${Array.from(
          { length: items },
          (_, index) => `<aside>aside ${index}</aside>`,
        ).join("")}<div><p>Real body text.</p></div></body></html>`,
    },
    "paragraphs on a plain page (no main or chrome)": {
      items: 110_000,
      build: (items) =>
        `<!doctype html><html><head><title>Big</title></head><body>${Array.from(
          { length: items },
          (_, index) => `<p>paragraph ${index}</p>`,
        ).join("")}</body></html>`,
    },
    "paragraphs in two <div>s inside <main>": {
      items: 110_000,
      build: (items) =>
        `<html><head><title>Big</title></head><body><nav>NavAlpha</nav><main>${[0, 1]
          .map(
            (half) =>
              `<div>${Array.from({ length: items / 2 }, (_, index) => `<p>half ${half} paragraph ${index}</p>`).join("")}</div>`,
          )
          .join("")}</main></body></html>`,
    },
    "list items in one <ul> inside <main>": {
      items: 100_000,
      build: (items) =>
        `<html><head><title>Big</title></head><body><nav>NavAlpha</nav><main><ul>${Array.from(
          { length: items },
          (_, index) => `<li>item number ${index}</li>`,
        ).join("")}</ul></main></body></html>`,
    },
    "list items in one <ol> on a plain page": {
      items: 100_000,
      build: (items) =>
        `<html><body><ol start="5">${Array.from(
          { length: items },
          (_, index) => `<li>item number ${index}</li>`,
        ).join("")}</ol></body></html>`,
    },
    "rows in one <table> (plain-text backstop)": {
      items: 90_000,
      build: (items) =>
        `<html><body><p>Intro</p><table>${Array.from(
          { length: items },
          (_, index) => `<tr><td>row ${index}</td><td>value</td></tr>`,
        ).join("")}</table></body></html>`,
    },
    "<nav> elements": {
      items: 120_000,
      build: (items) =>
        `<html><head><title>Big</title></head><body>${Array.from(
          { length: items },
          (_, index) => `<nav>nav ${index}</nav>`,
        ).join("")}<div><p>Real body text.</p></div></body></html>`,
    },
  } satisfies Record<string, { items: number; build: (items: number) => string }>;

  // Turndown re-reads its accumulated output for every sibling node, so one large input costs
  // quadratic time; html-markdown.ts keeps every Turndown input small and parses each byte a bounded
  // number of times. The guard counts that work instead of timing it, which depends on runner load:
  // every byte handed to the HTML parser or to Turndown is recorded, and both totals must stay a
  // small multiple of the page while no single Turndown input exceeds the atomic piece size.
  // Pure-JavaScript loops elsewhere are not counted.
  const MAX_PARSE_PASSES = 8;
  const MAX_TURNDOWN_PASSES = 2;
  const MAX_TURNDOWN_INPUT_BYTES = 256 * 1024;

  // Count bytes through the prototypes without retaining arguments or receivers, so a regression
  // fails an assertion instead of exhausting memory on recorded parser state. The counters are
  // installed once for the block so a timed-out test cannot restore them under the next one.
  const work = { parsedBytes: 0, turndownBytes: 0, largestTurndownInput: 0 };
  // oxlint-disable-next-line typescript/unbound-method -- Called with its receiver and restored after the block.
  const { write } = Parser.prototype;
  // oxlint-disable-next-line typescript/unbound-method -- Called with its receiver and restored after the block.
  const { turndown } = TurndownService.prototype;
  beforeAll(() => {
    Parser.prototype.write = function countedWrite(this: Parser, chunk: string) {
      work.parsedBytes += chunk.length;
      write.call(this, chunk);
    };
    TurndownService.prototype.turndown = function countedTurndown(
      this: TurndownService,
      input: string,
    ) {
      work.turndownBytes += input.length;
      work.largestTurndownInput = Math.max(work.largestTurndownInput, input.length);
      return turndown.call(this, input);
    };
  });
  afterAll(() => {
    Parser.prototype.write = write;
    TurndownService.prototype.turndown = turndown;
  });

  for (const [name, { items, build }] of Object.entries(LARGE_PAGES)) {
    for (const format of ["text", "markdown"] as const) {
      test(`converts a multi-MiB page of ${name} in ${format} format in linear work`, async () => {
        const html = build(items);
        expect(html.length).toBeGreaterThan(2 * 1024 * 1024);
        Object.assign(work, { parsedBytes: 0, turndownBytes: 0, largestTurndownInput: 0 });
        const fetch: typeof globalThis.fetch = async () =>
          new Response(html, { headers: { "content-type": "text/html" } });
        const result = await executeFetch({ fetch }, { url: "https://example.com/big", format });
        const spill = result.details.truncation?.fullOutputPath;
        if (spill !== undefined) spillDirectories.push(dirname(spill));

        // The page is parsed at least once, so the counters see the conversion's work.
        expect(work.parsedBytes).toBeGreaterThanOrEqual(html.length);
        expect(work.parsedBytes).toBeLessThanOrEqual(MAX_PARSE_PASSES * html.length);
        expect(work.largestTurndownInput).toBeLessThanOrEqual(MAX_TURNDOWN_INPUT_BYTES);
        expect(work.turndownBytes).toBeLessThanOrEqual(MAX_TURNDOWN_PASSES * html.length);
        expect(Value.Parse(WebFetchOutputSchema, result.structuredContent).content).not.toContain(
          "NavAlpha",
        );
      }, 90_000);
    }
  }
});
