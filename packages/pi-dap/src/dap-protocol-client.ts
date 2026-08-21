import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Readable, Writable } from "node:stream";
import type { DebugProtocol } from "@vscode/debugprotocol";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const MAX_DAP_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_DAP_HEADER_BYTES = 64 * 1024;
const MAX_ADAPTER_STDERR_BYTES = 1024 * 1024;
const TCP_RETRY_DELAY_MS = 20;

const DapProtocolObjectSchema = Type.Object({}, { additionalProperties: true });
const DapRequestEnvelopeSchema = Type.Object(
  {
    seq: Type.Integer({ minimum: 1 }),
    type: Type.Literal("request"),
    command: Type.String({ minLength: 1 }),
    arguments: Type.Optional(DapProtocolObjectSchema),
  },
  { additionalProperties: false },
);
const DapResponseEnvelopeSchema = Type.Object(
  {
    seq: Type.Integer({ minimum: 1 }),
    type: Type.Literal("response"),
    request_seq: Type.Integer({ minimum: 1 }),
    success: Type.Boolean(),
    command: Type.String({ minLength: 1 }),
    message: Type.Optional(Type.String()),
    body: Type.Optional(DapProtocolObjectSchema),
  },
  { additionalProperties: false },
);
const DapEventEnvelopeSchema = Type.Object(
  {
    seq: Type.Integer({ minimum: 1 }),
    type: Type.Literal("event"),
    event: Type.String({ minLength: 1 }),
    body: Type.Optional(DapProtocolObjectSchema),
  },
  { additionalProperties: false },
);
const DapEnvelopeSchema = Type.Union([
  DapRequestEnvelopeSchema,
  DapResponseEnvelopeSchema,
  DapEventEnvelopeSchema,
]);

type ParsedDapEnvelope = Static<typeof DapEnvelopeSchema>;
type ParsedDapRequest = Static<typeof DapRequestEnvelopeSchema>;
type ParsedDapResponse = Static<typeof DapResponseEnvelopeSchema>;

/** JSON object sent as DAP request arguments or returned as a response body. */
export type DapProtocolObject = Static<typeof DapProtocolObjectSchema>;

/** Stdio or TCP transport used to communicate with one configured Debug Adapter. */
export type DapProtocolTransport =
  | "stdio"
  | {
      readonly type: "tcp";
      readonly host: string;
      /** Zero asks the operating system to select a local port. */
      readonly port: number;
    };

/** Time budgets, in milliseconds, owned by one DAP Protocol Client. */
export interface DapProtocolClientTimeouts {
  /** Process spawn and TCP connection budget. */
  readonly startupMs: number;
  /** Ordinary DAP request budget. */
  readonly requestMs: number;
  /** Complete graceful and forced process shutdown budget. */
  readonly shutdownMs: number;
}

/** Result returned after handling one Debug Adapter reverse request. */
export type DapReverseRequestResult =
  | { readonly success: true; readonly body?: DapProtocolObject }
  | { readonly success: false; readonly message: string; readonly body?: DapProtocolObject };

/** Process, transport, and protocol configuration for one DAP Protocol Client. */
export interface DapProtocolClientOptions {
  /** Stable configured Adapter Definition ID. */
  readonly adapterId: string;
  /** Project working directory used as the Debug Adapter process cwd. */
  readonly cwd: string;
  /** Debug Adapter executable, started without a shell. */
  readonly command: string;
  /** Executable arguments; TCP transports replace every `$PORT` substring. */
  readonly args: readonly string[];
  /** Environment overrides; null removes an inherited key. */
  readonly environment: Readonly<Record<string, string | null>>;
  /** Configured stdio or TCP transport. */
  readonly transport: DapProtocolTransport;
  /** Startup, request, and shutdown budgets. */
  readonly timeouts: DapProtocolClientTimeouts;
  /** Session file retaining the latest 1 MiB of Debug Adapter stderr. */
  readonly stderrPath: string;
  /** Cancel Debug Adapter startup without retaining a process or transport. */
  readonly startupSignal?: AbortSignal | undefined;
  /** Handle a Debug Adapter request such as `runInTerminal`. */
  readonly onReverseRequest?:
    | ((
        request: DebugProtocol.Request,
      ) => Promise<DapReverseRequestResult> | DapReverseRequestResult)
    | undefined;
  /** Observe the first terminal process, transport, or protocol failure. */
  readonly onFailure?: ((error: DapProtocolClientError) => void) | undefined;
}

