async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  await body.cancel().catch(() => undefined);
}

/** Read a native response incrementally without retaining bytes above the supplied limit. */
export async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted) {
    await cancelBody(response.body);
    throw new Error("Response body read aborted", { cause: signal.reason });
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
    throw new Error(`Response body exceeds ${maximumBytes} bytes`);
  }

  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const abortRead = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abortRead, { once: true });

  try {
    while (true) {
      const read = await reader.read().catch((cause: unknown): never => {
        throw new Error(
          signal?.aborted ? "Response body read aborted" : "Response body read failed",
          { cause: signal?.aborted ? signal.reason : cause },
        );
      });
      if (signal?.aborted) {
        throw new Error("Response body read aborted", { cause: signal.reason });
      }
      if (read.done) break;
      if (totalBytes + read.value.byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Response body exceeds ${maximumBytes} bytes`);
      }
      if (read.value.byteLength === 0) continue;
      chunks.push(read.value);
      totalBytes += read.value.byteLength;
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
  return body;
}
