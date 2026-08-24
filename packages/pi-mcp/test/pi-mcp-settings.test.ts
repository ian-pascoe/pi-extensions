import { describe, expect, test } from "vitest";
import {
  resolveMcpSettings,
  type McpSettingsDocumentInput,
  type McpSettingsReader,
} from "../src/pi-mcp-settings.js";

function settingsReader(
  globalSettings: McpSettingsDocumentInput,
  projectSettings: McpSettingsDocumentInput = {},
): McpSettingsReader {
  return {
    getGlobalSettings: () => globalSettings,
    getProjectSettings: () => projectSettings,
  };
}

describe("resolveMcpSettings", () => {
  test("ignores unrelated Pi settings while parsing only the strict mcp object", () => {
    const settings = resolveMcpSettings(
      settingsReader({
        defaultModel: "provider/model",
        mcp: { servers: { configured: { command: "server" } } },
        theme: "dark",
      }),
      {},
    );

    expect(settings.valid).toBe(true);
    expect([...settings.servers.keys()]).toEqual(["configured"]);
  });

  test("merges package fields while replacing complete Server Definitions by name", () => {
    const settings = resolveMcpSettings(
      settingsReader(
        {
          mcp: {
            connectTimeoutMs: 2_000,
            requestTimeoutMs: 3_000,
            retry: { initialDelayMs: 10, maxDelayMs: 100, maxRetries: 4 },
            servers: {
              global: { command: "global-server" },
              replaced: { args: ["global"], command: "old-server" },
            },
          },
        },
        {
          mcp: {
            requestTimeoutMs: 4_000,
            retry: { backoffFactor: 2, maxRetries: 0 },
            servers: {
              project: { command: "project-server", transport: "stdio" },
              replaced: { transport: "http", url: "https://mcp.example.test" },
            },
          },
        },
      ),
      {},
    );

    expect(settings.valid).toBe(true);
    expect(settings.connectTimeoutMs).toBe(2_000);
    expect(settings.requestTimeoutMs).toBe(4_000);
    expect(settings.retry).toEqual({
      backoffFactor: 2,
      initialDelayMs: 10,
      maxDelayMs: 100,
      maxRetries: 0,
    });
    expect([...settings.servers.keys()]).toEqual(["global", "project", "replaced"]);
    expect(settings.servers.get("global")).toMatchObject({
      args: [],
      command: "global-server",
      enabled: true,
      provenance: "global",
      transport: "stdio",
    });
    expect(settings.servers.get("project")).toMatchObject({
      command: "project-server",
      provenance: "project",
    });
    expect(settings.servers.get("replaced")).toEqual({
      enabled: true,
      headers: {},
      id: "replaced",
      provenance: "project",
      transport: "http",
      url: "https://mcp.example.test/",
    });
  });

  test("parses stdio, HTTP, SSE, and every authentication variant", () => {
    const settings = resolveMcpSettings(
      settingsReader({
        mcp: {
          servers: {
            bearer: {
              auth: { token: "static-token", type: "bearer" },
              headers: { "X-Client": "pi" },
              url: "https://bearer.example.test/mcp",
            },
            local: {
              args: ["server.js", "--stdio"],
              command: "node",
              cwd: "/workspace",
              environment: { NODE_ENV: "test" },
            },
            none: {
              auth: { type: "none" },
              transport: "sse",
              url: "http://none.example.test/events",
            },
            oauth: {
              auth: {
                clientId: "pi-client",
                clientSecret: "oauth-secret",
                redirectUri: "http://127.0.0.1:19876/callback",
                scopes: ["tools", "resources"],
                type: "oauth",
              },
              url: "https://oauth.example.test/mcp",
            },
          },
        },
      }),
      {},
    );

    expect(settings.valid).toBe(true);
    expect(settings.servers.get("local")).toEqual({
      args: ["server.js", "--stdio"],
      command: "node",
      cwd: "/workspace",
      enabled: true,
      environment: { NODE_ENV: "test" },
      id: "local",
      provenance: "global",
      transport: "stdio",
    });
    expect(settings.servers.get("none")).toMatchObject({
      auth: { type: "none" },
      transport: "sse",
    });
    expect(settings.servers.get("bearer")).toMatchObject({
      auth: { token: "static-token", type: "bearer" },
      headers: { "X-Client": "pi" },
    });
    expect(settings.servers.get("oauth")).toMatchObject({
      auth: {
        clientId: "pi-client",
        clientSecret: "oauth-secret",
        redirectUri: "http://127.0.0.1:19876/callback",
        scopes: ["tools", "resources"],
        type: "oauth",
      },
    });
  });

  test.each([
    ["unknown package field", { unknown: true }, "global mcp.unknown"],
    ["unknown retry field", { retry: { unknown: 1 } }, "global mcp.retry"],
    [
      "unknown Server Definition field",
      { servers: { invalid: { command: "server", unknown: true } } },
      "global mcp.servers.invalid",
    ],
    [
      "missing connection target",
      { servers: { invalid: { enabled: true } } },
      "global mcp.servers.invalid",
    ],
    [
      "command and URL together",
      { servers: { invalid: { command: "server", url: "https://example.test" } } },
      "global mcp.servers.invalid",
    ],
    [
      "command with HTTP transport",
      { servers: { invalid: { command: "server", transport: "http" } } },
      "global mcp.servers.invalid.transport",
    ],
    [
      "URL with stdio transport",
      { servers: { invalid: { transport: "stdio", url: "https://example.test" } } },
      "global mcp.servers.invalid.transport",
    ],
    [
      "local-only fields on a remote definition",
      { servers: { invalid: { args: ["bad"], url: "https://example.test" } } },
      "global mcp.servers.invalid",
    ],
    [
      "remote-only fields on a local definition",
      { servers: { invalid: { command: "server", headers: { X: "bad" } } } },
      "global mcp.servers.invalid",
    ],
    [
      "bearer token and Authorization header",
      {
        servers: {
          invalid: {
            auth: { token: "secret", type: "bearer" },
            headers: { authorization: "Bearer duplicate" },
            url: "https://example.test",
          },
        },
      },
      "global mcp.servers.invalid.headers.authorization",
    ],
    [
      "invalid auth variant",
      {
        servers: {
          invalid: { auth: { type: "bearer" }, url: "https://example.test" },
        },
      },
      "global mcp.servers.invalid.auth.token",
    ],
    [
      "none authentication with credentials",
      {
        servers: {
          invalid: {
            auth: { token: "unexpected", type: "none" },
            url: "https://example.test",
          },
        },
      },
      "global mcp.servers.invalid.auth",
    ],
    [
      "bearer authentication with OAuth fields",
      {
        servers: {
          invalid: {
            auth: { clientId: "unexpected", token: "token", type: "bearer" },
            url: "https://example.test",
          },
        },
      },
      "global mcp.servers.invalid.auth",
    ],
    [
      "OAuth authentication with a static token",
      {
        servers: {
          invalid: {
            auth: { token: "unexpected", type: "oauth" },
            url: "https://example.test",
          },
        },
      },
      "global mcp.servers.invalid.auth",
    ],
    [
      "OAuth client secret without a client ID",
      {
        servers: {
          invalid: {
            auth: { clientSecret: "orphaned", type: "oauth" },
            url: "https://example.test",
          },
        },
      },
      "global mcp.servers.invalid.auth.clientId",
    ],
    [
      "non-loopback OAuth redirect URI",
      {
        servers: {
          invalid: {
            auth: { redirectUri: "https://public.example/callback", type: "oauth" },
            url: "https://example.test",
          },
        },
      },
      "global mcp.servers.invalid.auth.redirectUri",
    ],
    [
      "non-HTTP server URL",
      { servers: { invalid: { url: "file:///private/socket" } } },
      "global mcp.servers.invalid.url",
    ],
    [
      "global inherited-definition mask",
      { servers: { invalid: { enabled: false } } },
      "global mcp.servers.invalid",
    ],
  ])("disables MCP for %s", (_name, mcp, expectedPath) => {
    const settings = resolveMcpSettings(settingsReader({ mcp }), {});

    expect(settings.valid).toBe(false);
    expect(settings.servers).toEqual(new Map());
    expect(settings.errors[0]?.path).toContain(expectedPath);
  });

  test.each([
    ["connectTimeoutMs", { connectTimeoutMs: 0 }],
    ["requestTimeoutMs", { requestTimeoutMs: Number.MAX_SAFE_INTEGER + 1 }],
    ["retry.backoffFactor", { retry: { backoffFactor: 0.99 } }],
    ["retry.initialDelayMs", { retry: { initialDelayMs: 0 } }],
    ["retry.maxDelayMs", { retry: { maxDelayMs: -1 } }],
    ["retry.maxRetries", { retry: { maxRetries: -1 } }],
    ["retry.maxRetries", { retry: { maxRetries: 1.5 } }],
  ])("rejects the bounded numeric constraint at %s", (expectedPath, mcp) => {
    const settings = resolveMcpSettings(settingsReader({ mcp }), {});

    expect(settings.valid).toBe(false);
    expect(settings.errors[0]?.path).toContain(expectedPath);
  });

  test("rejects retry delay ranges whose initial delay exceeds the maximum", () => {
    const settings = resolveMcpSettings(
      settingsReader({ mcp: { retry: { initialDelayMs: 101, maxDelayMs: 100 } } }),
      {},
    );

    expect(settings.valid).toBe(false);
    expect(settings.errors[0]?.path).toBe("mcp.retry.initialDelayMs");
  });

  test("interpolates every Server Definition string leaf and tracks resolved values", () => {
    const environment = {
      ARG: "server.js",
      AUTH_TYPE: "oauth",
      CLIENT_ID: "client-id",
      CLIENT_SECRET: "client-secret",
      COMMAND: "node",
      CWD: "/private/workspace",
      ENV_VALUE: "configured-value",
      HEADER_VALUE: "header-secret",
      REDIRECT_URI: "http://127.0.0.1:19876/callback",
      SCOPE: "tools.read",
      TRANSPORT: "http",
      URL: "https://mcp.example.test/private",
    };
    const settings = resolveMcpSettings(
      settingsReader({
        mcp: {
          servers: {
            local: {
              args: ["${ARG}"],
              command: "${COMMAND}",
              cwd: "${CWD}",
              environment: { MCP_VALUE: "${ENV_VALUE}" },
            },
            remote: {
              auth: {
                clientId: "${CLIENT_ID}",
                clientSecret: "${CLIENT_SECRET}",
                redirectUri: "${REDIRECT_URI}",
                scopes: ["${SCOPE}"],
                type: "${AUTH_TYPE}",
              },
              headers: { "X-Secret": "${HEADER_VALUE}" },
              transport: "${TRANSPORT}",
              url: "${URL}",
            },
          },
        },
      }),
      environment,
    );

    expect(settings.valid).toBe(true);
    expect(settings.servers.get("local")).toMatchObject({
      args: ["server.js"],
      command: "node",
      cwd: "/private/workspace",
      environment: { MCP_VALUE: "configured-value" },
    });
    expect(settings.servers.get("remote")).toMatchObject({
      auth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://127.0.0.1:19876/callback",
        scopes: ["tools.read"],
        type: "oauth",
      },
      headers: { "X-Secret": "header-secret" },
      transport: "http",
      url: "https://mcp.example.test/private",
    });
    const redacted = settings.secrets.redact(Object.values(environment).join(" | "));
    for (const resolvedValue of Object.values(environment)) {
      expect(redacted).not.toContain(resolvedValue);
    }
    expect(redacted).toContain("[REDACTED]");
  });

  test("interpolates multiple occurrences once and accepts empty environment values", () => {
    const settings = resolveMcpSettings(
      settingsReader({
        mcp: {
          servers: {
            local: {
              args: ["${VALUE}:${EMPTY}:${VALUE}"],
              command: "${COMMAND}",
            },
          },
        },
      }),
      { COMMAND: "node", EMPTY: "", VALUE: "$&.value" },
    );

    expect(settings.valid).toBe(true);
    expect(settings.servers.get("local")).toMatchObject({
      args: ["$&.value::$&.value"],
      command: "node",
    });
    expect(settings.secrets.redact("node $&.value $&.value")).toBe(
      "[REDACTED] [REDACTED] [REDACTED]",
    );
  });

  test("does not interpolate map keys or recursively expand resolved environment values", () => {
    const settings = resolveMcpSettings(
      settingsReader({
        mcp: {
          servers: {
            "${SERVER_NAME}": {
              command: "${FIRST}",
              environment: { "${ENVIRONMENT_KEY}": "literal" },
            },
          },
        },
      }),
      { FIRST: "${SECOND}", SECOND: "expanded-twice" },
    );

    expect(settings.valid).toBe(true);
    expect([...settings.servers.keys()]).toEqual(["${SERVER_NAME}"]);
    expect(settings.servers.get("${SERVER_NAME}")).toMatchObject({
      command: "${SECOND}",
      environment: { "${ENVIRONMENT_KEY}": "literal" },
    });
  });

  test("missing environment variables disable MCP without exposing resolved values", () => {
    const settings = resolveMcpSettings(
      settingsReader({
        mcp: {
          servers: {
            invalid: {
              args: ["${MISSING_ARGUMENT}"],
              command: "${RESOLVED_COMMAND}",
            },
          },
        },
      }),
      { RESOLVED_COMMAND: "private-command" },
    );

    expect(settings.valid).toBe(false);
    expect(settings.servers).toEqual(new Map());
    expect(settings.errors[0]?.path).toContain("global mcp.servers.invalid.args.0");
    expect(settings.errors[0]?.message).toContain("MISSING_ARGUMENT");
    expect(JSON.stringify(settings.errors)).not.toContain("private-command");
  });

  test("redacts literal effective connection secrets without redacting ordinary commands", () => {
    const settings = resolveMcpSettings(
      settingsReader({
        mcp: {
          servers: {
            local: { command: "visible-command", environment: { TOKEN: "local-secret" } },
            remote: {
              auth: { token: "bearer-secret", type: "bearer" },
              headers: { "X-Secret": "header-secret" },
              url: "https://private.example/mcp",
            },
          },
        },
      }),
      {},
    );

    const redacted = settings.secrets.redact(
      "visible-command local-secret bearer-secret header-secret https://private.example/mcp",
    );
    expect(redacted).toBe("visible-command [REDACTED] [REDACTED] [REDACTED] [REDACTED]");
  });

  test("a project mask hides an inherited definition before environment interpolation", () => {
    const settings = resolveMcpSettings(
      settingsReader(
        {
          mcp: {
            servers: { hidden: { command: "${MISSING_IN_HIDDEN_DEFINITION}" } },
          },
        },
        { mcp: { servers: { hidden: null, projectOnlyMask: { enabled: false } } } },
      ),
      {},
    );

    expect(settings.valid).toBe(true);
    expect([...settings.servers]).toEqual([]);
    expect([...settings.masks]).toEqual([
      ["hidden", { id: "hidden", inherited: true, provenance: "project" }],
      ["projectOnlyMask", { id: "projectOnlyMask", inherited: false, provenance: "project" }],
    ]);
  });

  test("invalid project MCP settings disable otherwise valid global definitions", () => {
    const settings = resolveMcpSettings(
      settingsReader(
        { mcp: { servers: { valid: { command: "server" } } } },
        { mcp: { unknown: true } },
      ),
      {},
    );

    expect(settings.valid).toBe(false);
    expect(settings.servers).toEqual(new Map());
    expect(settings.errors[0]?.path).toBe("project mcp.unknown");
  });

  test("retains project masks separately from complete disabled Server Definitions", () => {
    const settings = resolveMcpSettings(
      settingsReader(
        {
          mcp: {
            servers: {
              disabledByObject: { command: "global-object" },
              disabledByNull: { command: "global-null" },
            },
          },
        },
        {
          mcp: {
            servers: {
              disabledByObject: { enabled: false },
              disabledByNull: null,
              retained: { command: "retained-server", enabled: false },
            },
          },
        },
      ),
      {},
    );

    expect(settings.valid).toBe(true);
    expect([...settings.servers]).toEqual([
      [
        "retained",
        expect.objectContaining({
          command: "retained-server",
          enabled: false,
          provenance: "project",
        }),
      ],
    ]);
    expect([...settings.masks]).toEqual([
      ["disabledByNull", { id: "disabledByNull", inherited: true, provenance: "project" }],
      ["disabledByObject", { id: "disabledByObject", inherited: true, provenance: "project" }],
    ]);
  });
});
