import { describe, expect, test } from "vitest";
import type { McpCommandAdapters } from "../src/mcp-command.js";
import { runPiMcpCli } from "../src/pi-mcp-cli.js";

function standaloneAdapters(): McpCommandAdapters {
  return {
    auth: {
      authenticate: async () => ({ message: "authenticated", ok: true }),
      logout: async () => ({ message: "logged out", ok: true }),
    },
    live: undefined,
    settings: {
      add: async () => ({ message: "added", ok: true }),
      disable: async () => ({ message: "disabled", ok: true }),
      enable: async () => ({ message: "enabled", ok: true }),
      list: async () => ({
        data: { servers: [{ enabled: true, name: "docs", provenance: "global" }] },
        message:
          "docs (provenance=global, enabled, transport=http, auth=anonymous, stored-auth=absent)",
        ok: true,
      }),
      remove: async () => ({ message: "removed", ok: true }),
    },
    test: {
      test: async () => ({ message: "connected", ok: true }),
    },
  };
}

describe("pi-mcp standalone CLI", () => {
  test("uses the shared command contract and writes deterministic JSON to stdout", async () => {
    let stdout = "";
    let stderr = "";
    const exitCode = await runPiMcpCli(["list", "--json"], {
      createAdapters: async () => standaloneAdapters(),
      writeStderr: (text) => {
        stderr += text;
      },
      writeStdout: (text) => {
        stdout += text;
      },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      servers: [{ enabled: true, name: "docs", provenance: "global" }],
    });
    expect(stderr).toBe("");
  });

  test("prints help without constructing persistence or MCP runtime adapters", async () => {
    let constructed = false;
    let stdout = "";
    const exitCode = await runPiMcpCli(["--help"], {
      createAdapters: async () => {
        constructed = true;
        return standaloneAdapters();
      },
      writeStderr: () => undefined,
      writeStdout: (text) => {
        stdout += text;
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: pi-mcp");
    expect(constructed).toBe(false);
  });

  test("applies explicit project trust overrides and rejects conflicts", async () => {
    let projectTrusted: boolean | undefined;
    const trustedExit = await runPiMcpCli(["list", "--approve"], {
      createAdapters: async (trusted) => {
        projectTrusted = trusted;
        return standaloneAdapters();
      },
      writeStderr: () => undefined,
      writeStdout: () => undefined,
    });
    expect(trustedExit).toBe(0);
    expect(projectTrusted).toBe(true);

    let stderr = "";
    const conflictExit = await runPiMcpCli(["list", "-a", "-na"], {
      createAdapters: async () => standaloneAdapters(),
      writeStderr: (text) => {
        stderr += text;
      },
      writeStdout: () => undefined,
    });
    expect(conflictExit).toBe(2);
    expect(stderr).toContain("cannot be combined");
  });
});
