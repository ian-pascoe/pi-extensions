import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { resolveLspSettings } from "../src/pi-lsp-settings.js";
import type { LspSettingsDocumentInput } from "../src/pi-lsp-settings.js";

const temporaryDirectories: string[] = [];

async function createSettingsReader(
  globalSettings: LspSettingsDocumentInput,
  projectSettings: LspSettingsDocumentInput,
  projectTrusted: boolean,
): Promise<SettingsManager> {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-lsp-settings-project-"));
  const agentDirectory = await mkdtemp(resolve(tmpdir(), "pi-lsp-settings-agent-"));
  temporaryDirectories.push(cwd, agentDirectory);
  await mkdir(resolve(cwd, ".pi"), { recursive: true });
  await writeFile(resolve(agentDirectory, "settings.json"), JSON.stringify(globalSettings));
  await writeFile(resolve(cwd, ".pi/settings.json"), JSON.stringify(projectSettings));
  return SettingsManager.create(cwd, agentDirectory, { projectTrusted });
}

function typescriptServer(command: string) {
  return {
    command,
    languages: [{ extensions: [".ts"], languageId: "typescript" }],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("resolveLspSettings", () => {
  test("uses default timeouts and no servers when lsp is absent", async () => {
    const settingsManager = await createSettingsReader({}, {}, true);

    const settings = resolveLspSettings(settingsManager);

    expect(settings.enabled).toBe(true);
    expect(settings.warnings).toEqual([]);
    expect(settings.timeouts).toEqual({
      diagnosticsMs: 3000,
      initializeMs: 45000,
      requestMs: 3000,
      shutdownMs: 5000,
    });
    expect(settings.servers).toEqual(new Map());
  });

  test("excludes project settings through an untrusted SettingsManager", async () => {
    const settingsManager = await createSettingsReader(
      { lsp: { servers: { global: typescriptServer("global-lsp") } } },
      { lsp: { servers: { project: typescriptServer("project-lsp") } } },
      false,
    );

    const settings = resolveLspSettings(settingsManager);

    expect([...settings.servers]).toEqual([
      ["global", expect.objectContaining({ command: "global-lsp", id: "global" })],
    ]);
  });

  test("merges timeout fields from global and trusted project settings", async () => {
    const settingsManager = await createSettingsReader(
      { lsp: { timeouts: { initializeMs: 100, requestMs: 200 } } },
      { lsp: { timeouts: { requestMs: 300, shutdownMs: 400 } } },
      true,
    );

    expect(resolveLspSettings(settingsManager).timeouts).toEqual({
      diagnosticsMs: 3000,
      initializeMs: 100,
      requestMs: 300,
      shutdownMs: 400,
    });
  });

  test("replaces complete server definitions and removes inherited servers", async () => {
    const settingsManager = await createSettingsReader(
      {
        lsp: {
          servers: {
            deleted: typescriptServer("delete-me"),
            replaced: { ...typescriptServer("global-lsp"), args: ["global"] },
          },
        },
      },
      {
        lsp: {
          servers: {
            deleted: null,
            replaced: typescriptServer("project-lsp"),
          },
        },
      },
      true,
    );

    const settings = resolveLspSettings(settingsManager);

    expect([...settings.servers.keys()]).toEqual(["replaced"]);
    expect(settings.servers.get("replaced")).toMatchObject({
      args: [],
      command: "project-lsp",
      id: "replaced",
    });
  });

  test("keeps opaque initialization and settings values separate", async () => {
    const initializationOptions = { nested: ["initialize", { enabled: true }] };
    const serverSettings = { nested: ["settings", { enabled: false }] };
    const settingsManager = await createSettingsReader(
      {
        lsp: {
          servers: {
            typescript: {
              ...typescriptServer("typescript-language-server"),
              initializationOptions,
              settings: serverSettings,
            },
          },
        },
      },
      {},
      true,
    );

    expect(resolveLspSettings(settingsManager).servers.get("typescript")).toMatchObject({
      initializationOptions,
      settings: serverSettings,
    });
  });

  test("merges environment over process environment and removes null values", async () => {
    process.env.PI_LSP_SETTINGS_INHERITED = "inherited";
    const settingsManager = await createSettingsReader(
      {
        lsp: {
          servers: {
            typescript: {
              ...typescriptServer("typescript-language-server"),
              environment: {
                PI_LSP_SETTINGS_ADDED: "added",
                PI_LSP_SETTINGS_INHERITED: null,
              },
            },
          },
        },
      },
      {},
      true,
    );

    const environment = resolveLspSettings(settingsManager).servers.get("typescript")?.environment;

    expect(environment?.PI_LSP_SETTINGS_ADDED).toBe("added");
    expect(environment?.PI_LSP_SETTINGS_INHERITED).toBeUndefined();
    delete process.env.PI_LSP_SETTINGS_INHERITED;
  });

  test.each([
    {
      lsp: {
        servers: {
          typescript: {
            ...typescriptServer("typescript-language-server"),
            unknownServerField: true,
          },
        },
      },
    },
    { lsp: { timeouts: { unknownTimeoutField: 1 } } },
    {
      lsp: {
        servers: {
          typescript: {
            command: "typescript-language-server",
            languages: [
              { extensions: [".ts"], languageId: "typescript", unknownLanguageField: true },
            ],
          },
        },
      },
    },
    { lsp: { unknownLspField: true } },
  ])("reports strict unknown fields without enabling startup", async (globalSettings) => {
    const settingsManager = await createSettingsReader(globalSettings, {}, true);

    const settings = resolveLspSettings(settingsManager);

    expect(settings.enabled).toBe(false);
    expect(settings.servers).toEqual(new Map());
    expect(settings.warnings).toEqual([expect.stringContaining("global lsp")]);
  });
});
