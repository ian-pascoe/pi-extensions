// oxlint-disable anti-slop/no-conditional-empty-object-spread -- Exact optional SDK and store fields must be omitted rather than written as undefined.
// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- This module owns the strict JSON parser boundary for persisted SDK discovery documents.
import { execFile as execFileCallback } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type {
  FetchLike,
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { auth, checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/client";
import { type McpAuthBinding, type McpAuthEntry, McpAuthStore } from "./mcp-auth-store.js";
import type { McpStoreJsonObject, McpStoreJsonValue } from "./mcp-settings-store.js";

/** Construction values for one URL-bound SDK OAuth provider. */
export interface McpOAuthProviderOptions {
  /** Persistent credential store shared by aliases with the same URL and client identity. */
  readonly authStore: McpAuthStore;
  /** Stable OAuth client identity used to bind persisted credentials. */
  readonly clientIdentity: string;
  /** Pre-registered client identifier, when Dynamic Client Registration is unnecessary. */
  readonly clientId?: string;
  /** Secret associated with a pre-registered client identifier. */
  readonly clientSecret?: string;
  /** Receives the authorization URL only during an explicit authentication operation. */
  readonly onAuthorizationUrl: (url: URL) => void | Promise<void>;
  /** Loopback redirect URL registered for this client. */
  readonly redirectUrl: string;
  /** Requested OAuth scopes. */
  readonly scopes?: readonly string[];
  /** Resolved MCP Server URL that owns the credentials. */
  readonly serverUrl: string;
  /** Current epoch time in milliseconds; injectable for token-expiry tests. */
  readonly now?: () => number;
}

/** Safe persistence failure raised only inside the SDK OAuth provider boundary. */
export class McpOAuthPersistenceError extends Error {
  readonly _tag = "McpOAuthPersistenceError" as const;

  constructor(readonly operation: string) {
    super(`MCP OAuth persistence failed during ${operation}`);
  }
}

/** Default loopback endpoint used by explicit MCP OAuth authorization. */
export const DEFAULT_MCP_OAUTH_REDIRECT_URL = "http://127.0.0.1:19876/mcp/oauth/callback";

/** Browser process operation injected by CLI and Pi command composition roots. */
export type McpOAuthExecFile = (
  file: string,
  args: readonly string[],
  options: { readonly shell: false },
) => Promise<void>;

/** Interaction and persistence inputs for one explicit MCP OAuth authorization. */
export interface AuthenticateMcpOAuthOptions {
  /** Strict persistent credential store. */
  readonly authStore: McpAuthStore;
  /** Stable identity used to bind registered clients and credentials. */
  readonly clientIdentity?: string;
  /** Optional pre-registered client ID. HTTPS values also enable CIMD. */
  readonly clientId?: string;
  /** Optional pre-registered client secret. */
  readonly clientSecret?: string;
  /** Executes the platform browser opener without a shell. */
  readonly execFile?: McpOAuthExecFile;
  /** Suppress browser opening while still printing the authorization URL. */
  readonly noOpen?: boolean;
  /** Platform used to select the browser executable. */
  readonly platform?: NodeJS.Platform;
  /** Explicit loopback redirect URL; defaults to {@link DEFAULT_MCP_OAUTH_REDIRECT_URL}. */
  readonly redirectUrl?: string;
  /** Abort the current explicit authorization operation. */
  readonly signal?: AbortSignal;
  /** Requested OAuth scopes. */
  readonly scopes?: readonly string[];
  /** Safe server identifier used only in structured failures. */
  readonly serverId: string;
  /** Resolved remote MCP Server URL. */
  readonly serverUrl: string;
  /** Total interaction budget in milliseconds. */
  readonly timeoutMs?: number;
  /** Optional remote-environment input of a full callback URL or `code state` pair. */
  readonly waitForPaste?: (signal: AbortSignal) => Promise<string>;
  /** Prints the authorization URL before any best-effort browser open. */
  readonly writeAuthorizationUrl: (url: string) => void | Promise<void>;
}

/** Safe expected failure from an explicit OAuth authorization operation. */
export class McpOAuthError extends Error {
  readonly _tag = "McpOAuthError" as const;

  constructor(
    readonly code:
      | "already_active"
      | "authorization_failed"
      | "callback_unavailable"
      | "cancelled"
      | "invalid_callback"
      | "invalid_redirect_uri"
      | "state_mismatch"
      | "store_failed"
      | "timeout",
    readonly serverId: string,
  ) {
    super(`MCP OAuth authorization failed (${code}) for server ${JSON.stringify(serverId)}`);
  }
}

/** Result of an explicit OAuth operation; errors never include credentials or callback values. */
export type AuthenticateMcpOAuthResult =
  | { readonly ok: true }
  | { readonly error: McpOAuthError; readonly ok: false };

function parseJsonValue(input: unknown): McpStoreJsonValue | undefined {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean" ||
    (typeof input === "number" && Number.isFinite(input))
  ) {
    return input;
  }
  if (Array.isArray(input)) {
    const parsed: McpStoreJsonValue[] = [];
    for (const item of input) {
      const value = parseJsonValue(item);
      if (value === undefined) return undefined;
      parsed.push(value);
    }
    return parsed;
  }
  if (typeof input !== "object") return undefined;
  const parsed: Record<string, McpStoreJsonValue> = {};
  for (const [key, item] of Object.entries(input)) {
    if (item === undefined) continue;
    const value = parseJsonValue(item);
    if (value === undefined) return undefined;
    parsed[key] = value;
  }
  return parsed;
}

function parseJsonObject(input: unknown): McpStoreJsonObject | undefined {
  const parsed = parseJsonValue(input);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  // SAFETY: parseJsonValue returned a JSON object after null and array rejection.
  return parsed as McpStoreJsonObject;
}

function discoveryIssuer(entry: McpAuthEntry): string | undefined {
  const metadata = entry.discovery?.authorizationServerMetadata;
  return typeof metadata?.issuer === "string"
    ? metadata.issuer
    : entry.discovery?.authorizationServerUrl;
}

function issuerMatches(
  entry: McpAuthEntry,
  context: OAuthClientInformationContext | undefined,
): boolean {
  if (context === undefined) return true;
  const issuer = discoveryIssuer(entry);
  return (
    issuer === undefined ||
    (URL.canParse(issuer) &&
      URL.canParse(context.issuer) &&
      new URL(issuer).href === new URL(context.issuer).href)
  );
}

/** Public SDK OAuth provider backed by the strict URL-bound MCP auth store. */
export class McpOAuthProvider implements OAuthClientProvider {
  /** HTTPS URL-based Client ID used for Client ID Metadata Documents, when configured. */
  readonly clientMetadataUrl?: string;
  private readonly binding: McpAuthBinding;
  private readonly now: () => number;

  constructor(private readonly options: McpOAuthProviderOptions) {
    this.binding = {
      clientIdentity: options.clientIdentity,
      serverUrl: options.serverUrl,
    };
    this.now = options.now ?? Date.now;
    const clientId = options.clientId;
    if (
      clientId !== undefined &&
      URL.canParse(clientId) &&
      new URL(clientId).protocol === "https:"
    ) {
      this.clientMetadataUrl = clientId;
    }
  }

  /** Loopback redirect URL supplied to authorization and registration requests. */
  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  /** Client metadata used for CIMD or Dynamic Client Registration. */
  get clientMetadata(): OAuthClientMetadata {
    const scope = this.options.scopes?.join(" ");
    return {
      client_name: "Pi MCP",
      client_uri: "https://github.com/ian-pascoe/pi-extensions",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.redirectUrl],
      response_types: ["code"],
      token_endpoint_auth_method: this.options.clientSecret ? "client_secret_post" : "none",
      ...(scope === undefined || scope.length === 0 ? {} : { scope }),
    };
  }

  /** Return configured or dynamically registered client information for the validated issuer. */
  async clientInformation(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    if (this.options.clientId !== undefined) {
      return {
        client_id: this.options.clientId,
        ...(this.options.clientSecret === undefined
          ? {}
          : { client_secret: this.options.clientSecret }),
        ...(context === undefined ? {} : { issuer: context.issuer }),
      };
    }
    const entry = await this.readEntry("load client information");
    const client = entry?.clientInformation;
    if (entry === undefined || client === undefined || !issuerMatches(entry, context))
      return undefined;
    const issuer = context?.issuer ?? discoveryIssuer(entry);
    return {
      client_id: client.clientId,
      ...(client.clientIdIssuedAt === undefined
        ? {}
        : { client_id_issued_at: client.clientIdIssuedAt }),
      ...(client.clientSecret === undefined ? {} : { client_secret: client.clientSecret }),
      ...(client.clientSecretExpiresAt === undefined
        ? {}
        : { client_secret_expires_at: client.clientSecretExpiresAt }),
      ...(issuer === undefined ? {} : { issuer }),
    };
  }

  /** Persist dynamically registered client information without logging credentials. */
  async saveClientInformation(
    client: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    await this.updateEntry(
      {
        clientInformation: {
          clientId: client.client_id,
          ...(client.client_id_issued_at === undefined
            ? {}
            : { clientIdIssuedAt: client.client_id_issued_at }),
          ...(client.client_secret === undefined ? {} : { clientSecret: client.client_secret }),
          ...(client.client_secret_expires_at === undefined
            ? {}
            : { clientSecretExpiresAt: client.client_secret_expires_at }),
          ...(this.clientMetadataUrl === undefined
            ? {}
            : { metadataDocumentUrl: this.clientMetadataUrl }),
        },
      },
      "save client information",
    );
    if (context !== undefined) await this.ensureIssuerRecorded(context.issuer);
  }

  /** Load the latest token set, retaining its authorization-server issuer stamp. */
  async tokens(context?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    const entry = await this.readEntry("load tokens");
    const tokens = entry?.tokens;
    if (entry === undefined || tokens === undefined || !issuerMatches(entry, context))
      return undefined;
    const issuer = context?.issuer ?? discoveryIssuer(entry);
    const expiresIn =
      tokens.expiresAt === undefined
        ? undefined
        : Math.max(0, Math.floor(tokens.expiresAt - this.now() / 1_000));
    return {
      access_token: tokens.accessToken,
      ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
      ...(issuer === undefined ? {} : { issuer }),
      ...(tokens.refreshToken === undefined ? {} : { refresh_token: tokens.refreshToken }),
      ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
      token_type: tokens.tokenType,
    };
  }

  /** Persist newly issued or refreshed OAuth tokens in the mode-0600 auth store. */
  async saveTokens(
    tokens: StoredOAuthTokens,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    await this.updateEntry(
      {
        tokens: {
          accessToken: tokens.access_token,
          ...(tokens.expires_in === undefined
            ? {}
            : { expiresAt: this.now() / 1_000 + tokens.expires_in }),
          ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
          ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
          tokenType: tokens.token_type ?? "Bearer",
        },
      },
      "save tokens",
    );
    const issuer = context?.issuer ?? tokens.issuer;
    if (issuer !== undefined) await this.ensureIssuerRecorded(issuer);
  }

  /** Present the authorization URL through the explicit interaction owner. */
  redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    return this.options.onAuthorizationUrl(authorizationUrl);
  }

  /** Persist the PKCE verifier before leaving the process for authorization. */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.updateEntry({ authorization: { codeVerifier } }, "save PKCE verifier");
  }

  /** Load the PKCE verifier required for authorization-code exchange. */
  async codeVerifier(): Promise<string> {
    const entry = await this.readEntry("load PKCE verifier");
    const codeVerifier = entry?.authorization?.codeVerifier;
    if (codeVerifier === undefined) throw new McpOAuthPersistenceError("load PKCE verifier");
    return codeVerifier;
  }

  /** Generate or restore the CSRF state bound to the active URL/client identity. */
  async state(): Promise<string> {
    const entry = await this.readEntry("load authorization state");
    const existing = entry?.authorization?.state;
    if (existing !== undefined) return existing;
    const state = randomBytes(32).toString("hex");
    await this.updateEntry({ authorization: { state } }, "save authorization state");
    return state;
  }

  /** Persist SDK-validated RFC 9728 and authorization-server discovery state. */
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const authorizationServerMetadata = parseJsonObject(state.authorizationServerMetadata);
    const protectedResourceMetadata = parseJsonObject(state.resourceMetadata);
    await this.updateEntry(
      {
        discovery: {
          authorizationServerUrl: state.authorizationServerUrl,
          ...(authorizationServerMetadata === undefined ? {} : { authorizationServerMetadata }),
          ...(protectedResourceMetadata === undefined ? {} : { protectedResourceMetadata }),
          ...(state.resourceMetadataUrl === undefined
            ? {}
            : { resourceMetadataUrl: state.resourceMetadataUrl }),
        },
      },
      "save discovery state",
    );
  }

  /** Restore only URL- and issuer-consistent discovery state for the SDK. */
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const entry = await this.readEntry("load discovery state");
    const discovery = entry?.discovery;
    if (discovery?.authorizationServerUrl === undefined) return undefined;
    const metadata = discovery.authorizationServerMetadata;
    const issuer = typeof metadata?.issuer === "string" ? metadata.issuer : undefined;
    if (
      !URL.canParse(discovery.authorizationServerUrl) ||
      (issuer !== undefined &&
        (!URL.canParse(issuer) ||
          new URL(issuer).href !== new URL(discovery.authorizationServerUrl).href))
    ) {
      return undefined;
    }
    const resource = discovery.protectedResourceMetadata?.resource;
    if (
      resource !== undefined &&
      (typeof resource !== "string" ||
        !URL.canParse(resource) ||
        !checkResourceAllowed({
          configuredResource: resource,
          requestedResource: resourceUrlFromServerUrl(this.options.serverUrl),
        }))
    ) {
      return undefined;
    }
    const resourceMetadataUrl = discovery.resourceMetadataUrl;
    if (
      resourceMetadataUrl !== undefined &&
      (!URL.canParse(resourceMetadataUrl) ||
        !["http:", "https:"].includes(new URL(resourceMetadataUrl).protocol))
    ) {
      return undefined;
    }
    // SAFETY: McpAuthStore recursively parsed every persisted JSON value. The URL, issuer,
    // and protected-resource fields used by the SDK are refined above; remaining extension
    // fields are opaque JSON preserved from SDK-produced discovery documents.
    return {
      authorizationServerUrl: discovery.authorizationServerUrl,
      ...(metadata === undefined ? {} : { authorizationServerMetadata: metadata }),
      ...(discovery.protectedResourceMetadata === undefined
        ? {}
        : { resourceMetadata: discovery.protectedResourceMetadata }),
      ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
    } as OAuthDiscoveryState;
  }

  /** Remove the selected SDK credential scope from the bound auth entry. */
  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all") {
      const removed = await this.options.authStore.removeEntry(this.binding);
      if (!removed.ok) throw new McpOAuthPersistenceError("remove credentials");
      return;
    }
    await this.updateEntry(
      scope === "client"
        ? { clientInformation: null }
        : scope === "tokens"
          ? { tokens: null }
          : scope === "discovery"
            ? { discovery: null }
            : { authorization: null },
      `invalidate ${scope}`,
    );
  }

  private async readEntry(operation: string): Promise<McpAuthEntry | undefined> {
    const result = await this.options.authStore.readEntry(this.binding);
    if (!result.ok) throw new McpOAuthPersistenceError(operation);
    return result.value;
  }

  private async updateEntry(
    patch: Parameters<McpAuthStore["updateEntry"]>[1],
    operation: string,
  ): Promise<void> {
    const result = await this.options.authStore.updateEntry(this.binding, patch);
    if (!result.ok) throw new McpOAuthPersistenceError(operation);
  }

  private async ensureIssuerRecorded(issuer: string): Promise<void> {
    const entry = await this.readEntry("load issuer binding");
    if (entry?.discovery?.authorizationServerUrl !== undefined) return;
    await this.updateEntry(
      { discovery: { authorizationServerUrl: new URL(issuer).href } },
      "save issuer binding",
    );
  }
}

