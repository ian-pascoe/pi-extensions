import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { McpAuthStore } from "../src/mcp-auth-store.js";
import { authenticateMcpOAuth, McpOAuthProvider } from "../src/mcp-oauth.js";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server.listening) resolveClose();
    else server.close(() => resolveClose());
  });
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's public Server.address() union is refined at this test fixture boundary.
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  return address.port;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  servers.splice(servers.indexOf(server), 1);
  return port;
}

async function createOAuthFixture(
  options: {
    readonly issuerResponseSupported?: boolean;
    readonly mismatchedResource?: boolean;
  } = {},
): Promise<{
  readonly baseUrl: string;
  readonly requests: string[];
  readonly serverUrl: string;
}> {
  const requests: string[] = [];
  let baseUrl = "";
  const serverUrlPath = "/mcp";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", baseUrl);
    requests.push(`${request.method} ${url.pathname}`);
    response.setHeader("content-type", "application/json");
    if (url.pathname.includes("oauth-protected-resource")) {
      response.end(
        JSON.stringify({
          authorization_servers: [baseUrl],
          resource: options.mismatchedResource ? `${baseUrl}/other` : `${baseUrl}${serverUrlPath}`,
        }),
      );
      return;
    }
    if (
      url.pathname.includes("oauth-authorization-server") ||
      url.pathname.includes("openid-configuration")
    ) {
      response.end(
        JSON.stringify({
          authorization_endpoint: `${baseUrl}/authorize`,
          authorization_response_iss_parameter_supported: options.issuerResponseSupported ?? true,
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          issuer: baseUrl,
          registration_endpoint: `${baseUrl}/register`,
          response_types_supported: ["code"],
          token_endpoint: `${baseUrl}/token`,
          token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
        }),
      );
      return;
    }
    if (url.pathname === "/register") {
      response.end(
        JSON.stringify({
          client_id: "dynamic-client",
          client_name: "Pi MCP",
          client_secret: "dynamic-secret",
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: ["http://127.0.0.1/callback"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_post",
        }),
      );
      return;
    }
    if (url.pathname === "/token") {
      response.end(
        JSON.stringify({
          access_token: "issued-access",
          expires_in: 3600,
          refresh_token: "issued-refresh",
          token_type: "Bearer",
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });
  const port = await listen(server);
  baseUrl = `http://127.0.0.1:${port}`;
  return { baseUrl, requests, serverUrl: `${baseUrl}${serverUrlPath}` };
}

test("persists SDK OAuth provider state through the URL-bound auth store", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "pi-mcp-oauth-"));
  temporaryDirectories.push(agentDirectory);
  const provider = new McpOAuthProvider({
    authStore: new McpAuthStore(agentDirectory),
    clientIdentity: "pi-mcp",
    onAuthorizationUrl: () => undefined,
    redirectUrl: "http://127.0.0.1:19876/callback",
    serverUrl: "https://mcp.example.test/rpc",
  });

  await provider.saveCodeVerifier("verifier");
  await provider.saveDiscoveryState({
    authorizationServerUrl: "https://auth.example.test/",
    resourceMetadata: { resource: "https://mcp.example.test/rpc" },
    resourceMetadataUrl: "https://mcp.example.test/.well-known/oauth-protected-resource/rpc",
  });
  await provider.saveClientInformation(
    { client_id: "registered", client_secret: "secret", issuer: "https://auth.example.test/" },
    { issuer: "https://auth.example.test/" },
  );
  await provider.saveTokens(
    {
      access_token: "access",
      expires_in: 60,
      issuer: "https://auth.example.test/",
      refresh_token: "refresh",
      token_type: "Bearer",
    },
    { issuer: "https://auth.example.test/" },
  );

  await expect(provider.codeVerifier()).resolves.toBe("verifier");
  await expect(
    provider.clientInformation({ issuer: "https://auth.example.test/" }),
  ).resolves.toMatchObject({
    client_id: "registered",
    client_secret: "secret",
    issuer: "https://auth.example.test/",
  });
  await expect(provider.tokens()).resolves.toMatchObject({
    access_token: "access",
    issuer: "https://auth.example.test/",
    refresh_token: "refresh",
    token_type: "Bearer",
  });
  await expect(provider.discoveryState()).resolves.toMatchObject({
    authorizationServerUrl: "https://auth.example.test/",
    resourceMetadata: { resource: "https://mcp.example.test/rpc" },
    resourceMetadataUrl: "https://mcp.example.test/.well-known/oauth-protected-resource/rpc",
  });

  const clientMetadataUrl = "https://client.example.test/oauth-metadata.json";
  const cimdProvider = new McpOAuthProvider({
    authStore: new McpAuthStore(agentDirectory),
    clientId: clientMetadataUrl,
    clientIdentity: "pi-mcp-cimd",
    onAuthorizationUrl: () => undefined,
    redirectUrl: "http://127.0.0.1:19876/callback",
    serverUrl: "https://mcp.example.test/rpc",
  });
  expect(cimdProvider.clientMetadataUrl).toBe(clientMetadataUrl);
  await expect(cimdProvider.clientInformation()).resolves.toMatchObject({
    client_id: clientMetadataUrl,
  });
});

