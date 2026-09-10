import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ToolInstaller } from "../src/index.js";

// The external executable is replaced, not any ToolInstaller method.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const directories: string[] = [];

async function fixture(latest: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "pi tool fixture 空間 "));
  directories.push(directory);
  await writeFile(join(directory, process.platform === "win32" ? "mise.exe" : "mise"), "fixture");
  const control = async (versions: Record<string, string>, fail?: string) => {
    await writeFile(join(directory, "fixture.json"), JSON.stringify({ latest: versions, fail }));
  };
  await control(latest);
  const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawn).mockImplementation((command, args, options) => {
    if (command !== join(directory, process.platform === "win32" ? "mise.exe" : "mise"))
      return original.spawn(command, args ?? [], options ?? {});
    return original.spawn(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/mise.cjs", import.meta.url)), ...(args ?? []).slice(2)],
      options ?? {},
    );
  });
  return { directory, installer: new ToolInstaller(directory), control };
}

beforeEach(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("Unexpected download")));
});

afterEach(async () => {
  vi.mocked(spawn).mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("ensure reconciles requirements without upgrading unchanged prerequisites", async () => {
  const { installer, control } = await fixture({ "core:node": "22.1.0", "npm:prettier": "3.1.0" });
  const initial = { id: "formatter", requirements: { node: "core:node" } };
  const previous = await installer.ensure(initial, { allowDownload: true });
  await control({ "core:node": "24.1.0", "npm:prettier": "3.2.0" });
  const changed = {
    id: "formatter",
    requirements: { node: "core:node", formatter: "npm:prettier" },
  };
  await expect(installer.ensure(changed, { allowDownload: false })).rejects.toThrow(
    "not installed",
  );
  await expect(installer.installed(initial.id)).resolves.toEqual(previous);
  const current = await installer.ensure(changed, { allowDownload: true });
  expect(current.components.node).toEqual(previous.components.node);
  expect(current.components.formatter?.version).toBe("3.2.0");
  await expect(installer.ensure(changed, { allowDownload: false })).resolves.toEqual(current);
  const updated = await installer.update(changed, {});
  expect(updated?.previous).toEqual(current);
  expect(updated?.current.components.node?.version).toBe("24.1.0");
});

test("changed selectors replace the selected component and native version prefixes are not appended twice", async () => {
  const { installer, control } = await fixture({ "npm:@biomejs/biome@2": "2.1.0" });
  const request = { id: "formatter", requirements: { formatter: "npm:@biomejs/biome@2" } };
  const previous = await installer.ensure(request, { allowDownload: true });
  expect(previous.components.formatter?.directory).toContain(
    join(Buffer.from("npm:@biomejs/biome").toString("hex"), "2.1.0"),
  );
  await control({ "npm:prettier": "3.2.0" });
  const replacement = { id: request.id, requirements: { formatter: "npm:prettier" } };
  await expect(installer.ensure(replacement, { allowDownload: false })).rejects.toThrow(
    "not installed",
  );
  const current = await installer.ensure(replacement, { allowDownload: true });
  expect(current.components.formatter?.selector).toBe("npm:prettier");
  expect(current.components.formatter?.version).toBe("3.2.0");
  await expect(installer.installed(request.id)).resolves.toEqual(current);
});

test("incomplete helper results never become a usable selection and can be retried", async () => {
  const { installer, directory, control } = await fixture({ "core:node": "22.1.0" });
  const request = { id: "node", requirements: { node: "core:node" } };
  const previous = await installer.ensure(request, { allowDownload: true });
  await writeFile(
    join(directory, "fixture.json"),
    JSON.stringify({ latest: { "core:node": "24.1.0" }, incomplete: true }),
  );
  await expect(installer.update(request, {})).rejects.toThrow();
  await expect(installer.installed("node")).resolves.toEqual(previous);
  await control({ "core:node": "24.1.0" });
  const updated = await installer.update(request, {});
  expect(updated?.current.components.node?.version).toBe("24.1.0");
  const component = updated?.current.components.node;
  if (!component) throw new Error("Missing updated Node component");
  await rm(component.directory, { recursive: true });
  await expect(installer.ensure(request, { allowDownload: false })).rejects.toThrow();
  await control({ "core:node": "26.1.0" });
  const recovered = await installer.ensure(request, { allowDownload: true });
  expect(recovered.components.node).toEqual(component);
  const selection = JSON.parse(await readFile(join(directory, "selections/node.json"), "utf8"));
  selection.components.node.directory = join(directory, "..");
  await writeFile(join(directory, "selections/node.json"), JSON.stringify(selection));
  await expect(installer.installed("node")).rejects.toThrow("Invalid managed component directory");
});

test("failed and cancelled actual installs keep the old selection visible until a successful retry", async () => {
  const { installer, directory, control } = await fixture({ "core:node": "22.1.0" });
  const request = { id: "node", requirements: { runtime: "core:node" } };
  const previous = await installer.ensure(request, { allowDownload: true });
  await control({ "core:node": "24.1.0" }, "core:node@24.1.0");
  await expect(installer.update(request, {})).rejects.toThrow("Fixture acquisition failed");
  await expect(installer.installed("node")).resolves.toEqual(previous);
  await writeFile(
    join(directory, "fixture.json"),
    JSON.stringify({ latest: { "core:node": "24.1.0" }, pause: "core:node@24.1.0" }),
  );
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  const update = installer.update(request, {
    signal: controller.signal,
    onProgress: (message) => {
      if (message === "Downloading fixture") started.resolve();
    },
  });
  await started.promise;
  await expect(installer.installed("node")).resolves.toEqual(previous);
  controller.abort(new Error("Cancelled actual install"));
  await expect(update).rejects.toThrow("Cancelled actual install");
  await expect(installer.installed("node")).resolves.toEqual(previous);
  await control({ "core:node": "24.1.0" });
  const retried = await installer.update(request, {});
  expect(retried?.current.components.runtime?.version).toBe("24.1.0");
  await expect(
    new ToolInstaller(directory).ensure(request, { allowDownload: false }),
  ).resolves.toEqual(retried?.current);
});

test("installed rejects malformed selection metadata rather than treating it as executable knowledge", async () => {
  const { installer, directory } = await fixture({ "core:node": "22.1.0" });
  const installation = await installer.ensure(
    { id: "node", requirements: { runtime: "core:node" } },
    { allowDownload: true },
  );
  const path = join(directory, "selections/node.json");
  for (const components of [
    {},
    { runtime: { ...installation.components.runtime, version: "latest" } },
    { runtime: { ...installation.components.runtime, selector: "asdf:workspace-plugin" } },
  ]) {
    await writeFile(path, JSON.stringify({ ...installation, components }));
    await expect(installer.installed("node")).rejects.toThrow("Invalid installation record");
  }
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
