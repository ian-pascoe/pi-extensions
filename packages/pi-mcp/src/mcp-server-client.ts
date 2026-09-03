import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  createFetchWithInit,
  type AuthProvider,
  type ClientContext,
  type ClientOptions,
  type CreateMessageRequest,
  type CreateMessageResult,
  type CreateMessageResultWithTools,
  type ElicitRequest,
  type ElicitResult,
  type FetchLike,
  type Implementation,
  type ListRootsRequest,
  type ListRootsResult,
  type OAuthClientProvider,
  type RequestOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { mcpJsonSchemaValidator } from "./mcp-json-schema.js";
import { MCP_SHUTDOWN_TIMEOUT_MS, type McpServerDefinition } from "./pi-mcp-settings.js";

const MAX_MCP_LIST_PAGES = 1_000;

type McpConnectableServerDefinition =
  | Pick<
      Extract<McpServerDefinition, { readonly transport: "stdio" }>,
      "args" | "command" | "cwd" | "environment" | "transport"
    >
  | Pick<
      Extract<McpServerDefinition, { readonly transport: "http" | "sse" }>,
      "auth" | "headers" | "transport" | "url"
    >;

type McpClientTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

/** Request-scoped Host callbacks used for MCP sampling, elicitation, and roots. */
export interface McpServerRequestCallbacks<PiContext> {
  readonly onElicitation?: (
    request: ElicitRequest,
    piContext: PiContext,
    clientContext: ClientContext,
  ) => Promise<ElicitResult> | ElicitResult;
  readonly onListRoots?: (
    request: ListRootsRequest,
    piContext: PiContext,
    clientContext: ClientContext,
  ) => Promise<ListRootsResult> | ListRootsResult;
  readonly onSampling?: (
    request: CreateMessageRequest,
    piContext: PiContext,
    clientContext: ClientContext,
  ) =>
    | Promise<CreateMessageResult | CreateMessageResultWithTools>
    | CreateMessageResult
    | CreateMessageResultWithTools;
}

/** Per-call cancellation, progress, and Pi request context. */
export interface McpServerRunOptions<PiContext> {
  readonly callbacks?: McpServerRequestCallbacks<PiContext>;
  readonly onProgress?: NonNullable<RequestOptions["onprogress"]>;
  readonly piContext?: PiContext;
  readonly signal?: AbortSignal;
}

/** Inputs required to connect one owned MCP Client to one Server Definition. */
export interface McpServerClientConnectOptions {
  readonly authProvider?: AuthProvider | OAuthClientProvider;
  readonly clientInfo: Implementation;
  readonly connectTimeoutMs: number;
  readonly definition: McpConnectableServerDefinition;
  readonly onConnectionClose?: () => void;
  readonly listChanged?: ClientOptions["listChanged"];
  readonly onError?: (error: Error) => void;
  readonly onStderr?: (text: string) => void;
  readonly piCwd: string;
  readonly requestTimeoutMs: number;
}

interface ActiveMcpRunContext {
  callbacks?: McpServerRequestCallbacks<unknown>;
  piContext?: unknown;
}

function requestHeaders(
  definition: Extract<McpConnectableServerDefinition, { transport: "http" | "sse" }>,
): Headers {
  const headers = new Headers(definition.headers);
  if (definition.auth?.type === "bearer") {
    headers.set("Authorization", `Bearer ${definition.auth.token}`);
  }
  return headers;
}

async function readMcpAuthToken(
  authProvider: AuthProvider | OAuthClientProvider,
): Promise<string | undefined> {
  if ("token" in authProvider) return authProvider.token();
  return (await authProvider.tokens())?.access_token;
}

function createAuthenticatedFetch(
  authProvider: AuthProvider | OAuthClientProvider,
  requestInit: RequestInit,
): FetchLike {
  const fetchWithHeaders = createFetchWithInit(undefined, requestInit);
  return async (input, init) => {
    const token = await readMcpAuthToken(authProvider);
    if (token === undefined) return fetchWithHeaders(input, init);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetchWithHeaders(input, { ...init, headers });
  };
}