test("runs explicit SDK discovery, DCR, loopback state validation, and token exchange", async () => {
  const fixture = await createOAuthFixture();
  const callbackPort = await availablePort();
  const redirectUrl = `http://127.0.0.1:${callbackPort}/mcp/oauth/callback`;
  const agentDirectory = await mkdtemp(join(tmpdir(), "pi-mcp-oauth-"));
  temporaryDirectories.push(agentDirectory);
  const authStore = new McpAuthStore(agentDirectory);
  const events: string[] = [];
  let callback: Promise<Response> | undefined;

  const result = await authenticateMcpOAuth({
    authStore,
    execFile: async (_file, _args, options) => {
      expect(options).toEqual({ shell: false });
      events.push("open");
    },
    platform: "linux",
    redirectUrl,
    serverId: "fixture",
    serverUrl: fixture.serverUrl,
    timeoutMs: 2_000,
    writeAuthorizationUrl: (authorizationUrl) => {
      events.push("write");
      const url = new URL(authorizationUrl);
      const state = url.searchParams.get("state");
      expect(state).toBeTruthy();
      callback = fetch(
        `${redirectUrl}?code=approved-code&state=${encodeURIComponent(state ?? "")}&iss=${encodeURIComponent(fixture.baseUrl)}`,
      );
    },
  });

  expect(result).toEqual({ ok: true });
  await expect(callback).resolves.toMatchObject({ status: 200 });
  expect(events).toEqual(["write", "open"]);
  expect(fixture.requests).toEqual(expect.arrayContaining(["POST /register", "POST /token"]));
  const stored = await authStore.readEntry({
    clientIdentity: "@ian-pascoe/pi-mcp",
    serverUrl: fixture.serverUrl,
  });
  expect(stored).toMatchObject({
    ok: true,
    value: {
      clientInformation: { clientId: "dynamic-client" },
      tokens: { accessToken: "issued-access", refreshToken: "issued-refresh" },
    },
  });
});

test("accepts a pasted full callback URL and honors --no-open", async () => {
  const fixture = await createOAuthFixture();
  const callbackPort = await availablePort();
  const redirectUrl = `http://127.0.0.1:${callbackPort}/custom/callback`;
  const agentDirectory = await mkdtemp(join(tmpdir(), "pi-mcp-oauth-"));
  temporaryDirectories.push(agentDirectory);
  let authorizationState = "";
  let openCalls = 0;

  const result = await authenticateMcpOAuth({
    authStore: new McpAuthStore(agentDirectory),
    execFile: async () => {
      openCalls += 1;
    },
    noOpen: true,
    redirectUrl,
    serverId: "pasted",
    serverUrl: fixture.serverUrl,
    timeoutMs: 2_000,
    waitForPaste: async () =>
      `${redirectUrl}?code=pasted-code&state=${encodeURIComponent(authorizationState)}&iss=${encodeURIComponent(fixture.baseUrl)}`,
    writeAuthorizationUrl: (authorizationUrl) => {
      authorizationState = new URL(authorizationUrl).searchParams.get("state") ?? "";
    },
  });

  expect(result).toEqual({ ok: true });
  expect(openCalls).toBe(0);
});

test("accepts a pasted authorization code paired with its returned state", async () => {
  const fixture = await createOAuthFixture({ issuerResponseSupported: false });
  const callbackPort = await availablePort();
  const agentDirectory = await mkdtemp(join(tmpdir(), "pi-mcp-oauth-"));
  temporaryDirectories.push(agentDirectory);
  let authorizationState = "";

  const result = await authenticateMcpOAuth({
    authStore: new McpAuthStore(agentDirectory),
    noOpen: true,
    redirectUrl: `http://127.0.0.1:${callbackPort}/callback`,
    serverId: "code-state",
    serverUrl: fixture.serverUrl,
    timeoutMs: 2_000,
    waitForPaste: async () => `pasted-code ${authorizationState}`,
    writeAuthorizationUrl: (authorizationUrl) => {
      authorizationState = new URL(authorizationUrl).searchParams.get("state") ?? "";
    },
  });

  expect(result).toEqual({ ok: true });
});

test.each([
  ["bare authorization codes", async (): Promise<string> => "bare-code", "invalid_callback"],
  ["mismatched callback state", async (): Promise<string> => "code wrong-state", "state_mismatch"],
] as const)("rejects %s without exposing callback values", async (_label, waitForPaste, code) => {
  const fixture = await createOAuthFixture();
  const callbackPort = await availablePort();
  const agentDirectory = await mkdtemp(join(tmpdir(), "pi-mcp-oauth-"));
  temporaryDirectories.push(agentDirectory);

  const result = await authenticateMcpOAuth({
    authStore: new McpAuthStore(agentDirectory),
    noOpen: true,
    redirectUrl: `http://127.0.0.1:${callbackPort}/callback`,
    serverId: "safe-error",
    serverUrl: fixture.serverUrl,
    timeoutMs: 2_000,
    waitForPaste,
    writeAuthorizationUrl: () => undefined,
  });

  expect(result).toMatchObject({ error: { code }, ok: false });
  if (result.ok) throw new Error("Expected OAuth callback rejection");
  expect(result.error.message).not.toContain("bare-code");
  expect(result.error.message).not.toContain("wrong-state");
});

