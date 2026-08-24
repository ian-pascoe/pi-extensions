import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { resolveDapSettings } from "../src/pi-dap-settings.js";
import type { DapSettingsDocumentInput } from "../src/pi-dap-settings.js";

const temporaryDirectories: string[] = [];

type TestJsonObject = { readonly [key: string]: TestJsonValue };
type TestJsonValue = null | boolean | number | string | readonly TestJsonValue[] | TestJsonObject;

async function createSettingsReader(
  globalSettings: DapSettingsDocumentInput,
  projectSettings: DapSettingsDocumentInput,
  projectTrusted = true,
): Promise<SettingsManager> {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-dap-settings-project-"));
  const agentDirectory = await mkdtemp(resolve(tmpdir(), "pi-dap-settings-agent-"));
  temporaryDirectories.push(cwd, agentDirectory);
  await mkdir(resolve(cwd, ".pi"), { recursive: true });
  await writeFile(resolve(agentDirectory, "settings.json"), JSON.stringify(globalSettings));
  await writeFile(resolve(cwd, ".pi/settings.json"), JSON.stringify(projectSettings));
  return SettingsManager.create(cwd, agentDirectory, { projectTrusted });
}

function stdioAdapter(command: string) {
  return { command, transport: "stdio" };
}

function tcpAdapter(command: string) {
  return { command, transport: { type: "tcp" } };
}