function createMcpTransport(options: McpServerClientConnectOptions): McpClientTransport {
  const definition = options.definition;
  if (definition.transport === "stdio") {
    return new StdioClientTransport({
      args: [...definition.args],
      command: definition.command,
      cwd: resolve(options.piCwd, definition.cwd ?? "."),
      env: { ...getDefaultEnvironment(), ...definition.environment },
      stderr: "pipe",
    });
  }

  const headers = requestHeaders(definition);
  const requestInit = { headers } satisfies RequestInit;
  if (definition.transport === "http") {
    const transportOptions: NonNullable<
      ConstructorParameters<typeof StreamableHTTPClientTransport>[1]
    > = { requestInit };
    if (options.authProvider !== undefined) transportOptions.authProvider = options.authProvider;
    return new StreamableHTTPClientTransport(new URL(definition.url), transportOptions);
  }

  const transportOptions: NonNullable<ConstructorParameters<typeof SSEClientTransport>[1]> = {
    requestInit,
  };
  if ([...headers].length > 0) {
    transportOptions.eventSourceInit = {
      fetch:
        options.authProvider === undefined
          ? createFetchWithInit(undefined, requestInit)
          : createAuthenticatedFetch(options.authProvider, requestInit),
    };
  }
  if (options.authProvider !== undefined) transportOptions.authProvider = options.authProvider;
  return new SSEClientTransport(new URL(definition.url), transportOptions);
}

function closeBeforeDeadline(
  close: () => Promise<void>,
  processId: number | undefined,
): Promise<void> {
  return new Promise((resolveClose) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveClose();
    };
    const timer = setTimeout(() => {
      if (processId !== undefined) {
        try {
          process.kill(processId, "SIGKILL");
        } catch {
          // The owned child already exited.
        }
      }
      finish();
    }, MCP_SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    close().then(finish, finish);
  });
}

/** Owns one official MCP Client, its transport, request contexts, and bounded cleanup. */
export class McpServerClient {
  private readonly activeRuns = new Set<ActiveMcpRunContext>();
  private callbackTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private closing = false;
  private connected = false;
  private readonly requestContext = new AsyncLocalStorage<ActiveMcpRunContext>();

  private constructor(
    private readonly client: Client,
    private readonly transport: McpClientTransport,
    private readonly requestTimeoutMs: number,
  ) {}

  /** Connect one MCP Client with automatic current/legacy protocol negotiation. */
  static async connect(options: McpServerClientConnectOptions): Promise<McpServerClient> {
    const transport = createMcpTransport(options);
    if (transport instanceof StdioClientTransport && options.onStderr !== undefined) {
      transport.stderr?.on("data", (chunk: Buffer | string) =>
        options.onStderr?.(chunk.toString()),
      );
    }

    const clientOptions: ClientOptions = {
      capabilities: {
        elicitation: { form: {}, url: {} },
        roots: {},
        sampling: {},
      },
      inputRequired: { maxRounds: 10 },
      jsonSchemaValidator: mcpJsonSchemaValidator,
      listMaxPages: MAX_MCP_LIST_PAGES,
      versionNegotiation: {
        mode: "auto",
        probe: { timeoutMs: options.connectTimeoutMs },
      },
    };
    if (options.listChanged !== undefined) clientOptions.listChanged = options.listChanged;
    const client = new Client(options.clientInfo, clientOptions);
    const owner = new McpServerClient(client, transport, options.requestTimeoutMs);
    if (options.onError !== undefined) client.onerror = options.onError;
    client.onclose = () => {
      const wasUnexpected = owner.connected && !owner.closing;
      owner.connected = false;
      if (wasUnexpected) options.onConnectionClose?.();
    };
    owner.registerRequestHandlers();

    try {
      await client.connect(transport, {
        maxTotalTimeout: options.connectTimeoutMs,
        timeout: options.connectTimeoutMs,
      });
      owner.connected = true;
      return owner;
    } catch (cause) {
      await owner.close();
      throw cause;
    }
  }

  /** Negotiated protocol revision for the connected MCP Server. */
  get negotiatedProtocolVersion(): string | undefined {
    return this.client.getNegotiatedProtocolVersion();
  }

