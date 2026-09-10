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
  vi.unstubAllEnvs();
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

test("GitHub rate limits explain recovery without publishing an installation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-installer-"));
  directories.push(directory);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(null, {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
    ),
  );
  const installer = new ToolInstaller(directory);
  await expect(
    installer.ensure(
      { id: "node", requirements: { runtime: "core:node" } },
      { allowDownload: true },
    ),
  ).rejects.toThrow("GitHub API rate limit exhausted; retry later or supply GITHUB_TOKEN");
  await expect(installer.installed("node")).resolves.toBeUndefined();
});

test.each([undefined, "fixture-github-token"])(
  "a corrupt helper stays unpublished and GitHub credentials stay on metadata requests (%s)",
  async (token) => {
    vi.stubEnv("GITHUB_TOKEN", token);
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
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ tag_name: "v2026.9.4", assets }))
      .mockResolvedValueOnce(new Response("corrupt download"));
    vi.stubGlobal("fetch", fetch);
    const installer = new ToolInstaller(directory);
    await expect(
      installer.ensure(
        { id: "node", requirements: { runtime: "core:node" } },
        { allowDownload: true },
      ),
    ).rejects.toThrow("SHA-256 verification");
    await expect(installer.installed("node")).resolves.toBeUndefined();
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/jdx/mise/releases/latest");
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      token ? `Bearer ${token}` : null,
    );
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).has("Authorization")).toBe(false);
  },
);