interface OAuthCallbackParameters {
  readonly code?: string;
  readonly error?: string;
  readonly iss?: string;
  readonly state?: string;
}

let authorizationActive = false;

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function parseLoopbackRedirect(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && isLoopbackHostname(url.hostname) ? url : undefined;
  } catch {
    return undefined;
  }
}

function callbackParameters(searchParams: URLSearchParams): OAuthCallbackParameters {
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const iss = searchParams.get("iss");
  const state = searchParams.get("state");
  return {
    ...(code === null ? {} : { code }),
    ...(error === null ? {} : { error }),
    ...(iss === null ? {} : { iss }),
    ...(state === null ? {} : { state }),
  };
}

function parseCallbackInput(input: string, redirectUrl: URL): OAuthCallbackParameters | undefined {
  const trimmed = input.trim();
  if (URL.canParse(trimmed)) {
    const callbackUrl = new URL(trimmed);
    if (
      callbackUrl.origin !== redirectUrl.origin ||
      callbackUrl.pathname !== redirectUrl.pathname
    ) {
      return undefined;
    }
    return callbackParameters(callbackUrl.searchParams);
  }
  const pair = trimmed.split(/\s+/u);
  return pair.length === 2 && pair[0] !== undefined && pair[1] !== undefined
    ? { code: pair[0], state: pair[1] }
    : undefined;
}

