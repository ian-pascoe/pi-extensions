import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { McpAuthStore, type McpAuthBinding } from "../src/mcp-auth-store.js";
import type { McpStoreResult } from "../src/mcp-settings-store.js";

const temporaryDirectories: string[] = [];
const primaryBinding: McpAuthBinding = {
  clientIdentity: "pi-mcp-default-client",
  serverUrl: "https://example.test/mcp",
};

async function createStore(): Promise<McpAuthStore> {
  const agentDirectory = await mkdtemp(join(tmpdir(), "pi-mcp-auth-store-"));
  temporaryDirectories.push(agentDirectory);
  return new McpAuthStore(agentDirectory);
}

function expectOk<Value>(result: McpStoreResult<Value>): Value {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("McpAuthStore", () => {
  test("round-trips tokens, client registration, PKCE state, and discovery in mode 0600", async () => {
    const store = await createStore();

    const saved = expectOk(
      await store.updateEntry(primaryBinding, {
        authorization: { codeVerifier: "verifier", state: "csrf-state" },
        clientInformation: {
          clientId: "client-id",
          clientIdIssuedAt: 123,
          clientSecret: "client-secret",
          clientSecretExpiresAt: 456,
          metadataDocumentUrl: "https://client.example/metadata.json",
        },
        discovery: {
          authorizationServerMetadata: {
            issuer: "https://auth.example",
            token_endpoint: "https://auth.example/token",
          },
          authorizationServerUrl: "https://auth.example",
          protectedResourceMetadata: {
            resource: "https://example.test/mcp",
          },
          resourceMetadataUrl: "https://example.test/.well-known/oauth-protected-resource",
        },
        tokens: {
          accessToken: "access-token",
          expiresAt: 789,
          refreshToken: "refresh-token",
          scope: "tools.read",
          tokenType: "Bearer",
        },
      }),
    );

    expect(saved.tokens?.refreshToken).toBe("refresh-token");
    expect(expectOk(await store.readEntry(primaryBinding))).toEqual(saved);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);

    await chmod(store.path, 0o644);
    expectOk(
      await store.updateEntry(primaryBinding, {
        authorization: { state: "renewed-state" },
      }),
    );
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });

  test("shares credentials across aliases with the same URL and client identity", async () => {
    const store = await createStore();
    expectOk(
      await store.updateEntry(primaryBinding, {
        tokens: { accessToken: "shared", tokenType: "Bearer" },
      }),
    );

    const aliasBinding = {
      clientIdentity: primaryBinding.clientIdentity,
      serverUrl: "https://EXAMPLE.test:443/mcp",
    };
    expect(expectOk(await store.readEntry(aliasBinding))?.tokens?.accessToken).toBe("shared");
  });

  test("URL or client identity changes invalidate stored credentials", async () => {
    const store = await createStore();
    expectOk(
      await store.updateEntry(primaryBinding, {
        tokens: { accessToken: "bound", tokenType: "Bearer" },
      }),
    );

    expect(
      expectOk(
        await store.readEntry({
          ...primaryBinding,
          serverUrl: "https://other.example/mcp",
        }),
      ),
    ).toBeUndefined();
    expect(
      expectOk(
        await store.readEntry({
          ...primaryBinding,
          clientIdentity: "another-client",
        }),
      ),
    ).toBeUndefined();
  });

  test("serializes concurrent refresh and client writers without dropping unrelated fields", async () => {
    const store = await createStore();

    const results = await Promise.all([
      store.updateEntry(primaryBinding, {
        tokens: {
          accessToken: "refreshed",
          refreshToken: "preserved-refresh",
          tokenType: "Bearer",
        },
      }),
      store.updateEntry(primaryBinding, {
        clientInformation: { clientId: "registered-client", clientSecret: "secret" },
      }),
      store.updateEntry(primaryBinding, {
        authorization: { codeVerifier: "verifier", state: "state" },
      }),
    ]);
    results.forEach(expectOk);

    expect(expectOk(await store.readEntry(primaryBinding))).toEqual({
      authorization: { codeVerifier: "verifier", state: "state" },
      clientInformation: { clientId: "registered-client", clientSecret: "secret" },
      tokens: {
        accessToken: "refreshed",
        refreshToken: "preserved-refresh",
        tokenType: "Bearer",
      },
    });
  });

  test("refuses ordinary mutation of malformed bytes but explicit force reset repairs them", async () => {
    const store = await createStore();
    const secret = "must-not-appear-in-auth-errors";
    const malformed = `{"version":1,"entries":{"${secret}":{}}}\n`;
    await writeFile(store.path, malformed, { mode: 0o644 });

    const read = await store.readEntry(primaryBinding);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("Expected a contained auth parse failure");
    expect(`${read.error.message} ${String(read.error.cause)}`).not.toContain(secret);
    const update = await store.updateEntry(primaryBinding, {
      tokens: { accessToken: "must-not-write", tokenType: "Bearer" },
    });
    expect(update.ok).toBe(false);
    if (update.ok) throw new Error("Expected malformed auth storage to reject updates");
    expect(update.error.code).toBe("invalid_document");
    expect(`${update.error.message} ${String(update.error.cause)}`).not.toContain(secret);
    const remove = await store.removeEntry(primaryBinding);
    expect(remove.ok).toBe(false);
    if (remove.ok) throw new Error("Expected malformed auth storage to reject removal");
    expect(remove.error.code).toBe("invalid_document");
    expect(`${remove.error.message} ${String(remove.error.cause)}`).not.toContain(secret);
    expect(await readFile(store.path, "utf8")).toBe(malformed);

    expectOk(await store.forceReset());
    expect(expectOk(await store.readEntry(primaryBinding))).toBeUndefined();
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });

  test("contains invalid bindings and credential patches without changing stored bytes", async () => {
    const store = await createStore();
    expectOk(
      await store.updateEntry(primaryBinding, {
        tokens: { accessToken: "preserved", tokenType: "Bearer" },
      }),
    );
    const original = await readFile(store.path, "utf8");
    const secret = "invalid-patch-secret";

    const invalidPatch = await store.updateEntry(primaryBinding, {
      tokens: {
        accessToken: secret,
        expiresAt: Number.NaN,
        tokenType: "Bearer",
      },
    });
    expect(invalidPatch.ok).toBe(false);
    if (invalidPatch.ok) throw new Error("Expected an invalid auth patch failure");
    expect(invalidPatch.error.code).toBe("invalid_mutation");
    expect(`${invalidPatch.error.message} ${String(invalidPatch.error.cause)}`).not.toContain(
      secret,
    );
    expect(await readFile(store.path, "utf8")).toBe(original);

    const invalidBinding = await store.readEntry({
      clientIdentity: "pi-mcp-default-client",
      serverUrl: "file:///tmp/not-an-oauth-resource",
    });
    expect(invalidBinding.ok).toBe(false);
    if (invalidBinding.ok) throw new Error("Expected an invalid auth binding failure");
    expect(invalidBinding.error.code).toBe("invalid_mutation");
    expect(await readFile(store.path, "utf8")).toBe(original);
  });

  test("removes only the selected URL/client binding", async () => {
    const store = await createStore();
    const otherBinding = {
      clientIdentity: primaryBinding.clientIdentity,
      serverUrl: "https://other.example/mcp",
    };
    expectOk(
      await store.updateEntry(primaryBinding, {
        tokens: { accessToken: "first", tokenType: "Bearer" },
      }),
    );
    expectOk(
      await store.updateEntry(otherBinding, {
        tokens: { accessToken: "second", tokenType: "Bearer" },
      }),
    );

    expect(expectOk(await store.removeEntry(primaryBinding)).changed).toBe(true);
    expect(expectOk(await store.readEntry(primaryBinding))).toBeUndefined();
    expect(expectOk(await store.readEntry(otherBinding))?.tokens?.accessToken).toBe("second");
  });
});
