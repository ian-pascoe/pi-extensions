import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

// 27 real Node helper launches share CPU with downloads/builds in the native matrix.
test("ensure reconciles requirements without upgrading unchanged prerequisites", async () => {
  const { installer, control } = await fixture({ "core:node": "22.1.0", "npm:prettier": "3.1.0" });
  const initial = { id: "formatter", requirements: { node: "core:node" } };
  const previous = await installer.ensure(initial, { allowDownload: true });
  await control({ "core:node": "24.1.0", "npm:prettier": "3.2.0" });
  const changed = {
    id: "formatter",
    requirements: { node: "core:node", formatter: "npm:prettier" },
  };
  await installer.ensure({ ...changed, id: "other-formatter" }, { allowDownload: true });
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
}, 30_000);

test("installed-only reuses another selection's toolchain without its trailing tool or environment", async () => {
  const versions = { "core:go": "1.27.1", "go:golang.org/x/tools/gopls": "0.23.0" };
  const { installer, directory, control } = await fixture(versions);
  await writeFile(
    join(directory, "fixture.json"),
    JSON.stringify({
      latest: versions,
      environments: {
        "core:go@1.27.1": { INSTALLER_FIXTURE_CONTEXT: "runtime" },
        "go:golang.org/x/tools/gopls@0.23.0": { INSTALLER_FIXTURE_CONTEXT: "server" },
      },
    }),
  );
  const previous = await installer.ensure(
    { id: "lsp-gopls", requirements: { go: "core:go", server: "go:golang.org/x/tools/gopls" } },
    { allowDownload: true },
  );
  const original = await readFile(join(directory, "selections/lsp-gopls.json"), "utf8");
  await rm(join(directory, process.platform === "win32" ? "mise.exe" : "mise"));
  vi.mocked(spawn).mockClear();
  const request = { id: "formatter-gofmt", requirements: { formatter: "core:go" } };
  const [current, concurrent] = await Promise.all([
    installer.ensure(request, { allowDownload: false }),
    new ToolInstaller(directory).ensure(request, { allowDownload: false }),
  ]);
  expect(current).toEqual({
    id: request.id,
    components: { formatter: previous.components.go },
    binDirectories: [join(previous.components.go!.directory, "bin")],
    environment: { INSTALLER_FIXTURE_CONTEXT: "runtime" },
  });
  expect(concurrent).toEqual(current);
  expect(await readFile(join(current.components.formatter!.directory, "complete"), "utf8")).toBe(
    "core:go@1.27.1",
  );
  await expect(new ToolInstaller(directory).installed(request.id)).resolves.toEqual(current);
  await expect(installer.installed("lsp-gopls")).resolves.toEqual(previous);
  expect(await readFile(join(directory, "selections/lsp-gopls.json"), "utf8")).toBe(original);
  expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  await writeFile(join(directory, process.platform === "win32" ? "mise.exe" : "mise"), "fixture");
  // No server version is available: updating the adopted prefix must not request it.
  await control({ "core:go": "1.28.0" });
  const updated = await installer.update(request, {});
  expect(Object.keys(updated!.current.components)).toEqual(["formatter"]);
  expect(updated?.current.components.formatter?.version).toBe("1.28.0");
  await expect(installer.installed("lsp-gopls")).resolves.toEqual(previous);
});

// The three-component graph launches 12 helpers before metadata-only reuse checks.
test("legacy complete graphs remain reusable without guessing missing prefix context", async () => {
  const { installer, directory } = await fixture({
    "core:python": "3.14.7",
    "aqua:astral-sh/uv": "0.12.12",
    "pipx:black": "26.5.1",
  });
  const request = {
    id: "black",
    requirements: { python: "core:python", uv: "aqua:astral-sh/uv", formatter: "pipx:black" },
  };
  const previous = await installer.ensure(request, { allowDownload: true });
  // Pre-release records contain the final context but no per-prefix provenance.
  await writeFile(join(directory, "selections/black.json"), JSON.stringify(previous));
  await rm(join(directory, process.platform === "win32" ? "mise.exe" : "mise"));
  vi.mocked(spawn).mockClear();
  await expect(installer.ensure(request, { allowDownload: false })).resolves.toEqual(previous);
  const reused = await installer.ensure(
    {
      id: "formatter-black",
      requirements: {
        interpreter: "core:python",
        resolver: "aqua:astral-sh/uv",
        tool: "pipx:black",
      },
    },
    { allowDownload: false },
  );
  expect(reused).toEqual({
    ...previous,
    id: "formatter-black",
    components: {
      interpreter: previous.components.python,
      resolver: previous.components.uv,
      tool: previous.components.formatter,
    },
  });
  for (const requirements of [
    { python: "core:python" },
    { python: "core:python", formatter: "pipx:black" },
    { uv: "aqua:astral-sh/uv", python: "core:python", formatter: "pipx:black" },
  ]) {
    await expect(
      installer.ensure({ id: "missing-graph", requirements }, { allowDownload: false }),
    ).rejects.toThrow("not installed");
    await expect(installer.installed("missing-graph")).resolves.toBeUndefined();
  }
  await expect(installer.installed(request.id)).resolves.toEqual(previous);
  expect(vi.mocked(spawn)).not.toHaveBeenCalled();
}, 15_000);

