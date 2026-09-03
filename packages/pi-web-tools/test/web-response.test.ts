import { describe, expect, test } from "vitest";
import { readBoundedResponseBody } from "../src/web-response.js";

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
    expect(result._tag).toBe("ok");
    if (result._tag === "err") throw result.error;
    expect(new TextDecoder().decode(result.value)).toBe("abcd");
  });

  test("rejects and cancels a declared overflow before reading", async () => {
    let cancelled = false;
    const response = responseFromChunks([new Uint8Array([1])], { "content-length": "6" }, () => {
      cancelled = true;
    });

    await expect(readBoundedResponseBody(response, 5)).resolves.toMatchObject({
      _tag: "err",
      error: { _tag: "WebResponseTooLarge" },
    });
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

    await expect(readBoundedResponseBody(response, 5)).resolves.toMatchObject({
      _tag: "err",
      error: { _tag: "WebResponseTooLarge" },
    });
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

    await expect(reading).resolves.toMatchObject({
      _tag: "err",
      error: { _tag: "WebResponseAborted" },
    });
    expect(cancelled).toBe(true);
  });
});