  /** Negotiated current or legacy protocol era. */
  get protocolEra(): "modern" | "legacy" | undefined {
    return this.client.getProtocolEra();
  }

  /** Server Instructions reported during connection. */
  get instructions(): string | undefined {
    return this.client.getInstructions();
  }

  /** Direct stdio child process identifier, when this Client owns one. */
  get processId(): number | undefined {
    if (!(this.transport instanceof StdioClientTransport)) return undefined;
    return this.transport.pid ?? undefined;
  }

  /** Run one MCP operation with isolated Pi context, cancellation, progress, and timeout reset. */
  async run<Result, PiContext = undefined>(
    operation: (client: Client, requestOptions: RequestOptions) => Promise<Result>,
    options: McpServerRunOptions<PiContext> = {},
  ): Promise<Result> {
    if (this.closing || !this.connected) {
      throw new Error("Pi MCP Client is not connected");
    }
    if (options.callbacks !== undefined) {
      const predecessor = this.callbackTail;
      let release: () => void = () => undefined;
      this.callbackTail = new Promise<void>((resolveTail) => {
        release = resolveTail;
      });
      await predecessor;
      try {
        return await this.runOperation(operation, options);
      } finally {
        release();
      }
    }
    return this.runOperation(operation, options);
  }

  private async runOperation<Result, PiContext = undefined>(
    operation: (client: Client, requestOptions: RequestOptions) => Promise<Result>,
    options: McpServerRunOptions<PiContext>,
  ): Promise<Result> {
    const context: ActiveMcpRunContext = {};
    if (options.callbacks !== undefined) {
      // SAFETY: The callback and piContext originate from the same generic run invocation and stay paired in this private context.
      context.callbacks = options.callbacks as McpServerRequestCallbacks<unknown>;
    }
    if (options.piContext !== undefined) context.piContext = options.piContext;
    const requestOptions: RequestOptions = {
      resetTimeoutOnProgress: true,
      timeout: this.requestTimeoutMs,
    };
    if (options.onProgress !== undefined) requestOptions.onprogress = options.onProgress;
    if (options.signal !== undefined) requestOptions.signal = options.signal;
    if (options.callbacks !== undefined) this.activeRuns.add(context);
    try {
      return await this.requestContext.run(context, () => operation(this.client, requestOptions));
    } finally {
      if (options.callbacks !== undefined) this.activeRuns.delete(context);
    }
  }

  /** Close the Client once, forcing its owned stdio process after five seconds. */
  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closing = true;
    const processId = this.processId;
    this.closePromise = closeBeforeDeadline(() => this.client.close(), processId).finally(() => {
      this.connected = false;
    });
    return this.closePromise;
  }

  private registerRequestHandlers(): void {
    this.client.setRequestHandler("sampling/createMessage", (request, clientContext) => {
      const context = this.resolveRequestContext("sampling/createMessage");
      const callback = context.callbacks?.onSampling;
      if (callback === undefined) {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          "Pi MCP sampling callback is unavailable",
        );
      }
      return callback(request, context.piContext, clientContext);
    });
    this.client.setRequestHandler("elicitation/create", (request, clientContext) => {
      const context = this.resolveRequestContext("elicitation/create");
      const callback = context.callbacks?.onElicitation;
      if (callback === undefined) {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          "Pi MCP elicitation callback is unavailable",
        );
      }
      return callback(request, context.piContext, clientContext);
    });
    this.client.setRequestHandler("roots/list", (request, clientContext) => {
      const context = this.resolveRequestContext("roots/list");
      const callback = context.callbacks?.onListRoots;
      if (callback === undefined) {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          "Pi MCP roots callback is unavailable",
        );
      }
      return callback(request, context.piContext, clientContext);
    });
  }

  private resolveRequestContext(method: string): ActiveMcpRunContext {
    const current = this.requestContext.getStore();
    if (current !== undefined) return current;
    if (this.activeRuns.size === 1) {
      const onlyContext = this.activeRuns.values().next().value;
      if (onlyContext !== undefined) return onlyContext;
    }
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `Pi MCP ${method} request context is ambiguous`,
    );
  }
}