test("reuse rejects corrupt context and missing requirements but ignores unrequested files", async () => {
  const { installer, directory } = await fixture({
    "core:go": "1.27.1",
    "go:golang.org/x/tools/gopls": "0.23.0",
  });
  const previous = await installer.ensure(
    { id: "lsp-gopls", requirements: { go: "core:go", server: "go:golang.org/x/tools/gopls" } },
    { allowDownload: true },
  );
  const path = join(directory, "selections/lsp-gopls.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  const request = { id: "formatter-gofmt", requirements: { formatter: "core:go" } };
  await rm(join(directory, process.platform === "win32" ? "mise.exe" : "mise"));
  vi.mocked(spawn).mockClear();
  await expect(
    installer.ensure(request, {
      allowDownload: false,
      signal: AbortSignal.abort(new Error("Cancelled reuse")),
    }),
  ).rejects.toThrow("Cancelled reuse");
  for (const contexts of [
    [],
    [{ ...record.contexts[0], environment: { PATH: directory } }, record.contexts[1]],
    [{ ...record.contexts[0], binDirectories: [join(directory, "..")] }, record.contexts[1]],
  ]) {
    await writeFile(path, JSON.stringify({ ...record, contexts }));
    await expect(installer.ensure(request, { allowDownload: false })).rejects.toThrow("Invalid");
    await expect(installer.installed(request.id)).resolves.toBeUndefined();
  }
  await writeFile(path, JSON.stringify(record));
  await rm(previous.components.server!.directory, { recursive: true });
  const reused = await installer.ensure(request, { allowDownload: false });
  expect(reused.components).toEqual({ formatter: previous.components.go });
  expect(await readFile(path, "utf8")).toBe(JSON.stringify(record));
  await rm(previous.components.go!.directory, { recursive: true });
  await expect(installer.ensure(request, { allowDownload: false })).rejects.toThrow(
    "not installed",
  );
  await expect(installer.installed(request.id)).resolves.toBeUndefined();
  expect(vi.mocked(spawn)).not.toHaveBeenCalled();
});

// Initial acquisition and update each launch 12 helpers under native-matrix load.
test("pipx updates reuse shared runtimes and retain UV in their installation identity", async () => {
  const versions = {
    "core:python": "3.14.7",
    "aqua:astral-sh/uv": "0.12.12",
    "pipx:black": "26.5.1",
  };
  const { installer, control } = await fixture(versions);
  const request = {
    id: "black",
    requirements: { python: "core:python", uv: "aqua:astral-sh/uv", formatter: "pipx:black" },
  };
  const previous = await installer.ensure(request, { allowDownload: true });
  const oldUv = previous.components.uv;
  if (!oldUv) throw new Error("Missing shared UV");
  expect(previous.binDirectories).toContain(join(oldUv.directory, "bin"));
  await control({ ...versions, "aqua:astral-sh/uv": "0.12.13" });
  const updated = await installer.update(request, {});
  if (!updated) throw new Error("Missing Black update");
  expect(updated.previous).toEqual(previous);
  expect(updated.current.components.python).toEqual(previous.components.python);
  expect(updated.current.components.formatter?.version).toBe("26.5.1");
  expect(updated.current.components.formatter?.directory).not.toBe(
    previous.components.formatter?.directory,
  );
  expect(updated.current.components.uv?.version).toBe("0.12.13");
  await expect(installer.ensure(request, { allowDownload: false })).resolves.toEqual(
    updated.current,
  );
}, 30_000);

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

test("npm version discovery preserves peer constraints without installing or creating state", async () => {
  const { directory } = await fixture({});
  const installer = new ToolInstaller(join(directory, "unused-store"));
  const fetch = vi.fn().mockResolvedValueOnce(
    Response.json({
      "dist-tags": { latest: "3.5.2" },
      versions: {
        "3.5.2": {
          name: "prettier-plugin-svelte",
          version: "3.5.2",
          peerDependencies: { prettier: "^3.0.0", svelte: "^4.0.0 || ^5.0.0" },
          engines: { node: ">=16" },
        },
        "4.1.1": {
          name: "prettier-plugin-svelte",
          version: "4.1.1",
          peerDependencies: { prettier: "^3.0.0", svelte: "^5.0.0" },
          engines: { node: ">=20" },
        },
      },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await installer.npmVersions("prettier-plugin-svelte", {})).toEqual([
    {
      name: "prettier-plugin-svelte",
      version: "3.5.2",
      latest: true,
      peerDependencies: { prettier: "^3.0.0", svelte: "^4.0.0 || ^5.0.0" },
      engines: { node: ">=16" },
    },
    {
      name: "prettier-plugin-svelte",
      version: "4.1.1",
      latest: false,
      peerDependencies: { prettier: "^3.0.0", svelte: "^5.0.0" },
      engines: { node: ">=20" },
    },
  ]);
  expect(fetch.mock.calls[0]?.[0]).toBe("https://registry.npmjs.org/prettier-plugin-svelte");
  await expect(access(installer.directory)).rejects.toMatchObject({ code: "ENOENT" });
  fetch.mockResolvedValueOnce(
    Response.json({ versions: { "1.0.0": { name: "other-package", version: "1.0.0" } } }),
  );
  await expect(installer.npmVersions("prettier-plugin-svelte", {})).rejects.toThrow(
    "Invalid npm package metadata",
  );
  fetch.mockClear();
  await expect(installer.npmVersions("https://other.test/pkg", {})).rejects.toThrow(
    "Invalid npm package name",
  );
  await expect(
    installer.npmVersions("prettier-plugin-svelte", {
      signal: AbortSignal.abort(new Error("Cancelled metadata")),
    }),
  ).rejects.toThrow("Cancelled metadata");
  expect(fetch).not.toHaveBeenCalled();
});

test("list reads validated compatible selections without acquiring tools or creating a store", async () => {
  const { installer, directory } = await fixture({ "core:node": "26.8.2" });
  await expect(installer.list()).resolves.toEqual([]);
  await expect(access(join(directory, "selections"))).rejects.toMatchObject({ code: "ENOENT" });
  const last = await installer.ensure(
    { id: "z-compatible", requirements: { runtime: "core:node" } },
    { allowDownload: true },
  );
  const first = await installer.ensure(
    { id: "a-compatible", requirements: { runtime: "core:node@22.1.0" } },
    { allowDownload: true },
  );
  await writeFile(join(directory, "selections", "a-compatible.json.tmp"), "incomplete");
  await rm(join(directory, process.platform === "win32" ? "mise.exe" : "mise"));
  vi.mocked(spawn).mockClear();
  await expect(new ToolInstaller(directory).list()).resolves.toEqual([first, last]);
  await rm(first.components.runtime!.directory, { recursive: true });
  await expect(installer.list()).resolves.toEqual([last]);
  expect(spawn).not.toHaveBeenCalled();
  await writeFile(join(directory, "selections", "corrupt.json"), "{}");
  await expect(installer.list()).rejects.toThrow("Invalid installation record");
});

test("HTTP artifacts pass the published version checksum to native acquisition", async () => {
  const selector =
    "http:eslint[url=https://example.test/{{version}}.vsix,format=zip,checksum_url=https://example.test/{{version}}.sha256]";
  const { installer, control } = await fixture({ [selector]: "3.0.34" });
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response("ca5334d46f6a39079e751ef4601bfc9f86bc3a46483e87291ec609239d161308\n"),
    );
  vi.stubGlobal("fetch", fetch);
  const request = { id: "eslint", requirements: { server: selector } };
  const installation = await installer.ensure(request, { allowDownload: true });
  expect(fetch.mock.calls[0]?.[0]).toBe("https://example.test/3.0.34.sha256");
  expect(installation.components.server?.selector).toBe(selector);
  expect(await readFile(join(installation.components.server!.directory, "complete"), "utf8")).toBe(
    "http:eslint[url=https://example.test/{{version}}.vsix,format=zip,checksum=sha256:ca5334d46f6a39079e751ef4601bfc9f86bc3a46483e87291ec609239d161308]@3.0.34",
  );
  fetch.mockClear();
  await expect(installer.ensure(request, { allowDownload: false })).resolves.toEqual(installation);
  expect(fetch).not.toHaveBeenCalled();
  await control({ [selector]: "3.0.35" });
  for (const [response, message] of [
    [new Response("not a SHA-256 digest"), "Invalid published SHA-256 checksum"],
    [new Response("", { status: 503 }), "Cannot fetch published checksum: HTTP 503"],
  ] as const) {
    fetch.mockResolvedValueOnce(response);
    await expect(installer.update(request, {})).rejects.toThrow(message);
    await expect(installer.installed(request.id)).resolves.toEqual(installation);
  }
});

test("changed HTTP artifact options cannot bypass verification through an installed version", async () => {
  const original =
    "http:eslint[url=https://example.test/server.vsix,checksum=sha256:ca5334d46f6a39079e751ef4601bfc9f86bc3a46483e87291ec609239d161308]";
  const changed =
    "http:eslint[url=https://example.test/server.vsix,checksum=sha256:0000000000000000000000000000000000000000000000000000000000000000]";
  const versions = { [original]: "3.0.34", [changed]: "3.0.34" };
  const { installer, control } = await fixture(versions);
  const request = { id: "eslint", requirements: { server: original } };
  const previous = await installer.ensure(request, { allowDownload: true });
  await control(versions, `${changed}@3.0.34`);
  await expect(
    installer.update({ ...request, requirements: { server: changed } }, {}),
  ).rejects.toThrow("Fixture acquisition failed");
  await expect(installer.installed(request.id)).resolves.toEqual(previous);
  expect(await readFile(join(previous.components.server!.directory, "complete"), "utf8")).toBe(
    `${original}@3.0.34`,
  );
});

test("optional private executable directories need not exist before a tool is first used", async () => {
  const { installer, directory } = await fixture({ "core:deno": "2.9.6" });
  await writeFile(
    join(directory, "fixture.json"),
    JSON.stringify({
      latest: { "core:deno": "2.9.6" },
      pathEntries: [join(directory, "data", "deno-global-tools", "bin")],
    }),
  );
  const request = { id: "deno", requirements: { runtime: "core:deno" } };
  const installation = await installer.ensure(request, { allowDownload: true });
  expect(installation.binDirectories).toEqual([
    join(installation.components.runtime!.directory, "bin"),
  ]);
  await expect(
    new ToolInstaller(directory).ensure(request, { allowDownload: false }),
  ).resolves.toEqual(installation);
  await writeFile(
    join(directory, "fixture.json"),
    JSON.stringify({
      latest: { "core:deno": "2.9.7" },
      pathEntries: [join(directory, "..", "missing-unsafe-executable-directory")],
    }),
  );
  await expect(installer.update(request, {})).rejects.toThrow(
    "Invalid managed executable directory",
  );
  await expect(installer.installed(request.id)).resolves.toEqual(installation);
});

test("exact runtime requirements bypass SDK latest discovery and stay exact across updates", async () => {
  const { installer, control } = await fixture({ "core:node": "26.8.2" });
  const request = {
    id: "compatible-runtime",
    requirements: {
      node: "core:node",
      runtime: "core:dotnet[runtime=dotnet]@8.0.21",
    },
  };
  const previous = await installer.ensure(request, { allowDownload: true });
  expect(previous.components.runtime?.version).toBe("8.0.21");
  expect(previous.components.runtime?.selector).toBe("core:dotnet[runtime=dotnet]@8.0.21");
  await control({ "core:node": "26.8.3" });
  const updated = await installer.update(request, {});
  expect(updated?.current.components.runtime).toEqual(previous.components.runtime);
  expect(updated?.current.components.node?.version).toBe("26.8.3");
  await expect(installer.ensure(request, { allowDownload: false })).resolves.toEqual(
    updated?.current,
  );
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

test("installed-only mode reports a missing installation without creating its store or helper", async () => {
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
  await expect(access(installer.directory)).rejects.toMatchObject({ code: "ENOENT" });
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
