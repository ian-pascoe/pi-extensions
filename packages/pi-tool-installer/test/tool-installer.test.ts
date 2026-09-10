import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ToolInstaller } from "../src/index.js";

const directories: string[] = [];

beforeEach(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("Unexpected download")));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("installed-only mode reports a missing installation without acquiring its helper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-installer-"));
  directories.push(directory);
  const installer = new ToolInstaller(join(directory, "store"));

  await expect(
    installer.ensure(
      { id: "typescript", requirements: { node: "core:node" } },
      { allowDownload: false },
    ),
  ).rejects.toThrow("Enable automatic downloads or configure an external executable");
  await expect(installer.installed("typescript")).resolves.toBeUndefined();
});

test("explicit updates leave unused presets uninstalled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-installer-"));
  directories.push(directory);
  const installer = new ToolInstaller(join(directory, "store"));
  await expect(
    installer.update({ id: "unused", requirements: { node: "core:node" } }, {}),
  ).resolves.toBeUndefined();
  await expect(installer.installed("unused")).resolves.toBeUndefined();
});

test("rejects unsupported acquisition recipes before downloading anything", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-installer-"));
  directories.push(directory);
  const installer = new ToolInstaller(directory);
  await expect(
    installer.ensure(
      { id: "unsafe", requirements: { runtime: "asdf:workspace-plugin" } },
      { allowDownload: true },
    ),
  ).rejects.toThrow("Invalid managed tool request");
});

test("a corrupt helper download cannot publish a managed installation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-installer-"));
  directories.push(directory);
  const assets = [
    "linux-x64",
    "linux-arm64",
    "macos-x64",
    "macos-arm64",
    "windows-x64.exe",
    "windows-arm64.exe",
  ].map((target) => ({
    name: `mise-v2026.9.4-${target}`,
    digest: `sha256:${"0".repeat(64)}`,
  }));
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ tag_name: "v2026.9.4", assets }))
      .mockResolvedValueOnce(new Response("corrupt download")),
  );
  const installer = new ToolInstaller(directory);
  await expect(
    installer.ensure(
      { id: "node", requirements: { runtime: "core:node" } },
      { allowDownload: true },
    ),
  ).rejects.toThrow("SHA-256 verification");
  await expect(installer.installed("node")).resolves.toBeUndefined();
});
