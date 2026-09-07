import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { writeLspEnablement } from "../src/lsp-settings-store.js";

const directories: string[] = [];

async function createSettingsDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-lsp-store-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

test("rejects untrusted project writes before creating project settings", async () => {
  const cwd = await createSettingsDirectory();
  await expect(
    writeLspEnablement({
      agentDirectory: cwd,
      cwd,
      projectTrusted: false,
      scope: "project",
      serverId: "typescript",
      enabled: false,
    }),
  ).rejects.toThrow("untrusted project");
  expect(await readdir(cwd)).toEqual([]);
});

test("serializes concurrent global choices and keeps unusual server IDs as ordinary keys", async () => {
  const cwd = await createSettingsDirectory();
  await Promise.all(
    ["typescript", "python", "__proto__", "constructor", "a\nb"].map((serverId) =>
      writeLspEnablement({
        agentDirectory: cwd,
        cwd,
        projectTrusted: false,
        scope: "global",
        serverId,
        enabled: false,
      }),
    ),
  );
  expect(JSON.parse(await readFile(resolve(cwd, "settings.json"), "utf8"))).toEqual({
    lsp: {
      enablement: {
        typescript: false,
        python: false,
        ["__proto__"]: false,
        constructor: false,
        "a\nb": false,
      },
    },
  });
  expect(await readdir(cwd)).toEqual(["settings.json"]);
  expect((await stat(resolve(cwd, "settings.json"))).mode & 0o777).toBe(0o600);
});

test("preserves concurrent native Pi settings changes without blocking its synchronous writer", async () => {
  const cwd = await createSettingsDirectory();
  const path = resolve(cwd, "settings.json");
  await writeFile(path, JSON.stringify({ theme: "dark" }));
  const settings = SettingsManager.create(cwd, cwd, { projectTrusted: false });
  let finished = false;
  const writing = writeLspEnablement({
    agentDirectory: cwd,
    cwd,
    projectTrusted: false,
    scope: "global",
    serverId: "typescript",
    enabled: false,
  }).finally(() => {
    finished = true;
  });
  while (!finished && !existsSync(`${path}.lock`)) await nextTurn();

  settings.setTheme("light");
  await Promise.all([writing, settings.flush()]);

  expect(settings.drainErrors()).toEqual([]);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    theme: "light",
    lsp: { enablement: { typescript: false } },
  });
});

test("honors Pi's native settings lock and leaves a contended document unchanged", async () => {
  const cwd = await createSettingsDirectory();
  const path = resolve(cwd, "settings.json");
  await writeFile(path, "{}");
  await mkdir(`${path}.lock`);
  await expect(
    writeLspEnablement({
      agentDirectory: cwd,
      cwd,
      projectTrusted: true,
      scope: "global",
      serverId: "typescript",
      enabled: false,
    }),
  ).rejects.toMatchObject({ code: "ELOCKED" });
  expect(await readFile(path, "utf8")).toBe("{}");
  expect(await readdir(cwd)).toEqual(["settings.json", "settings.json.lock"]);
});

test("updates native BOM-prefixed settings while preserving the BOM and unchanged bytes", async () => {
  const cwd = await createSettingsDirectory();
  const path = resolve(cwd, "settings.json");
  const original = '\uFEFF{ "theme": "dark", "lsp": { "enablement": { "typescript": false } } }';
  await writeFile(path, original);
  const settings = SettingsManager.create(cwd, cwd, { projectTrusted: false });
  expect(settings.drainErrors()).toEqual([]);
  expect(settings.getTheme()).toBe("dark");
  const input = {
    agentDirectory: cwd,
    cwd,
    projectTrusted: false,
    scope: "global" as const,
    serverId: "typescript",
    enabled: false,
  };

  await writeLspEnablement(input);
  expect(await readFile(path, "utf8")).toBe(original);
  await writeLspEnablement({ ...input, enabled: true });
  const changed = await readFile(path, "utf8");
  expect(changed.startsWith("\uFEFF")).toBe(true);
  expect(JSON.parse(changed.slice(1))).toEqual({
    theme: "dark",
    lsp: { enablement: { typescript: true } },
  });
});

test("preserves settings symlinks, permissions, and original bytes on an unchanged choice", async () => {
  const cwd = await createSettingsDirectory();
  const targetDirectory = await createSettingsDirectory();
  const target = resolve(targetDirectory, "dotfiles.json");
  const path = resolve(cwd, "settings.json");
  const original = '{ "lsp": { "enablement": { "typescript": false } }, "theme": "dark" }';
  await writeFile(target, original);
  await chmod(target, 0o640);
  await symlink(target, path);
  const input = {
    agentDirectory: cwd,
    cwd,
    projectTrusted: false,
    scope: "global" as const,
    serverId: "typescript",
    enabled: false,
  };
  await writeLspEnablement(input);
  expect(await readFile(target, "utf8")).toBe(original);
  await writeLspEnablement({ ...input, enabled: true });
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  expect((await stat(target)).mode & 0o777).toBe(0o640);
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
    lsp: { enablement: { typescript: true } },
    theme: "dark",
  });
  expect(await readdir(targetDirectory)).toEqual(["dotfiles.json"]);
});

test.each([
  "not json",
  "null",
  "[]",
  '{"lsp":null}',
  '{"lsp":[]}',
  '{"lsp":{"enablement":null}}',
  '{"lsp":{"enablement":[]}}',
  '{"lsp":{"enablement":{"typescript":"false"}}}',
  '{"lsp":{"enablement":{"":false}}}',
])("rejects an invalid document unchanged: %s", async (text) => {
  const cwd = await createSettingsDirectory();
  const path = resolve(cwd, "settings.json");
  await writeFile(path, text);
  await expect(
    writeLspEnablement({
      agentDirectory: cwd,
      cwd,
      projectTrusted: true,
      scope: "global",
      serverId: "typescript",
      enabled: false,
    }),
  ).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(text);
});

test("persists project eligibility without copying inherited definitions or changing unrelated settings", async () => {
  const cwd = await createSettingsDirectory();
  const agentDirectory = await createSettingsDirectory();
  const globalText = JSON.stringify({ lsp: { servers: { typescript: { command: "ts-lsp" } } } });
  await writeFile(resolve(agentDirectory, "settings.json"), globalText);
  await mkdir(resolve(cwd, ".pi"));
  await writeFile(
    resolve(cwd, ".pi/settings.json"),
    JSON.stringify({ theme: "dark", lsp: { timeouts: { requestMs: 500 } } }),
  );

  await writeLspEnablement({
    agentDirectory,
    cwd,
    projectTrusted: true,
    scope: "project",
    serverId: "typescript",
    enabled: false,
  });

  expect(JSON.parse(await readFile(resolve(cwd, ".pi/settings.json"), "utf8"))).toEqual({
    theme: "dark",
    lsp: { timeouts: { requestMs: 500 }, enablement: { typescript: false } },
  });
  expect(await readFile(resolve(agentDirectory, "settings.json"), "utf8")).toBe(globalText);
});
