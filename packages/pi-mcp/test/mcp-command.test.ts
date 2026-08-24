/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- The result fixture mirrors exact optional adapter data. */
/* oxlint-disable anti-slop/no-unknown-parameters -- The recording fake intentionally captures differently shaped command option payloads for assertions. */

import { describe, expect, test, vi } from "vitest";
import {
  MCP_COMMAND_NAMES,
  MCP_STANDALONE_COMMAND_NAMES,
  executeMcpCommand,
  parseMcpCommand,
  runMcpCommandLine,
  runMcpCommandTokens,
  tokenizeMcpCommandLine,
  type McpCommandAdapterResult,
  type McpCommandAdapters,
  type McpCommandJsonValue,
} from "../src/mcp-command.js";

const success = (message: string, data?: McpCommandJsonValue): McpCommandAdapterResult => ({
  ...(data === undefined ? {} : { data }),
  message,
  ok: true,
});

function createAdapters(): McpCommandAdapters & {
  readonly calls: Array<{ readonly operation: string; readonly value: unknown }>;
} {
  const calls: Array<{ readonly operation: string; readonly value: unknown }> = [];
  const record = async (operation: string, value: unknown): Promise<McpCommandAdapterResult> => {
    calls.push({ operation, value });
    return success(`${operation} complete`, { operation });
  };
  return {
    auth: {
      authenticate: (options) => record("auth", options),
      logout: (options) => record("logout", options),
    },
    calls,
    live: {
      connectInBackground: (server) =>
        calls.push({ operation: "background-connect", value: server }),
      disconnect: (server) => record("disconnect", server).then(() => undefined),
      logs: (options) => record("logs", options),
      prompt: (options) => record("prompt", options),
      reconnect: (server) => record("reconnect", server),
      status: () => record("status", undefined),
      subscribe: (options) => record("subscribe", options),
      unsubscribe: (options) => record("unsubscribe", options),
    },
    settings: {
      add: (options) => record("add", options),
      disable: (options) => record("disable", options),
      enable: (options) => record("enable", options),
      list: () => record("list", undefined),
      remove: (options) => record("remove", options),
    },
    test: {
      test: (options) => record("test", options),
    },
  };
}

