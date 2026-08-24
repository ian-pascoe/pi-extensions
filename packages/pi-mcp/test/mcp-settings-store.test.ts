import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  McpSettingsStore,
  mutateLockedMcpJsonDocument,
  type McpStoreJsonObject,
  type McpStoreResult,
} from "../src/mcp-settings-store.js";

const temporaryDirectories: string[] = [];

async function createStore(projectTrusted = true): Promise<{
  readonly agentDirectory: string;
  readonly cwd: string;
  readonly store: McpSettingsStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-settings-store-"));
  temporaryDirectories.push(root);
  const agentDirectory = join(root, "agent");
  const cwd = join(root, "project");
  await Promise.all([mkdir(agentDirectory), mkdir(cwd)]);
  return {
    agentDirectory,
    cwd,
    store: new McpSettingsStore({ agentDirectory, cwd, projectTrusted }),
  };
}

function expectOk<Value>(result: McpStoreResult<Value>): Value {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

async function readJson(path: string): Promise<McpStoreJsonObject> {
  return JSON.parse(await readFile(path, "utf8"));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("McpSettingsStore", () => {
  test("atomically preserves unrelated settings and the existing file mode", async () => {
    const { store } = await createStore();
    await writeFile(
      store.globalSettingsPath,
      JSON.stringify({ mcp: { retry: { maxRetries: 7 } }, theme: "dark" }),
      { mode: 0o640 },
    );
    await chmod(store.globalSettingsPath, 0o640);

    const outcome = expectOk(
      await store.setServerDefinition("global", "docs", {
        enabled: true,
        url: "https://example.test/mcp",
      }),
    );

    expect(outcome).toMatchObject({ changed: true, scope: "global" });
    expect(await readJson(store.globalSettingsPath)).toEqual({
      mcp: {
        retry: { maxRetries: 7 },
        servers: { docs: { enabled: true, url: "https://example.test/mcp" } },
      },
      theme: "dark",
    });
    expect((await stat(store.globalSettingsPath)).mode & 0o777).toBe(0o640);
  });

  test("denies untrusted project mutations without touching the project file", async () => {
    const { store } = await createStore(false);
    await mkdir(join(store.projectSettingsPath, ".."), { recursive: true });
    const original = '{"theme":"dark"}\n';
    await writeFile(store.projectSettingsPath, original);

    const result = await store.setServerDefinition("project", "local", { command: "node" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected an untrusted project failure");
    expect(result.error.code).toBe("project_untrusted");
    expect(await readFile(store.projectSettingsPath, "utf8")).toBe(original);
    const layers = expectOk(await store.readLayers());
    expect(layers.project).toBeUndefined();
  });

  test("writes and removes inherited masks while complete disabled definitions retain details", async () => {
    const { store } = await createStore();

    expectOk(await store.disableServerDefinition("project", "inherited", true));
    expect(await readJson(store.projectSettingsPath)).toEqual({
      mcp: { servers: { inherited: { enabled: false } } },
    });
    expect((await stat(store.projectSettingsPath)).mode & 0o777).toBe(0o600);

    expectOk(await store.enableServerDefinition("project", "inherited"));
    expect(await readJson(store.projectSettingsPath)).toEqual({ mcp: { servers: {} } });

    expectOk(
      await store.setServerDefinition("project", "owned", {
        command: "node",
        enabled: false,
      }),
    );
    expectOk(await store.enableServerDefinition("project", "owned"));
    expect(await readJson(store.projectSettingsPath)).toEqual({
      mcp: { servers: { owned: { command: "node", enabled: true } } },
    });
    expectOk(await store.removeServerDefinition("project", "owned"));
    expect(await readJson(store.projectSettingsPath)).toEqual({ mcp: { servers: {} } });
  });

  test("serializes concurrent writers so no Server Definition is lost", async () => {
    const { store } = await createStore();

    await Promise.all([
      store.setServerDefinition("global", "first", { command: "first" }),
      store.setServerDefinition("global", "second", { command: "second" }),
      store.setServerDefinition("global", "third", { command: "third" }),
    ]).then((results) => results.forEach(expectOk));

    expect(await readJson(store.globalSettingsPath)).toEqual({
      mcp: {
        servers: {
          first: { command: "first" },
          second: { command: "second" },
          third: { command: "third" },
        },
      },
    });
  });

  test("waits for a contended lock and reclaims an abandoned lock", async () => {
    const { store } = await createStore();
    const lockPath = `${store.globalSettingsPath}.pi-mcp.lock`;
    await writeFile(lockPath, "held");
    const release = setTimeout(() => void rm(lockPath, { force: true }), 50);
    try {
      expectOk(await store.setServerDefinition("global", "after-wait", { command: "node" }));
    } finally {
      clearTimeout(release);
    }

    await writeFile(lockPath, "stale");
    await utimes(lockPath, 0, 0);
    expectOk(await store.setServerDefinition("global", "after-stale", { command: "node" }));
    expect(await readJson(store.globalSettingsPath)).toEqual({
      mcp: {
        servers: {
          "after-stale": { command: "node" },
          "after-wait": { command: "node" },
        },
      },
    });
  });

  test("retains the original document when parsing or mutation fails", async () => {
    const { store } = await createStore();
    const original = '{"theme":"dark"}\n';
    await writeFile(store.globalSettingsPath, original);

    const secret = "must-not-appear-in-store-errors";
    const failed = await mutateLockedMcpJsonDocument(store.globalSettingsPath, () => {
      throw new Error(secret);
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("Expected a contained mutation failure");
    expect(failed.error.code).toBe("invalid_mutation");
    expect(`${failed.error.message} ${String(failed.error.cause)}`).not.toContain(secret);
    expect(await readFile(store.globalSettingsPath, "utf8")).toBe(original);

    const cyclic: Record<string, McpStoreJsonObject> = {};
    cyclic.self = cyclic;
    const invalidValue = await mutateLockedMcpJsonDocument(store.globalSettingsPath, () => cyclic);
    expect(invalidValue.ok).toBe(false);
    if (invalidValue.ok) throw new Error("Expected a contained cyclic JSON failure");
    expect(invalidValue.error.code).toBe("invalid_mutation");
    expect(await readFile(store.globalSettingsPath, "utf8")).toBe(original);

    const malformedBytes = `{"credential":"${secret}",broken`;
    await writeFile(store.globalSettingsPath, malformedBytes);
    const malformed = await store.setServerDefinition("global", "docs", { command: "node" });
    expect(malformed.ok).toBe(false);
    if (malformed.ok) throw new Error("Expected a contained parse failure");
    expect(malformed.error.code).toBe("invalid_document");
    expect(`${malformed.error.message} ${String(malformed.error.cause)}`).not.toContain(secret);
    expect(await readFile(store.globalSettingsPath, "utf8")).toBe(malformedBytes);
  });
});