/** Per-request cancellation and timeout controls. */
export interface DapProtocolRequestOptions {
  /** Abort only this request wait. */
  readonly signal?: AbortSignal | undefined;
  /** Override the configured ordinary request budget. */
  readonly timeoutMs?: number | undefined;
}

/** Event wait controls used by Debug Session choreography. */
export interface DapProtocolEventWaitOptions {
  /** Abort only this event wait. */
  readonly signal?: AbortSignal | undefined;
  /** Override the configured ordinary request budget. */
  readonly timeoutMs?: number | undefined;
}

/** Overrides used when a TCP Debug Adapter asks for its primary target channel. */
export interface DapProtocolTargetChannelOptions {
  readonly startupSignal?: AbortSignal | undefined;
  readonly onReverseRequest?: DapProtocolClientOptions["onReverseRequest"];
  readonly onFailure?: DapProtocolClientOptions["onFailure"];
}

/** Classified Debug Adapter process, transport, protocol, timeout, and cancellation failure. */
export class DapProtocolClientError extends Error {
  /** Construct a searchable DAP client failure that always names its stderr capture. */
  constructor(
    readonly kind:
      | "cancelled"
      | "exit"
      | "protocol"
      | "request"
      | "shutdown"
      | "spawn"
      | "timeout"
      | "transport",
    readonly adapterId: string,
    readonly stderrPath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`DAP Protocol Client: ${message} (adapter ${adapterId}; stderr ${stderrPath})`, options);
  }
}

interface PendingDapRequest {
  readonly command: string;
  readonly resolve: (body: DapProtocolObject | undefined) => void;
  readonly reject: (error: DapProtocolClientError) => void;
  readonly cleanup: () => void;
}

class DapFrameDecoder {
  private buffer = Buffer.alloc(0);
  private contentLength: number | undefined;

  constructor(private readonly receive: (envelope: ParsedDapEnvelope) => void) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.contentLength === undefined) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          if (this.buffer.length > MAX_DAP_HEADER_BYTES) {
            throw new Error("DAP frame header exceeds 64 KiB");
          }
          return;
        }
        if (headerEnd > MAX_DAP_HEADER_BYTES) {
          throw new Error("DAP frame header exceeds 64 KiB");
        }
        this.contentLength = parseContentLength(this.buffer.subarray(0, headerEnd));
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }

      if (this.buffer.length < this.contentLength) return;
      const payload = this.buffer.subarray(0, this.contentLength);
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = undefined;
      this.receive(parseDapEnvelope(payload));
    }
  }
}

function parseContentLength(header: Buffer): number {
  const fields = new Map<string, string>();
  for (const line of header.toString("ascii").split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error("DAP frame contains a malformed header");
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name.length === 0 || value.length === 0 || fields.has(name)) {
      throw new Error("DAP frame contains a malformed or duplicate header");
    }
    fields.set(name, value);
  }
  const rawLength = fields.get("content-length");
  if (rawLength === undefined || !/^(?:0|[1-9]\d*)$/.test(rawLength)) {
    throw new Error("DAP frame is missing a valid Content-Length header");
  }
  const contentLength = Number(rawLength);
  if (!Number.isSafeInteger(contentLength) || contentLength > MAX_DAP_FRAME_BYTES) {
    throw new Error("DAP frame exceeds the 8 MiB limit");
  }
  return contentLength;
}

function parseDapEnvelope(payload: Buffer): ParsedDapEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch (cause) {
    throw new Error("DAP frame contains malformed JSON", { cause });
  }
  if (!Value.Check(DapEnvelopeSchema, value)) {
    const issue = Value.Errors(DapEnvelopeSchema, value)[0];
    throw new Error(
      `DAP frame contains an invalid protocol envelope${issue?.instancePath === undefined ? "" : ` at ${issue.instancePath || "/"}`}`,
    );
  }
  return value;
}

