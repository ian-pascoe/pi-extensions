import { describe, expect, test } from "vitest";
import {
  describeWebFailure,
  readBoundedResponseBody,
  WebHttpStatusError,
  WebInputError,
  WebResponseTooLargeError,
} from "../src/web-response.js";

function responseFromChunks(
  chunks: readonly Uint8Array[],
  headers?: Readonly<Record<string, string>>,
  onCancel?: () => void,
): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        onCancel?.();
      },
    }),
    headers === undefined ? {} : { headers },
  );
}

describe("bounded Web response bodies", () => {
  test("accepts a body at the exact byte limit", async () => {
    const result = await readBoundedResponseBody(
      responseFromChunks([new TextEncoder().encode("ab"), new TextEncoder().encode("cd")]),
      4,
    );
    expect(new TextDecoder().decode(result)).toBe("abcd");
  });

  test("rejects and cancels a declared overflow before reading", async () => {
    let cancelled = false;
    const response = responseFromChunks([new Uint8Array([1])], { "content-length": "6" }, () => {
      cancelled = true;
    });

    await expect(readBoundedResponseBody(response, 5)).rejects.toThrow(
      "Response body exceeds 5 bytes",
    );
    expect(cancelled).toBe(true);
  });

  test("rejects streamed overflow without reading later chunks", async () => {
    let pulls = 0;
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(3));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    await expect(readBoundedResponseBody(response, 5)).rejects.toThrow(
      "Response body exceeds 5 bytes",
    );
    expect(pulls).toBeLessThan(4);
    expect(cancelled).toBe(true);
  });

  test("cancels a pending read when the caller aborts", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
    );

    const reading = readBoundedResponseBody(response, 5, controller.signal);
    controller.abort();

    await expect(reading).rejects.toThrow("Response body read aborted");
    expect(cancelled).toBe(true);
  });

  test("rejects failed response streams", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("transport details"));
        },
      }),
    );

    await expect(readBoundedResponseBody(response, 5)).rejects.toThrow("Response body read failed");
  });
});

describe("Web failure causes", () => {
  test.each([
    [new WebHttpStatusError(404, "Not Found"), "HTTP 404 Not Found", false],
    [new WebHttpStatusError(502), "HTTP 502", true],
    [new WebInputError("invalid URL"), "invalid URL", false],
    [new WebResponseTooLargeError(1024), "response body exceeds the 1024 bytes limit", false],
    [new WebResponseTooLargeError(2 * 1024 * 1024), "response body exceeds the 2 MiB limit", false],
    [
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("x"), { code: "ECONNRESET" }),
      }),
      "network error ECONNRESET",
      true,
    ],
    [new TypeError("fetch failed"), "network error", true],
    [new RangeError("secret user:pass@host"), "unexpected RangeError", false],
    ["boom", "unexpected error", false],
  ])("describes %s", (error, cause, diagnosable) => {
    expect(describeWebFailure(error)).toEqual({ cause, diagnosable });
  });

  test("distinguishes the request deadline from caller cancellation", async () => {
    const deadline = AbortSignal.timeout(1);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    expect(describeWebFailure(deadline.reason)).toEqual({ cause: "timed out", diagnosable: true });
    expect(
      describeWebFailure(new Error("read aborted", { cause: deadline.reason }), {
        timeoutMs: 1500,
      }),
    ).toEqual({
      cause: "timed out after 1.5 seconds",
      diagnosable: true,
    });

    const caller = new AbortController();
    caller.abort();
    expect(describeWebFailure(caller.signal.reason, { callerSignal: caller.signal })).toEqual({
      cause: "request cancelled",
      diagnosable: false,
    });
  });
});
