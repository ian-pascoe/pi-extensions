/** A response declared or streamed more bytes than its owner accepts. */
export class WebResponseTooLarge extends Error {
  readonly _tag = "WebResponseTooLarge" as const;
  readonly operation = "readResponseBody" as const;

  constructor(readonly maximumBytes: number) {
    super(`Response body exceeds ${maximumBytes} bytes`);
  }
}

/** Response collection stopped because its shared signal aborted. */
export class WebResponseAborted extends Error {
  readonly _tag = "WebResponseAborted" as const;
  readonly operation = "readResponseBody" as const;

  constructor(cause: unknown) {
    super("Response body read aborted", { cause });
  }
}

/** A response stream failed while its owner was collecting bytes. */
export class WebResponseReadFailed extends Error {
  readonly _tag = "WebResponseReadFailed" as const;
  readonly operation = "readResponseBody" as const;

  constructor(cause: unknown) {
    super("Response body read failed", { cause });
  }
}

/** Expected failure while collecting a bounded Web Search or Web Fetch response body. */
export type WebResponseBodyError = WebResponseTooLarge | WebResponseAborted | WebResponseReadFailed;

/** Bounded bytes or an expected response-reading failure. */
export type WebResponseBodyResult =
  | { readonly _tag: "ok"; readonly value: Uint8Array }
  | { readonly _tag: "err"; readonly error: WebResponseBodyError };

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  await body.cancel().catch(() => undefined);
}

/** Read a native response incrementally without retaining bytes above the supplied limit. */
export async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<WebResponseBodyResult> {
  if (signal?.aborted) {
    await cancelBody(response.body);
    return { _tag: "err", error: new WebResponseAborted(signal.reason) };
  }

  const declaredLength = response.headers.get("content-length");
  const parsedLength = declaredLength === null ? undefined : Number.parseInt(declaredLength, 10);
  if (
    parsedLength !== undefined &&
    Number.isSafeInteger(parsedLength) &&
    parsedLength >= 0 &&
    parsedLength > maximumBytes
  ) {
    await cancelBody(response.body);
    return { _tag: "err", error: new WebResponseTooLarge(maximumBytes) };
  }

  if (response.body === null) return { _tag: "ok", value: new Uint8Array() };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const abortRead = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abortRead, { once: true });

  try {
    while (true) {
      const read = await reader.read().then(
        (value) => ({ _tag: "ok" as const, value }),
        (cause: unknown) => ({ _tag: "err" as const, cause }),
      );
      if (read._tag === "err") {
        return signal?.aborted
          ? { _tag: "err", error: new WebResponseAborted(signal.reason) }
          : { _tag: "err", error: new WebResponseReadFailed(read.cause) };
      }
      if (signal?.aborted) {
        return { _tag: "err", error: new WebResponseAborted(signal.reason) };
      }
      if (read.value.done) break;
      if (totalBytes + read.value.value.byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return { _tag: "err", error: new WebResponseTooLarge(maximumBytes) };
      }
      if (read.value.value.byteLength === 0) continue;
      chunks.push(read.value.value);
      totalBytes += read.value.value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", abortRead);
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { _tag: "ok", value: body };
}