function callbackParametersFromUrl(url: URL): OAuthCallbackParameters {
  return callbackParameters(url.searchParams);
}

function listen(server: Server, redirectUrl: URL): Promise<void> {
  const port = redirectUrl.port.length > 0 ? Number(redirectUrl.port) : 80;
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, redirectUrl.hostname === "[::1]" ? "::1" : redirectUrl.hostname);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
  });
}

function createCallbackServer(
  redirectUrl: URL,
  resolveCallback: (parameters: OAuthCallbackParameters) => void,
): Server {
  return createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", redirectUrl.origin);
    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      response.end("Method not allowed");
      return;
    }
    if (requestUrl.pathname !== redirectUrl.pathname) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    resolveCallback(callbackParametersFromUrl(requestUrl));
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("Authorization received. You may close this window.");
  });
}

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { shell: false },
): Promise<void> {
  return new Promise((resolveExecution, rejectExecution) => {
    execFileCallback(file, args, options, (error) => {
      if (error === null) resolveExecution();
      else rejectExecution(error);
    });
  });
}

function browserCommand(
  platform: NodeJS.Platform,
  url: string,
): readonly [string, readonly string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") {
    return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  }
  return ["xdg-open", [url]];
}

function statesMatch(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return (
    receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes)
  );
}