function dapFrame(message: DebugProtocol.ProtocolMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${String(payload.length)}\r\n\r\n`, "ascii"),
    payload,
  ]);
}

function isDapStartupCancelled(options: DapProtocolClientOptions): boolean {
  return options.startupSignal?.aborted ?? false;
}

/** Merge configured environment overrides over the parent environment; null removes an inherited key. */
export function resolvedAdapterEnvironment(
  configured: Readonly<Record<string, string | null>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(configured)) {
    if (value === null) delete environment[name];
    else environment[name] = value;
  }
  return environment;
}

async function allocateTcpPort(host: string): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port: 0 });
  });
  const address = server.address();
  if (
    !Value.Check(Type.Object({ port: Type.Integer() }, { additionalProperties: true }), address)
  ) {
    await closeServer(server);
    throw new Error("TCP port allocation returned no numeric address");
  }
  const port = address.port;
  await closeServer(server);
  return port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

function waitForChildSpawn(
  child: ChildProcessWithoutNullStreams,
  options: DapProtocolClientOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      options.startupSignal?.removeEventListener("abort", onAbort);
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (cause: Error) => {
      cleanup();
      reject(
        new DapProtocolClientError(
          "spawn",
          options.adapterId,
          options.stderrPath,
          `failed to spawn command ${options.command}`,
          { cause },
        ),
      );
    };
    const onAbort = () => {
      cleanup();
      reject(
        new DapProtocolClientError(
          "cancelled",
          options.adapterId,
          options.stderrPath,
          "Debug Adapter startup was cancelled",
        ),
      );
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    options.startupSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      reject(
        new DapProtocolClientError(
          "timeout",
          options.adapterId,
          options.stderrPath,
          `startup timed out after ${String(options.timeouts.startupMs)}ms`,
        ),
      );
    }, options.timeouts.startupMs);
    timer.unref();
    if (isDapStartupCancelled(options)) onAbort();
  });
}

async function connectTcpWithRetry(
  host: string,
  port: number,
  child: ChildProcessWithoutNullStreams | undefined,
  options: DapProtocolClientOptions,
): Promise<Socket> {
  const deadline = Date.now() + options.timeouts.startupMs;
  let lastCause: unknown;
  while (Date.now() < deadline) {
    if (isDapStartupCancelled(options)) {
      throw new DapProtocolClientError(
        "cancelled",
        options.adapterId,
        options.stderrPath,
        "Debug Adapter startup was cancelled",
      );
    }
    if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
      throw new DapProtocolClientError(
        "exit",
        options.adapterId,
        options.stderrPath,
        `Debug Adapter exited before TCP connection (code ${String(child.exitCode)}, signal ${String(child.signalCode)})`,
      );
    }
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = createConnection({ host, port });
        const cleanup = () => {
          options.startupSignal?.removeEventListener("abort", onAbort);
          socket.off("connect", onConnect);
          socket.off("error", onError);
        };
        const onConnect = () => {
          cleanup();
          resolve(socket);
        };
        const onError = (error: Error) => {
          cleanup();
          socket.destroy();
          reject(error);
        };
        const onAbort = () => {
          cleanup();
          socket.destroy();
          reject(
            new DapProtocolClientError(
              "cancelled",
              options.adapterId,
              options.stderrPath,
              "Debug Adapter startup was cancelled",
            ),
          );
        };
        socket.once("connect", onConnect);
        socket.once("error", onError);
        options.startupSignal?.addEventListener("abort", onAbort, { once: true });
        if (isDapStartupCancelled(options)) onAbort();
      });
    } catch (cause) {
      if (cause instanceof DapProtocolClientError && cause.kind === "cancelled") throw cause;
      lastCause = cause;
      const remaining = deadline - Date.now();
      if (remaining > 0) await delay(Math.min(TCP_RETRY_DELAY_MS, remaining));
    }
  }
  throw new DapProtocolClientError(
    "timeout",
    options.adapterId,
    options.stderrPath,
    `TCP startup timed out after ${String(options.timeouts.startupMs)}ms connecting to ${host}:${String(port)}`,
    { cause: lastCause },
  );
}

class BoundedAdapterStderr {
  private retained = Buffer.alloc(0);
  private dirty = false;
  private writePromise: Promise<void> | undefined;

  constructor(
    readable: Readable,
    readonly path: string,
  ) {
    readable.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const combined = Buffer.concat([this.retained, bytes]);
      this.retained =
        combined.length <= MAX_ADAPTER_STDERR_BYTES
          ? combined
          : combined.subarray(combined.length - MAX_ADAPTER_STDERR_BYTES);
      this.dirty = true;
      this.writePromise ??= this.writeLatestSnapshots();
    });
  }

  async flush(): Promise<void> {
    while (this.writePromise !== undefined) await this.writePromise;
  }

  private async writeLatestSnapshots(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      await writeFile(this.path, this.retained);
    }
    this.writePromise = undefined;
  }
}

function processExitPromise(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

/** Signal one owned child's Linux process group (or the process itself elsewhere). */
export function signalOwnedProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "linux") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
    if (code !== "ESRCH") throw cause;
  }
}

async function waitUntil(promise: Promise<void>, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), remaining);
    timer.unref();
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Owns one framed Debug Adapter transport and its correlated DAP requests. */
export class DapProtocolClient {
  private readonly pendingRequests = new Map<number, PendingDapRequest>();
  private readonly pendingEventWaitRejectors = new Set<(error: DapProtocolClientError) => void>();
  private readonly abandonedRequestSequences = new Set<number>();
  private readonly eventListeners = new Set<(event: DebugProtocol.Event) => void>();
  private readonly decoder: DapFrameDecoder;
  private nextSequence = 1;
  private failure: DapProtocolClientError | undefined;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  private constructor(
    private readonly options: DapProtocolClientOptions,
    private readonly child: ChildProcessWithoutNullStreams | undefined,
    private readonly reader: Readable,
    private readonly writer: Writable,
    private readonly socket: Socket | undefined,
    private readonly stderr: BoundedAdapterStderr | undefined,
    readonly selectedPort: number | undefined,
  ) {
    this.decoder = new DapFrameDecoder((envelope) => this.receiveEnvelope(envelope));
    this.reader.on("data", (chunk: Buffer | string) => {
      try {
        this.decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch (cause) {
        this.fail(
          new DapProtocolClientError(
            "protocol",
            this.adapterId,
            this.stderrPath,
            cause instanceof Error ? cause.message : "failed to parse a DAP frame",
            { cause },
          ),
        );
      }
    });
    this.reader.on("error", (cause) => {
      if (!this.shuttingDown) {
        this.fail(
          new DapProtocolClientError(
            "transport",
            this.adapterId,
            this.stderrPath,
            "Debug Adapter transport failed",
            { cause },
          ),
        );
      }
    });
    this.reader.on("end", () => {
      if (!this.shuttingDown && this.failure === undefined) {
        this.fail(
          new DapProtocolClientError(
            "transport",
            this.adapterId,
            this.stderrPath,
            "Debug Adapter transport ended unexpectedly",
          ),
        );
      }
    });
    if (this.child !== undefined) {
      this.child.on("error", (cause) => {
        if (!this.shuttingDown) {
          this.fail(
            new DapProtocolClientError(
              "spawn",
              this.adapterId,
              this.stderrPath,
              "Debug Adapter process failed",
              { cause },
            ),
          );
        }
      });
      this.child.on("exit", (code, signal) => {
        const error = new DapProtocolClientError(
          "exit",
          this.adapterId,
          this.stderrPath,
          `Debug Adapter exited unexpectedly (code ${String(code)}, signal ${String(signal)})`,
        );
        if (this.shuttingDown) this.rejectPending(error);
        else this.fail(error);
      });
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        this.fail(
          new DapProtocolClientError(
            "exit",
            this.adapterId,
            this.stderrPath,
            `Debug Adapter exited unexpectedly (code ${String(this.child.exitCode)}, signal ${String(this.child.signalCode)})`,
          ),
        );
      }
    }
  }

  /** Start a configured Debug Adapter and connect its stdio or TCP transport. */
  static async start(options: DapProtocolClientOptions): Promise<DapProtocolClient> {
    if (isDapStartupCancelled(options)) {
      throw new DapProtocolClientError(
        "cancelled",
        options.adapterId,
        options.stderrPath,
        "Debug Adapter startup was cancelled",
      );
    }
    await mkdir(dirname(options.stderrPath), { recursive: true });
    await writeFile(options.stderrPath, "");

    let selectedPort: number | undefined;
    let args = [...options.args];
    const environment = resolvedAdapterEnvironment(options.environment);
    if (options.transport === "stdio") {
      if (args.some((argument) => argument.includes("$PORT"))) {
        throw new DapProtocolClientError(
          "transport",
          options.adapterId,
          options.stderrPath,
          "stdio Adapter Definition arguments cannot contain $PORT",
        );
      }
    } else {
      try {
        selectedPort =
          options.transport.port === 0
            ? await allocateTcpPort(options.transport.host)
            : options.transport.port;
      } catch (cause) {
        throw new DapProtocolClientError(
          "transport",
          options.adapterId,
          options.stderrPath,
          "failed to allocate a TCP port",
          { cause },
        );
      }
      if (isDapStartupCancelled(options)) {
        throw new DapProtocolClientError(
          "cancelled",
          options.adapterId,
          options.stderrPath,
          "Debug Adapter startup was cancelled",
        );
      }
      const portText = String(selectedPort);
      args = args.map((argument) => argument.replaceAll("$PORT", portText));
      environment.PORT = portText;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.command, args, {
        cwd: options.cwd,
        detached: process.platform === "linux",
        env: environment,
        shell: false,
        stdio: "pipe",
      });
    } catch (cause) {
      throw new DapProtocolClientError(
        "spawn",
        options.adapterId,
        options.stderrPath,
        `failed to spawn command ${options.command}`,
        { cause },
      );
    }
    const stderr = new BoundedAdapterStderr(child.stderr, options.stderrPath);

    try {
      await waitForChildSpawn(child, options);
      if (options.transport === "stdio") {
        return new DapProtocolClient(
          options,
          child,
          child.stdout,
          child.stdin,
          undefined,
          stderr,
          undefined,
        );
      }
      child.stdout.resume();
      const socket = await connectTcpWithRetry(
        options.transport.host,
        selectedPort ?? options.transport.port,
        child,
        options,
      );
      return new DapProtocolClient(options, child, socket, socket, socket, stderr, selectedPort);
    } catch (cause) {
      signalOwnedProcessGroup(child, "SIGTERM");
      await waitUntil(
        processExitPromise(child),
        Date.now() + Math.min(250, options.timeouts.shutdownMs),
      );
      signalOwnedProcessGroup(child, "SIGKILL");
      await stderr.flush();
      if (cause instanceof DapProtocolClientError) throw cause;
      throw new DapProtocolClientError(
        "transport",
        options.adapterId,
        options.stderrPath,
        "failed to start the Debug Adapter transport",
        { cause },
      );
    }
  }

  /** Stable Adapter Definition ID associated with this client. */
  get adapterId(): string {
    return this.options.adapterId;
  }

  /** PID of the owned Debug Adapter process. */
  get adapterPid(): number | undefined {
    return this.child?.pid;
  }

  /** Session path retaining the latest 1 MiB of Debug Adapter stderr. */
  get stderrPath(): string {
    return this.options.stderrPath;
  }

  /** Connect the primary adapter-owned target channel without spawning another process. */
  async connectTargetChannel(
    overrides: DapProtocolTargetChannelOptions = {},
  ): Promise<DapProtocolClient> {
    if (this.options.transport === "stdio" || this.selectedPort === undefined) {
      throw new DapProtocolClientError(
        "transport",
        this.adapterId,
        this.stderrPath,
        "primary target channels require a started TCP Debug Adapter",
      );
    }
    const options: DapProtocolClientOptions = {
      ...this.options,
      startupSignal: overrides.startupSignal,
      onReverseRequest: overrides.onReverseRequest,
      onFailure: overrides.onFailure,
    };
    const socket = await connectTcpWithRetry(
      this.options.transport.host,
      this.selectedPort,
      undefined,
      options,
    );
    return new DapProtocolClient(
      options,
      undefined,
      socket,
      socket,
      socket,
      undefined,
      this.selectedPort,
    );
  }

  /** Subscribe to parsed Debug Adapter events; returns an unsubscribe operation. */
  onEvent(listener: (event: DebugProtocol.Event) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Wait for one parsed Debug Adapter event by name, predicate, timeout, or cancellation. */
  async waitForEvent<TEvent extends DebugProtocol.Event = DebugProtocol.Event>(
    eventName: string,
    options: DapProtocolEventWaitOptions = {},
  ): Promise<TEvent> {
    this.throwIfUnavailable();
    if (options.signal?.aborted === true) throw this.cancelledError(`waiting for ${eventName}`);
    const timeoutMs = options.timeoutMs ?? this.options.timeouts.requestMs;
    return new Promise<TEvent>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.eventListeners.delete(onEvent);
        this.pendingEventWaitRejectors.delete(rejectWait);
      };
      const onEvent = (event: DebugProtocol.Event) => {
        if (event.event !== eventName) return;
        cleanup();
        // SAFETY: The caller chooses TEvent for the named DAP event; every envelope was parsed before this protocol boundary.
        resolve(event as TEvent);
      };
      const onAbort = () => {
        cleanup();
        reject(this.cancelledError(`waiting for ${eventName}`));
      };
      const rejectWait = (error: DapProtocolClientError) => {
        cleanup();
        reject(error);
      };
      this.eventListeners.add(onEvent);
      this.pendingEventWaitRejectors.add(rejectWait);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        cleanup();
        reject(this.timeoutError(`waiting for ${eventName}`, timeoutMs));
      }, timeoutMs);
      timer.unref();
    });
  }

  /** Send one correlated DAP request and return its successful response body. */
  async request<TBody = unknown>(
    command: string,
    argumentsValue?: DapProtocolObject,
    options: DapProtocolRequestOptions = {},
  ): Promise<TBody> {
    this.throwIfUnavailable();
    if (options.signal?.aborted === true) throw this.cancelledError(`${command} request`);
    const sequence = this.nextSequence++;
    const timeoutMs = options.timeoutMs ?? this.options.timeouts.requestMs;
    const request: DebugProtocol.Request = {
      seq: sequence,
      type: "request",
      command,
    };
    if (argumentsValue !== undefined) request.arguments = argumentsValue;

    const response = new Promise<DapProtocolObject | undefined>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        this.pendingRequests.delete(sequence);
        this.abandonedRequestSequences.add(sequence);
        cleanup();
        reject(this.cancelledError(`${command} request`));
      };
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      this.pendingRequests.set(sequence, { command, resolve, reject, cleanup });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        this.pendingRequests.delete(sequence);
        this.abandonedRequestSequences.add(sequence);
        cleanup();
        reject(this.timeoutError(`${command} request`, timeoutMs));
      }, timeoutMs);
      timer.unref();
    });

    try {
      await this.writeMessage(request);
    } catch (cause) {
      const pending = this.pendingRequests.get(sequence);
      this.pendingRequests.delete(sequence);
      pending?.cleanup();
      const error =
        cause instanceof DapProtocolClientError
          ? cause
          : new DapProtocolClientError(
              "transport",
              this.adapterId,
              this.stderrPath,
              `failed to write ${command} request`,
              { cause },
            );
      pending?.reject(error);
    }

    // SAFETY: DAP command/response body pairing is declared by @vscode/debugprotocol; callers select the body type for the command they sent.
    return (await response) as TBody;
  }

  /** Attempt DAP terminate/disconnect, then stop the owned Linux process group within shutdownMs. */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    const shutdown = this.performShutdown();
    this.shutdownPromise = shutdown;
    return shutdown;
  }

  private async performShutdown(): Promise<void> {
    if (this.shuttingDown) return;
    const wasAvailable = this.failure === undefined;
    const deadline = Date.now() + this.options.timeouts.shutdownMs;
    if (wasAvailable) {
      for (const [command, argumentsValue] of [
        ["terminate", {}],
        ["disconnect", { terminateDebuggee: true }],
      ] as const) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        try {
          await this.request(command, argumentsValue, {
            timeoutMs: Math.max(
              1,
              Math.min(this.options.timeouts.requestMs, Math.floor(remaining / 3)),
            ),
          });
        } catch {
          // Shutdown is best effort; process-group ownership is the final guarantee.
        }
      }
    }
    this.shuttingDown = true;
    const shutdownError = new DapProtocolClientError(
      "shutdown",
      this.adapterId,
      this.stderrPath,
      "Debug Adapter client is shutting down",
    );
    this.rejectPending(shutdownError);
    this.rejectEventWaits(shutdownError);
    this.socket?.end();
    if (this.socket === undefined) this.child?.stdin.end();

    if (this.child === undefined) {
      this.reader.removeAllListeners();
      this.writer.destroy();
      return;
    }

    const exit = processExitPromise(this.child);
    const gracefulDeadline = Date.now() + Math.max(0, Math.floor((deadline - Date.now()) / 2));
    if (!(await waitUntil(exit, gracefulDeadline))) {
      signalOwnedProcessGroup(this.child, "SIGTERM");
      const termDeadline = Date.now() + Math.max(0, Math.floor((deadline - Date.now()) / 2));
      if (!(await waitUntil(exit, termDeadline))) {
        signalOwnedProcessGroup(this.child, "SIGKILL");
        await waitUntil(exit, deadline);
      }
    }
    this.reader.removeAllListeners();
    this.writer.destroy();
    await this.stderr?.flush();
  }

  private receiveEnvelope(envelope: ParsedDapEnvelope): void {
    switch (envelope.type) {
      case "response":
        this.receiveResponse(envelope);
        return;
      case "event":
        this.eventListeners.forEach((listener) => listener(envelope));
        return;
      case "request":
        void this.receiveReverseRequest(envelope);
        return;
    }
  }

  private receiveResponse(response: ParsedDapResponse): void {
    const pending = this.pendingRequests.get(response.request_seq);
    if (pending === undefined) {
      if (this.abandonedRequestSequences.delete(response.request_seq)) return;
      this.fail(
        new DapProtocolClientError(
          "protocol",
          this.adapterId,
          this.stderrPath,
          `received an unexpected response for request ${String(response.request_seq)}`,
        ),
      );
      return;
    }
    this.pendingRequests.delete(response.request_seq);
    pending.cleanup();
    if (response.command !== pending.command) {
      const error = new DapProtocolClientError(
        "protocol",
        this.adapterId,
        this.stderrPath,
        `response command ${response.command} does not match request ${pending.command}`,
      );
      pending.reject(error);
      this.fail(error);
      return;
    }
    if (!response.success) {
      pending.reject(
        new DapProtocolClientError(
          "request",
          this.adapterId,
          this.stderrPath,
          `${pending.command} request failed${response.message === undefined ? "" : `: ${response.message}`}`,
        ),
      );
      return;
    }
    pending.resolve(response.body);
  }

  private async receiveReverseRequest(request: ParsedDapRequest): Promise<void> {
    let result: DapReverseRequestResult;
    try {
      result = (await this.options.onReverseRequest?.(request)) ?? {
        success: false,
        message: `unsupported reverse request: ${request.command}`,
      };
    } catch (cause) {
      result = {
        success: false,
        message:
          cause instanceof Error ? cause.message : `reverse request ${request.command} failed`,
      };
    }
    const response: DebugProtocol.Response = {
      seq: this.nextSequence++,
      type: "response",
      request_seq: request.seq,
      command: request.command,
      success: result.success,
    };
    if (result.body !== undefined) response.body = result.body;
    if (!result.success) response.message = result.message;
    try {
      await this.writeMessage(response);
    } catch (cause) {
      this.fail(
        cause instanceof DapProtocolClientError
          ? cause
          : new DapProtocolClientError(
              "transport",
              this.adapterId,
              this.stderrPath,
              `failed to answer reverse request ${request.command}`,
              { cause },
            ),
      );
    }
  }

  private writeMessage(message: DebugProtocol.ProtocolMessage): Promise<void> {
    this.throwIfUnavailable();
    return new Promise((resolve, reject) => {
      this.writer.write(dapFrame(message), (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  private throwIfUnavailable(): void {
    if (this.failure !== undefined) throw this.failure;
    if (this.shuttingDown) {
      throw new DapProtocolClientError(
        "shutdown",
        this.adapterId,
        this.stderrPath,
        "Debug Adapter client is shutting down",
      );
    }
  }

  private fail(error: DapProtocolClientError): void {
    if (this.failure !== undefined || this.shuttingDown) return;
    this.failure = error;
    this.rejectPending(error);
    this.rejectEventWaits(error);
    this.socket?.destroy();
    if (this.socket === undefined && this.child !== undefined) {
      this.child.stdin.destroy();
      this.child.stdout.destroy();
    }
    if (this.child !== undefined) signalOwnedProcessGroup(this.child, "SIGTERM");
    this.options.onFailure?.(error);
  }

  private rejectPending(error: DapProtocolClientError): void {
    for (const pending of this.pendingRequests.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private rejectEventWaits(error: DapProtocolClientError): void {
    for (const rejectWait of this.pendingEventWaitRejectors) rejectWait(error);
    this.pendingEventWaitRejectors.clear();
  }

  private cancelledError(operation: string): DapProtocolClientError {
    return new DapProtocolClientError(
      "cancelled",
      this.adapterId,
      this.stderrPath,
      `${operation} was cancelled`,
    );
  }

  private timeoutError(operation: string, timeoutMs: number): DapProtocolClientError {
    return new DapProtocolClientError(
      "timeout",
      this.adapterId,
      this.stderrPath,
      `${operation} timed out after ${String(timeoutMs)}ms`,
    );
  }
}