function launchProfile(adapter: string, argumentsValue: TestJsonObject = {}) {
  return { adapter, arguments: argumentsValue };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("resolveDapSettings", () => {
  test("excludes project settings through an untrusted SettingsManager", async () => {
    const settings = resolveDapSettings(
      await createSettingsReader(
        {
          dap: {
            adapters: { global: stdioAdapter("global-adapter") },
            profiles: { global: launchProfile("global") },
          },
        },
        {
          dap: {
            adapters: { project: stdioAdapter("project-adapter") },
            profiles: { project: launchProfile("project") },
          },
        },
        false,
      ),
    );

    expect([...settings.adapters.keys()]).toEqual(["global"]);
    expect([...settings.profiles.keys()]).toEqual(["global"]);
  });

  test("merges timeout fields from global and trusted project settings", async () => {
    const settings = resolveDapSettings(
      await createSettingsReader(
        { dap: { timeouts: { requestMs: 100, startupMs: 200 } } },
        { dap: { timeouts: { executionMs: 300, requestMs: 400 } } },
      ),
    );

    expect(settings.timeouts).toEqual({
      executionMs: 300,
      requestMs: 400,
      shutdownMs: 5_000,
      startupMs: 200,
    });
  });

  test("replaces complete map entries and removes inherited adapters and profiles", async () => {
    const settings = resolveDapSettings(
      await createSettingsReader(
        {
          dap: {
            adapters: {
              deleted: stdioAdapter("delete-me"),
              replaced: { ...stdioAdapter("global-adapter"), args: ["global"] },
            },
            profiles: {
              deleted: launchProfile("deleted"),
              replaced: launchProfile("replaced", { global: true }),
            },
          },
        },
        {
          dap: {
            adapters: {
              deleted: null,
              replaced: tcpAdapter("project-adapter"),
            },
            profiles: {
              deleted: null,
              replaced: launchProfile("replaced", { project: true }),
            },
          },
        },
      ),
    );

    expect([...settings.adapters.keys()]).toEqual(["replaced"]);
    expect(settings.adapters.get("replaced")).toMatchObject({
      args: [],
      command: "project-adapter",
      id: "replaced",
      transport: { host: "127.0.0.1", port: 0, type: "tcp" },
    });
    expect([...settings.profiles]).toEqual([
      [
        "replaced",
        {
          adapterId: "replaced",
          arguments: { project: true },
          id: "replaced",
        },
      ],
    ]);
  });

  test("defaults adapter arguments and preserves environment overrides for process startup", async () => {
    process.env.PI_DAP_SETTINGS_REMOVED = "inherited";
    try {
      const settings = resolveDapSettings(
        await createSettingsReader(
          {
            dap: {
              adapters: {
                node: {
                  command: "node",
                  environment: {
                    PI_DAP_SETTINGS_ADDED: "configured",
                    PI_DAP_SETTINGS_REMOVED: null,
                  },
                  transport: { type: "tcp", host: "localhost", port: 4711 },
                },
              },
              profiles: { node: launchProfile("node", { stopOnEntry: true }) },
            },
          },
          {},
        ),
      );

      const adapter = settings.adapters.get("node");
      expect(adapter).toMatchObject({
        args: [],
        environment: {
          PI_DAP_SETTINGS_ADDED: "configured",
          PI_DAP_SETTINGS_REMOVED: null,
        },
        transport: { host: "localhost", port: 4711, type: "tcp" },
      });
      expect(adapter?.environment.PATH).toBeUndefined();
    } finally {
      delete process.env.PI_DAP_SETTINGS_REMOVED;
    }
  });

  test("quarantines an invalid project replacement instead of falling back to a global entry", async () => {
    const settings = resolveDapSettings(
      await createSettingsReader(
        {
          dap: {
            adapters: { node: stdioAdapter("global-node"), valid: stdioAdapter("valid") },
            profiles: { node: launchProfile("node"), valid: launchProfile("valid") },
          },
        },
        {
          dap: {
            adapters: {
              node: { ...stdioAdapter("project-node"), unexpected: true },
            },
            profiles: {
              node: { ...launchProfile("valid"), unexpected: true },
            },
          },
        },
      ),
    );

    expect([...settings.adapters.keys()]).toEqual(["valid"]);
    expect([...settings.profiles.keys()]).toEqual(["valid"]);
    expect(settings.warnings).toEqual([
      expect.stringContaining("project dap.adapters.node.unexpected"),
      expect.stringContaining("project dap.profiles.node.unexpected"),
    ]);
  });

  test("quarantines invalid transports and rejects PORT substitution for stdio adapters", async () => {
    const settings = resolveDapSettings(
      await createSettingsReader(
        {
          dap: {
            adapters: {
              badPort: {
                command: "adapter",
                transport: { type: "tcp", port: 65_536 },
              },
              missingCommand: { transport: "stdio" },
              stdioPort: {
                command: "adapter",
                args: ["--listen=$PORT"],
                transport: "stdio",
              },
              tcpPort: {
                command: "adapter",
                args: ["--listen=$PORT"],
                transport: { type: "tcp" },
              },
            },
            profiles: { tcp: launchProfile("tcpPort") },
          },
        },
        {},
      ),
    );

    expect([...settings.adapters.keys()]).toEqual(["tcpPort"]);
    expect(settings.adapters.get("tcpPort")?.args).toEqual(["--listen=$PORT"]);
    expect(settings.warnings).toEqual([
      expect.stringContaining("global dap.adapters.badPort.transport.port"),
      expect.stringContaining("global dap.adapters.missingCommand.command"),
      "global dap.adapters.stdioPort.args: $PORT requires TCP transport",
    ]);
  });

  test("quarantines profiles whose adapter is absent or invalid", async () => {
    const settings = resolveDapSettings(
      await createSettingsReader(
        {
          dap: {
            adapters: {
              invalid: { command: "adapter", transport: { type: "udp" } },
              removed: stdioAdapter("adapter"),
              valid: stdioAdapter("valid-adapter"),
            },
            profiles: {
              invalid: launchProfile("invalid"),
              missing: launchProfile("missing"),
              removed: launchProfile("removed"),
              valid: launchProfile("valid"),
            },
          },
        },
        { dap: { adapters: { removed: null } } },
      ),
    );

    expect([...settings.profiles.keys()]).toEqual(["valid"]);
    expect(settings.warnings).toEqual([
      expect.stringContaining("global dap.adapters.invalid.transport"),
      'global dap.profiles.invalid.adapter: adapter "invalid" is not configured',
      'global dap.profiles.missing.adapter: adapter "missing" is not configured',
      'global dap.profiles.removed.adapter: adapter "removed" is not configured',
    ]);
  });

  test("reports strict path-qualified warnings while retaining unrelated valid entries", async () => {
    const settings = resolveDapSettings(
      await createSettingsReader(
        {
          dap: {
            adapters: { valid: stdioAdapter("valid") },
            profiles: {
              invalidArguments: { adapter: "valid", arguments: [] },
              valid: launchProfile("valid", { nested: { enabled: true } }),
            },
            timeouts: { requestMs: -1, startupMs: 123, unknown: 1 },
            unknown: true,
          },
        },
        {},
      ),
    );

    expect([...settings.adapters.keys()]).toEqual(["valid"]);
    expect([...settings.profiles.keys()]).toEqual(["valid"]);
    expect(settings.timeouts.startupMs).toBe(123);
    expect(settings.timeouts.requestMs).toBe(10_000);
    expect(settings.warnings).toEqual([
      "global dap.unknown: unknown field",
      expect.stringContaining("global dap.profiles.invalidArguments.arguments"),
      expect.stringContaining("global dap.timeouts.requestMs"),
      "global dap.timeouts.unknown: unknown field",
    ]);
  });
});