function mcpOAuthAbortError(
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  serverId: string,
): McpOAuthError {
  return new McpOAuthError(
    signal.reason === timeoutSignal.reason ? "timeout" : "cancelled",
    serverId,
  );
}

function waitForAbort(
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  serverId: string,
): Promise<never> {
  return new Promise((_, rejectAbort) => {
    const reject = (): void => rejectAbort(mcpOAuthAbortError(signal, timeoutSignal, serverId));
    if (signal.aborted) reject();
    else signal.addEventListener("abort", reject, { once: true });
  });
}

/** Run one explicit OAuth authorization through SDK discovery, DCR/CIMD, and token exchange. */
export async function authenticateMcpOAuth(
  options: AuthenticateMcpOAuthOptions,
): Promise<AuthenticateMcpOAuthResult> {
  if (authorizationActive) {
    return { error: new McpOAuthError("already_active", options.serverId), ok: false };
  }
  const redirectUrl = parseLoopbackRedirect(options.redirectUrl ?? DEFAULT_MCP_OAUTH_REDIRECT_URL);
  if (redirectUrl === undefined) {
    return { error: new McpOAuthError("invalid_redirect_uri", options.serverId), ok: false };
  }
  if (options.signal?.aborted === true) {
    return { error: new McpOAuthError("cancelled", options.serverId), ok: false };
  }

  authorizationActive = true;
  const controller = new AbortController();
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 5 * 60_000);
  const signal = AbortSignal.any([
    controller.signal,
    timeoutSignal,
    ...(options.signal === undefined ? [] : [options.signal]),
  ]);
  const authCalls: Promise<unknown>[] = [];
  const fetchFn: FetchLike = (input, init) => fetch(input, { ...init, signal });
  let resolveLoopback: (parameters: OAuthCallbackParameters) => void = () => undefined;
  const loopback = new Promise<OAuthCallbackParameters>((resolveCallback) => {
    resolveLoopback = resolveCallback;
  });
  const callbackServer = createCallbackServer(redirectUrl, resolveLoopback);

  try {
    try {
      await listen(callbackServer, redirectUrl);
    } catch {
      return { error: new McpOAuthError("callback_unavailable", options.serverId), ok: false };
    }

    const provider = new McpOAuthProvider({
      authStore: options.authStore,
      clientIdentity: options.clientIdentity ?? "@ian-pascoe/pi-mcp",
      ...(options.clientId === undefined ? {} : { clientId: options.clientId }),
      ...(options.clientSecret === undefined ? {} : { clientSecret: options.clientSecret }),
      onAuthorizationUrl: async (authorizationUrl) => {
        await options.writeAuthorizationUrl(authorizationUrl.href);
        if (options.noOpen === true) return;
        const [file, args] = browserCommand(
          options.platform ?? process.platform,
          authorizationUrl.href,
        );
        await (options.execFile ?? defaultExecFile)(file, args, { shell: false }).catch(
          () => undefined,
        );
      },
      redirectUrl: redirectUrl.href,
      ...(options.scopes === undefined ? {} : { scopes: options.scopes }),
      serverUrl: options.serverUrl,
    });
    const scope = options.scopes?.join(" ");
    await provider.invalidateCredentials("verifier");
    const firstAuth = auth(provider, {
      fetchFn,
      serverUrl: options.serverUrl,
      ...(scope === undefined || scope.length === 0 ? {} : { scope }),
    });
    authCalls.push(firstAuth);
    const abortFailure = waitForAbort(signal, timeoutSignal, options.serverId);
    const first = await Promise.race([firstAuth, abortFailure]);
    if (first === "AUTHORIZED") return { ok: true };

    const pasted = options
      .waitForPaste?.(signal)
      .then((input) => parseCallbackInput(input, redirectUrl));
    const parameters = await Promise.race([
      pasted === undefined ? loopback : Promise.race([loopback, pasted]),
      abortFailure,
    ]);
    if (parameters === undefined) {
      return { error: new McpOAuthError("invalid_callback", options.serverId), ok: false };
    }
    const expectedState = await provider.state();
    if (parameters.state === undefined || !statesMatch(parameters.state, expectedState)) {
      return { error: new McpOAuthError("state_mismatch", options.serverId), ok: false };
    }
    if (parameters.error !== undefined) {
      return { error: new McpOAuthError("authorization_failed", options.serverId), ok: false };
    }
    if (parameters.code === undefined) {
      return { error: new McpOAuthError("invalid_callback", options.serverId), ok: false };
    }
    const completionAuth = auth(provider, {
      authorizationCode: parameters.code,
      fetchFn,
      ...(parameters.iss === undefined ? {} : { iss: parameters.iss }),
      serverUrl: options.serverUrl,
      ...(scope === undefined || scope.length === 0 ? {} : { scope }),
    });
    authCalls.push(completionAuth);
    const completed = await Promise.race([completionAuth, abortFailure]);
    if (completed !== "AUTHORIZED") {
      return { error: new McpOAuthError("authorization_failed", options.serverId), ok: false };
    }
    await provider.invalidateCredentials("verifier");
    return { ok: true };
  } catch (cause) {
    if (signal.aborted) {
      return { error: mcpOAuthAbortError(signal, timeoutSignal, options.serverId), ok: false };
    }
    if (cause instanceof McpOAuthError) return { error: cause, ok: false };
    return {
      error: new McpOAuthError(
        cause instanceof McpOAuthPersistenceError ? "store_failed" : "authorization_failed",
        options.serverId,
      ),
      ok: false,
    };
  } finally {
    controller.abort();
    await Promise.allSettled(authCalls);
    await closeServer(callbackServer);
    authorizationActive = false;
  }
}
