async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  await body.cancel().catch(() => undefined);
}

/** Combine a caller Abort Signal with a timeout deadline for one Web Tool request. */
export function requestSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return callerSignal === undefined ? deadline : AbortSignal.any([callerSignal, deadline]);
}

/** A response whose HTTP status was not a success. */
export class WebHttpStatusError extends Error {
  readonly status: number;
  readonly statusText: string;

  constructor(status: number, statusText = "") {
    super(`HTTP ${status}`);
    this.name = "WebHttpStatusError";
    this.status = status;
    this.statusText = statusText;
  }
}

/** A failure caused by the request itself, such as an invalid URL or unsupported content type. */
export class WebInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebInputError";
  }
}

/** A response body above the byte limit a Web Tool accepts. */
export class WebResponseTooLargeError extends Error {
  readonly maximumBytes: number;

  constructor(maximumBytes: number) {
    super(`Response body exceeds ${maximumBytes} bytes`);
    this.name = "WebResponseTooLargeError";
    this.maximumBytes = maximumBytes;
  }
}

/** A response body stream that failed before it ended. */
export class WebResponseReadError extends Error {
  constructor(cause: unknown) {
    super("Response body read failed", { cause });
    this.name = "WebResponseReadError";
  }
}

/** Why a Web Tool request failed and whether the troubleshooting Skill can diagnose it. */
export type WebFailure = {
  /** Short, URL-free reason suitable for appending to a model-visible error. */
  readonly cause: string;
  /** True for server, network, and timeout failures; false for bad input, 4xx, and cancellation. */
  readonly diagnosable: boolean;
};

/** Context that distinguishes a caller cancellation and names the request deadline. */
export type WebFailureContext = {
  readonly callerSignal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
};

const MAX_CAUSE_DEPTH = 5;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Caught values are untyped; this classifier narrows them with instanceof.
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (current instanceof Error && chain.length < MAX_CAUSE_DEPTH) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Caught values are untyped; this classifier narrows them with instanceof.
function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const { code } = error;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node error codes are untyped values.
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,}$/.test(code) ? code : undefined;
}

function formatByteLimit(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes} bytes`;
}

function formatSeconds(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/**
 * Turn an error caught around a Web Tool request into a short cause and a troubleshooting verdict.
 * Reports caller cancellation, the request deadline, HTTP status, network error class, and the
 * response size limit. The cause never contains the request URL.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Caught values are untyped; this classifier narrows them with instanceof.
export function describeWebFailure(error: unknown, context: WebFailureContext = {}): WebFailure {
  if (context.callerSignal?.aborted === true) {
    return { cause: "request cancelled", diagnosable: false };
  }
  const chain = causeChain(error);
  if (chain.some((link) => link instanceof Error && link.name === "TimeoutError")) {
    const deadline =
      context.timeoutMs === undefined ? "" : ` after ${formatSeconds(context.timeoutMs)}`;
    return { cause: `timed out${deadline}`, diagnosable: true };
  }
  for (const link of chain) {
    if (link instanceof WebHttpStatusError) {
      const statusText = link.statusText === "" ? "" : ` ${link.statusText}`;
      return {
        cause: `HTTP ${link.status}${statusText}`,
        diagnosable: link.status >= 500,
      };
    }
    if (link instanceof WebInputError) return { cause: link.message, diagnosable: false };
    if (link instanceof WebResponseTooLargeError) {
      return {
        cause: `response body exceeds the ${formatByteLimit(link.maximumBytes)} limit`,
        diagnosable: false,
      };
    }
  }
  const code = chain.map(errorCode).find((value) => value !== undefined);
  if (code !== undefined) return { cause: `network error ${code}`, diagnosable: true };
  if (chain.some((link) => link instanceof WebResponseReadError)) {
    return { cause: "network error while reading the response body", diagnosable: true };
  }
  if (error instanceof TypeError && error.message === "fetch failed") {
    return { cause: "network error", diagnosable: true };
  }
  return {
    cause: error instanceof Error ? `unexpected ${error.name}` : "unexpected error",
    diagnosable: false,
  };
}

/** Drain and discard a response body without retaining bytes. */
export async function cancelResponse(response: Response): Promise<void> {
  await cancelBody(response.body);
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
    throw new WebResponseTooLargeError(maximumBytes);
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
        throw signal?.aborted
          ? new Error("Response body read aborted", { cause: signal.reason })
          : new WebResponseReadError(cause);
      });
      if (signal?.aborted) {
        throw new Error("Response body read aborted", { cause: signal.reason });
      }
      if (read.done) break;
      if (totalBytes + read.value.byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WebResponseTooLargeError(maximumBytes);
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