describe("MCP command grammar", () => {
  test("exposes exactly the approved runtime and standalone commands", () => {
    expect(MCP_COMMAND_NAMES).toEqual([
      "list",
      "add",
      "remove",
      "enable",
      "disable",
      "auth",
      "logout",
      "test",
      "status",
      "reconnect",
      "prompt",
      "subscribe",
      "unsubscribe",
      "logs",
    ]);
    expect(MCP_STANDALONE_COMMAND_NAMES).toEqual(MCP_COMMAND_NAMES.slice(0, 8));
  });

  test("parses a remote add with project scope, repeated headers, and OAuth fields", () => {
    const parsed = parseMcpCommand(
      [
        "add",
        "--local",
        "docs",
        "https://example.test/mcp",
        "--transport",
        "sse",
        "--header",
        "X-First=one",
        "--header=X-Second: two",
        "--auth",
        "oauth",
        "--client-id",
        "client-id",
        "--client-secret",
        "client-secret",
        "--redirect-uri",
        "http://127.0.0.1:19876/callback",
        "--scope",
        "tools.read",
        "--scope=resources.read",
      ],
      "standalone",
    );

    expect(parsed).toEqual({
      ok: true,
      command: {
        definition: {
          auth: {
            clientId: "client-id",
            clientSecret: "client-secret",
            redirectUri: "http://127.0.0.1:19876/callback",
            scopes: ["tools.read", "resources.read"],
            type: "oauth",
          },
          enabled: true,
          headers: { "X-First": "one", "X-Second": "two" },
          transport: "sse",
          url: "https://example.test/mcp",
        },
        kind: "add",
        name: "docs",
        scope: "project",
      },
    });
  });

  test("parses a local command only after the delimiter with repeated environment flags", () => {
    expect(
      parseMcpCommand(
        [
          "add",
          "worker",
          "--environment",
          "MODE=fixture",
          "--env=EMPTY=",
          "--cwd",
          "./tools",
          "--",
          "node",
          "server.mjs",
          "--stdio",
        ],
        "runtime",
      ),
    ).toEqual({
      ok: true,
      command: {
        definition: {
          args: ["server.mjs", "--stdio"],
          command: "node",
          cwd: "./tools",
          enabled: true,
          environment: { EMPTY: "", MODE: "fixture" },
          transport: "stdio",
        },
        kind: "add",
        name: "worker",
        scope: "global",
      },
    });
  });

  test("parses bearer auth and rejects mixed or incomplete add forms", () => {
    expect(
      parseMcpCommand(
        ["add", "api", "https://example.test/mcp", "--auth", "bearer", "--token", "secret"],
        "standalone",
      ),
    ).toMatchObject({
      ok: true,
      command: { definition: { auth: { token: "secret", type: "bearer" } } },
    });

    expect(parseMcpCommand(["add", "missing"], "standalone")).toMatchObject({
      category: "usage",
      ok: false,
    });
    expect(
      parseMcpCommand(["add", "mixed", "https://example.test/mcp", "--", "node"], "standalone"),
    ).toMatchObject({ category: "usage", ok: false });
    expect(
      parseMcpCommand(["add", "api", "https://example.test/mcp", "--auth", "bearer"], "standalone"),
    ).toMatchObject({ category: "usage", ok: false });
  });

  test("requires an explicit test target and restricts JSON to standalone read-only commands", () => {
    expect(parseMcpCommand(["test", "docs", "--json"], "standalone")).toEqual({
      ok: true,
      command: { all: false, json: true, kind: "test", server: "docs" },
    });
    expect(parseMcpCommand(["test", "--all"], "standalone")).toEqual({
      ok: true,
      command: { all: true, json: false, kind: "test" },
    });
    expect(parseMcpCommand(["test"], "standalone")).toMatchObject({
      category: "usage",
      ok: false,
    });
    expect(parseMcpCommand(["test", "docs", "--all"], "standalone")).toMatchObject({
      category: "usage",
      ok: false,
    });
    expect(
      parseMcpCommand(["add", "docs", "https://example.test", "--json"], "standalone"),
    ).toMatchObject({
      category: "usage",
      ok: false,
    });
    expect(parseMcpCommand(["list", "--json"], "runtime")).toMatchObject({
      category: "usage",
      ok: false,
    });
  });

  test("parses every runtime-only operation and rejects it for the standalone surface", () => {
    expect(parseMcpCommand(["status"], "runtime")).toEqual({
      ok: true,
      command: { includeHelp: false, kind: "status" },
    });
    expect(parseMcpCommand(["reconnect", "docs"], "runtime")).toEqual({
      ok: true,
      command: { kind: "reconnect", server: "docs" },
    });
    expect(
      parseMcpCommand(
        ["prompt", "docs", "summarize", "--arg", "language=en", "--arg=detail=high"],
        "runtime",
      ),
    ).toEqual({
      ok: true,
      command: {
        arguments: { detail: "high", language: "en" },
        kind: "prompt",
        prompt: "summarize",
        server: "docs",
      },
    });
    expect(parseMcpCommand(["subscribe", "docs", "file:///readme"], "runtime")).toEqual({
      ok: true,
      command: { kind: "subscribe", server: "docs", uri: "file:///readme" },
    });
    expect(parseMcpCommand(["unsubscribe", "docs", "file:///readme"], "runtime")).toEqual({
      ok: true,
      command: { kind: "unsubscribe", server: "docs", uri: "file:///readme" },
    });
    expect(parseMcpCommand(["logs", "docs", "--level", "warning"], "runtime")).toEqual({
      ok: true,
      command: { kind: "logs", level: "warning", server: "docs" },
    });
    expect(parseMcpCommand(["status"], "standalone")).toMatchObject({
      category: "usage",
      ok: false,
    });
  });

  test("parses explicit auth interaction and logout reset options", () => {
    expect(
      parseMcpCommand(
        ["auth", "docs", "--no-open", "--code", "code", "--state", "state"],
        "standalone",
      ),
    ).toEqual({
      ok: true,
      command: {
        code: "code",
        kind: "auth",
        noOpen: true,
        server: "docs",
        state: "state",
      },
    });
    expect(parseMcpCommand(["auth", "docs", "bare-code"], "standalone")).toMatchObject({
      category: "usage",
      ok: false,
    });
    expect(parseMcpCommand(["auth", "docs", "--code", "code"], "standalone")).toMatchObject({
      category: "usage",
      ok: false,
    });
    expect(parseMcpCommand(["logout", "--all", "--force"], "standalone")).toEqual({
      ok: true,
      command: { all: true, force: true, kind: "logout" },
    });
    expect(parseMcpCommand(["remove", "docs", "--logout"], "standalone")).toEqual({
      ok: true,
      command: { kind: "remove", logout: true, name: "docs", scope: "global" },
    });
  });

  test("tokenizes quoted command lines without invoking a shell", () => {
    expect(
      tokenizeMcpCommandLine(
        'add local --environment "GREETING=hello world" -- node "server file.mjs"',
      ),
    ).toEqual([
      "add",
      "local",
      "--environment",
      "GREETING=hello world",
      "--",
      "node",
      "server file.mjs",
    ]);
    expect(() => tokenizeMcpCommandLine("add docs 'unterminated")).toThrow("unterminated quote");
  });
});