test("reports loopback port collisions, timeout, cancellation, and one-active-flow conflicts", async () => {
  const fixture = await createOAuthFixture();
  const agentDirectory = await mkdtemp(join(tmpdir(), "pi-mcp-oauth-"));
  temporaryDirectories.push(agentDirectory);
  const authStore = new McpAuthStore(agentDirectory);
  const heldServer = createServer();
  const heldPort = await listen(heldServer);

  await expect(
    authenticateMcpOAuth({
      authStore,
      noOpen: true,
      redirectUrl: `http://127.0.0.1:${heldPort}/callback`,
      serverId: "collision",
      serverUrl: fixture.serverUrl,
      writeAuthorizationUrl: () => undefined,
    }),
  ).resolves.toMatchObject({ error: { code: "callback_unavailable" }, ok: false });

  const timeoutPort = await availablePort();
  await expect(
    authenticateMcpOAuth({
      authStore,
      noOpen: true,
      redirectUrl: `http://127.0.0.1:${timeoutPort}/callback`,
      serverId: "timeout",
      serverUrl: fixture.serverUrl,
      timeoutMs: 20,
      writeAuthorizationUrl: () => undefined,
    }),
  ).resolves.toMatchObject({ error: { code: "timeout" }, ok: false });

  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    authenticateMcpOAuth({
      authStore,
      noOpen: true,
      serverId: "cancelled",
      serverUrl: fixture.serverUrl,
      signal: cancelled.signal,
      writeAuthorizationUrl: () => undefined,
    }),
  ).resolves.toMatchObject({ error: { code: "cancelled" }, ok: false });

  const activePort = await availablePort();
  const activeAbort = new AbortController();
  let markRedirect!: () => void;
  const redirected = new Promise<void>((resolveRedirect) => {
    markRedirect = resolveRedirect;
  });
  const active = authenticateMcpOAuth({
    authStore,
    noOpen: true,
    redirectUrl: `http://127.0.0.1:${activePort}/callback`,
    serverId: "active",
    serverUrl: fixture.serverUrl,
    signal: activeAbort.signal,
    timeoutMs: 2_000,
    writeAuthorizationUrl: () => markRedirect(),
  });
  await redirected;
  await expect(
    authenticateMcpOAuth({
      authStore,
      noOpen: true,
      serverId: "second",
      serverUrl: fixture.serverUrl,
      writeAuthorizationUrl: () => undefined,
    }),
  ).resolves.toMatchObject({ error: { code: "already_active" }, ok: false });
  activeAbort.abort();
  await expect(active).resolves.toMatchObject({ error: { code: "cancelled" }, ok: false });
});

test("rejects authorization-response issuer mismatches before token exchange", async () => {
  const fixture = await createOAuthFixture();
  const callbackPort = await availablePort();
  const redirectUrl = `http://127.0.0.1:${callbackPort}/callback`;
  const agentDirectory = await mkdtemp(join(tmpdir(), "pi-mcp-oauth-"));
  temporaryDirectories.push(agentDirectory);
  let callback: Promise<Response> | undefined;

  const result = await authenticateMcpOAuth({
    authStore: new McpAuthStore(agentDirectory),
    noOpen: true,
    redirectUrl,
    serverId: "issuer-mismatch",
    serverUrl: fixture.serverUrl,
    timeoutMs: 500,
    writeAuthorizationUrl: (authorizationUrl) => {
      const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
      callback = fetch(
        `${redirectUrl}?code=attacker-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent("https://attacker.example")}`,
      );
    },
  });

  expect(result).toMatchObject({ error: { code: "authorization_failed" }, ok: false });
  await expect(callback).resolves.toMatchObject({ status: 200 });
  expect(fixture.requests).not.toContain("POST /token");
});

test("rejects protected-resource mismatches through public SDK validation", async () => {
  const fixture = await createOAuthFixture({ mismatchedResource: true });
  const callbackPort = await availablePort();
  const agentDirectory = await mkdtemp(join(tmpdir(), "pi-mcp-oauth-"));
  temporaryDirectories.push(agentDirectory);

  const result = await authenticateMcpOAuth({
    authStore: new McpAuthStore(agentDirectory),
    noOpen: true,
    redirectUrl: `http://127.0.0.1:${callbackPort}/callback`,
    serverId: "resource-mismatch",
    serverUrl: fixture.serverUrl,
    timeoutMs: 500,
    writeAuthorizationUrl: () => undefined,
  });

  expect(result).toMatchObject({ error: { code: "authorization_failed" }, ok: false });
  expect(fixture.requests).not.toContain("POST /token");
});