describe("MCP command execution", () => {
  test("routes the shared standalone operations and returns deterministic human output", async () => {
    const adapters = createAdapters();
    const parsed = parseMcpCommand(["remove", "--local", "docs"], "standalone");
    if (!parsed.ok) throw new Error(parsed.message);

    await expect(executeMcpCommand(parsed.command, adapters)).resolves.toEqual({
      category: "success",
      data: { operation: "remove" },
      exitCode: 0,
      ok: true,
      output: "remove complete\n",
    });
    expect(adapters.calls).toEqual([
      { operation: "remove", value: { logout: false, name: "docs", scope: "project" } },
    ]);
  });

  test("starts runtime add and enable connections only after persistence", async () => {
    const adapters = createAdapters();
    const add = parseMcpCommand(["add", "docs", "https://example.test/mcp"], "runtime");
    const enable = parseMcpCommand(["enable", "docs"], "runtime");
    if (!add.ok || !enable.ok) throw new Error("Expected valid commands");

    await executeMcpCommand(add.command, adapters, "runtime");
    await executeMcpCommand(enable.command, adapters, "runtime");

    expect(adapters.calls.map(({ operation }) => operation)).toEqual([
      "add",
      "background-connect",
      "enable",
      "background-connect",
    ]);
  });

  test("disconnects runtime removals and disables after persistence", async () => {
    const adapters = createAdapters();
    for (const args of [
      ["disable", "docs"],
      ["remove", "docs"],
    ]) {
      const parsed = parseMcpCommand(args, "runtime");
      if (!parsed.ok) throw new Error(parsed.message);
      await executeMcpCommand(parsed.command, adapters, "runtime");
    }
    expect(adapters.calls.map(({ operation }) => operation)).toEqual([
      "disable",
      "disconnect",
      "remove",
      "disconnect",
    ]);
  });

  test("formats standalone JSON and preserves adapter failure categories", async () => {
    const adapters = createAdapters();
    const list = parseMcpCommand(["list", "--json"], "standalone");
    if (!list.ok) throw new Error(list.message);
    expect(await executeMcpCommand(list.command, adapters)).toEqual({
      category: "success",
      data: { operation: "list" },
      exitCode: 0,
      ok: true,
      output: '{\n  "operation": "list"\n}\n',
    });

    adapters.settings.list = async () => ({
      category: "settings",
      message: "settings are invalid",
      ok: false,
    });
    expect(await executeMcpCommand(list.command, adapters)).toEqual({
      category: "settings",
      exitCode: 3,
      ok: false,
      output: "Pi MCP: settings are invalid\n",
    });
  });

  test("bare runtime command shows status followed by concise help", async () => {
    const adapters = createAdapters();
    const result = await runMcpCommandLine("", "runtime", adapters);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("status complete");
    expect(result.output).toContain("Commands: list, add, remove");
    expect(adapters.calls).toEqual([{ operation: "status", value: undefined }]);
  });

  test("executes a token array without interpreting argument contents", async () => {
    const adapters = createAdapters();
    const result = await runMcpCommandTokens(
      ["add", "local", "--", "printf", 'literal "quotes" and spaces'],
      "standalone",
      adapters,
    );

    expect(result.ok).toBe(true);
    expect(adapters.calls).toContainEqual({
      operation: "add",
      value: expect.objectContaining({
        definition: expect.objectContaining({ args: ['literal "quotes" and spaces'] }),
      }),
    });
  });

  test("contains usage, missing adapters, and unexpected failures without throwing", async () => {
    const adapters = createAdapters();
    expect(await runMcpCommandLine("test", "standalone", adapters)).toMatchObject({
      category: "usage",
      exitCode: 2,
      ok: false,
      output: expect.stringContaining("Usage: pi-mcp test <server> | --all"),
    });

    const runtimeOnly = parseMcpCommand(["logs"], "runtime");
    if (!runtimeOnly.ok) throw new Error(runtimeOnly.message);
    await expect(
      executeMcpCommand(runtimeOnly.command, { ...adapters, live: undefined }),
    ).resolves.toMatchObject({ category: "runtime", exitCode: 6, ok: false });

    adapters.settings.list = vi.fn().mockRejectedValue(new Error("secret bytes"));
    const list = parseMcpCommand(["list"], "standalone");
    if (!list.ok) throw new Error(list.message);
    await expect(executeMcpCommand(list.command, adapters)).resolves.toEqual({
      category: "runtime",
      exitCode: 6,
      ok: false,
      output: "Pi MCP: command failed unexpectedly\n",
    });
  });
});
