import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CodeAction, WorkspaceEdit } from "vscode-languageserver-protocol";
import { LspServerClient } from "../src/lsp-server-client.js";
import { afterEach, expect, test, vi } from "vitest";
import { ToolInstaller } from "@ian-pascoe/pi-tool-installer";
import type { LspServerDefinition } from "../src/pi-lsp-settings.js";
import {
  prepareFrameworkPreset,
  frameworkPresetForInstallation,
  frameworkUpdateRequest,
} from "../src/lsp-frameworks.js";

// Replace only the external mise executable; installer and LSP client remain real.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.mocked(spawn).mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function project(sdkVersion: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-framework-selection-"));
  roots.push(root);
  const server = join(root, "node_modules", "@astrojs", "language-server");
  const sdk = join(root, "node_modules", "typescript");
  await mkdir(join(server, "bin"), { recursive: true });
  await copyFile(
    fileURLToPath(new URL("./fixtures/framework-sdk-server.cjs", import.meta.url)),
    join(server, "bin", "nodeServer.js"),
  );
  await mkdir(join(sdk, "lib"), { recursive: true });
  await writeFile(
    join(server, "package.json"),
    JSON.stringify({ name: "@astrojs/language-server", version: "2.16.16" }),
  );
  await writeFile(
    join(sdk, "package.json"),
    JSON.stringify({ name: "typescript", version: sdkVersion }),
  );
  await writeFile(
    join(sdk, "lib", "typescript.js"),
    `module.exports = { version: ${JSON.stringify(sdkVersion)} };\n`,
  );
  const definition: LspServerDefinition = {
    id: "astro",
    preset: true,
    command: "astro-ls",
    args: ["--stdio"],
    environment: {
      PATH: dirname(process.execPath),
      PI_FRAMEWORK_PROTOCOL: createRequire(import.meta.url).resolve(
        "vscode-languageserver-protocol/node",
      ),
    },
    languages: [],
    rootMarkers: [],
    requireRootMarker: false,
  };
  return { root, sdk, server, definition, installer: new ToolInstaller(join(root, "store")) };
}

async function startFramework(
  root: string,
  definition: LspServerDefinition,
  installer: ToolInstaller,
  allowDownload = false,
) {
  const prepared = await prepareFrameworkPreset(definition, root, installer, allowDownload, {});
  return LspServerClient.start({
    serverId: definition.id,
    rootPath: root,
    ...prepared,
    initializationOptions: prepared.initializationOptions ?? {},
    settings: {},
    stderrPath: join(root, "stderr"),
    timeouts: { initializeMs: 5000, requestMs: 3000, diagnosticsMs: 500, shutdownMs: 1000 },
  });
}

test.each(["5.8.3", "6.0.3"])(
  "compatible project SDK %s serves hover in installed-only mode without managed acquisition",
  async (version) => {
    const { root, definition, installer } = await project(version);
    const client = await startFramework(root, definition, installer);
    try {
      expect(
        await client.request("textDocument/hover", {
          textDocument: { uri: pathToFileURL(join(root, "index.astro")).href },
          position: { line: 0, character: 0 },
        }),
      ).toEqual({ contents: `TypeScript SDK ${version}` });
    } finally {
      await client.shutdown();
    }
  },
);

test("installed-only framework starts reuse another preset's SDK as project compatibility changes", async () => {
  const { root, sdk, server, definition, installer } = await project("6.0.3");
  await mkdir(installer.directory);
  await writeFile(
    join(installer.directory, process.platform === "win32" ? "mise.exe" : "mise"),
    "fixture",
  );
  await writeFile(join(installer.directory, "fixture.json"), JSON.stringify({ latest: {} }));
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawn).mockImplementation((command, args, options) =>
    /mise(?:\.exe)?$/u.test(String(command))
      ? actual.spawn(
          process.execPath,
          [
            fileURLToPath(
              new URL("../../pi-tool-installer/test/fixtures/mise.cjs", import.meta.url),
            ),
            ...(args ?? []).slice(2),
          ],
          options ?? {},
        )
      : actual.spawn(command, args ?? [], options ?? {}),
  );
  for (const version of ["6.0.3", "5.9.3"]) {
    const donor = await installer.ensure(
      {
        id: `donor-${version.replaceAll(".", "-")}`,
        requirements: { server: "npm:prettier@3.9.6", compiler: `npm:typescript@${version}` },
      },
      { allowDownload: true },
    );
    const packagePath = join(donor.components.compiler!.directory, "node_modules", "typescript");
    await cp(sdk, packagePath, { recursive: true });
    await writeFile(
      join(packagePath, "package.json"),
      JSON.stringify({ name: "typescript", version }),
    );
    await writeFile(
      join(packagePath, "lib", "typescript.js"),
      `module.exports = { version: ${JSON.stringify(version)} };\n`,
    );
  }
  await rm(sdk, { recursive: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Installed-only must not query the registry");
    }),
  );
  for (const [range, version] of [
    ["^6.0.2", "6.0.3"],
    ["^5.9.2", "5.9.3"],
  ]) {
    await writeFile(
      join(server, "package.json"),
      JSON.stringify({
        name: "@astrojs/language-server",
        version: "2.16.16",
        peerDependencies: { typescript: range },
      }),
    );
    const client = await startFramework(root, definition, installer);
    try {
      expect(await client.request("textDocument/hover", {})).toEqual({
        contents: `TypeScript SDK ${version}`,
      });
    } finally {
      await client.shutdown();
    }
  }
});

test("framework roots retain distinct compatible SDK selections for installed-only reopening", async () => {
  const a = await project("5.9.3");
  const b = await project("6.0.3");
  for (const [project, range] of [
    [a, "^5.9.2"],
    [b, "^6.0.2"],
  ] as const) {
    await rm(project.sdk, { recursive: true });
    await writeFile(
      join(project.server, "package.json"),
      JSON.stringify({
        name: "@astrojs/language-server",
        version: "2.16.16",
        peerDependencies: { typescript: range },
      }),
    );
  }
  await mkdir(a.installer.directory);
  await writeFile(
    join(a.installer.directory, process.platform === "win32" ? "mise.exe" : "mise"),
    "fixture",
  );
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawn).mockImplementation((command, args, options) =>
    /mise(?:\.exe)?$/u.test(String(command))
      ? actual.spawn(
          process.execPath,
          [
            fileURLToPath(new URL("./fixtures/framework-mise.cjs", import.meta.url)),
            ...(args ?? []).slice(2),
          ],
          options ?? {},
        )
      : actual.spawn(command, args ?? [], options ?? {}),
  );
  vi.stubGlobal("fetch", async () =>
    Response.json({
      versions: {
        "5.9.3": { name: "typescript", version: "5.9.3" },
        "6.0.3": { name: "typescript", version: "6.0.3" },
      },
    }),
  );
  for (const [project, version] of [
    [a, "5.9.3"],
    [b, "6.0.3"],
  ] as const) {
    const client = await startFramework(project.root, project.definition, a.installer, true);
    try {
      expect(await client.request("textDocument/hover", {})).toEqual({
        contents: `TypeScript SDK ${version}`,
      });
    } finally {
      await client.shutdown();
    }
  }
  vi.stubGlobal("fetch", () => {
    throw new Error("Reopening must not query the registry");
  });
  const client = await startFramework(a.root, a.definition, a.installer);
  try {
    expect(await client.request("textDocument/hover", {})).toEqual({
      contents: "TypeScript SDK 5.9.3",
    });
  } finally {
    await client.shutdown();
  }
  const variants = (await a.installer.list()).filter(
    (selection) => frameworkPresetForInstallation(selection.id) === "astro",
  );
  expect(variants.length).toBe(2);
  vi.stubGlobal("fetch", async () =>
    Response.json({
      versions: {
        "5.9.4": { name: "typescript", version: "5.9.4" },
        "6.0.4": { name: "typescript", version: "6.0.4" },
      },
    }),
  );
  const selectedA = variants.find((selection) => selection.components.sdk?.version === "5.9.3")!;
  const update = await frameworkUpdateRequest("astro", selectedA, a.installer, b.root, {});
  await a.installer.update(update!, {});
  vi.stubGlobal("fetch", () => {
    throw new Error("Reopening must not query the registry");
  });
  for (const [project, version] of [
    [a, "5.9.4"],
    [b, "6.0.3"],
  ] as const) {
    const reopened = await startFramework(project.root, project.definition, a.installer);
    try {
      expect(await reopened.request("textDocument/hover", {})).toEqual({
        contents: `TypeScript SDK ${version}`,
      });
    } finally {
      await reopened.shutdown();
    }
  }
});

test("an incompatible external Node runtime is not passed to a framework server", async () => {
  const { root, server, definition, installer } = await project("6.0.3");
  await writeFile(
    join(server, "package.json"),
    JSON.stringify({
      name: "@astrojs/language-server",
      version: "2.16.16",
      engines: { node: "<22" },
    }),
  );
  await expect(
    (async () => {
      const client = await startFramework(root, definition, installer);
      await client.shutdown();
    })(),
  ).rejects.toThrow("not installed");
});

test.each(["7.0.2"])(
  "incompatible project TypeScript %s is not passed to framework servers",
  async (version) => {
    const { root, definition, installer } = await project(version);
    await expect(startFramework(root, definition, installer)).rejects.toThrow("not installed");
  },
);

test("Vue action resolution retains its server owner and server-initiated changes remain previews", async () => {
  const { root } = await project("6.0.3");
  const file = join(root, "App.vue");
  await writeFile(file, "bad\n");
  const peer = fileURLToPath(new URL("./fixtures/framework-peer.mjs", import.meta.url));
  const previews: WorkspaceEdit[] = [];
  const client = await LspServerClient.start({
    serverId: "vue",
    rootPath: root,
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../src/lsp-vue-bridge.mjs", import.meta.url)),
      peer,
      root,
      root,
      peer,
    ],
    environment: { ...process.env, PI_FRAMEWORK_FIX_URI: pathToFileURL(file).href },
    initializationOptions: {},
    settings: {},
    stderrPath: join(root, "stderr"),
    timeouts: { initializeMs: 5000, requestMs: 3000, diagnosticsMs: 500, shutdownMs: 1000 },
    onWorkspaceEdit: async (edit) => {
      previews.push(edit);
      return "framework-preview";
    },
  });
  try {
    const actions = await client.request<CodeAction[]>("textDocument/codeAction", {
      textDocument: { uri: pathToFileURL(file).href },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      context: { diagnostics: [] },
    });
    const action = await client.request<CodeAction>("codeAction/resolve", actions[0]!);
    expect(action.title).toBe("Vue fix");
    expect(previews).toEqual([action.edit]);
    await client.request("workspace/executeCommand", action.command!);
    expect(client.capabilities.executeCommandProvider?.commands).toEqual(["host.fix", "vue.fix"]);
    expect(previews).toEqual([action.edit, action.edit]);
    expect(await readFile(file, "utf8")).toBe("bad\n");
  } finally {
    await client.shutdown();
  }
});

test("stopping a stuck Vue bridge also stops its tsserver descendants", async () => {
  const { root } = await project("6.0.3");
  const peer = fileURLToPath(new URL("./fixtures/framework-peer.mjs", import.meta.url));
  const client = await LspServerClient.start({
    serverId: "vue",
    rootPath: root,
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../src/lsp-vue-bridge.mjs", import.meta.url)),
      peer,
      root,
      root,
      peer,
    ],
    environment: { ...process.env, PI_FRAMEWORK_HANG_SHUTDOWN: "1" },
    initializationOptions: {},
    settings: {},
    stderrPath: join(root, "stderr"),
    timeouts: { initializeMs: 5000, requestMs: 3000, diagnosticsMs: 500, shutdownMs: 250 },
  });
  const pid = await client.request<number>("fixture/descendant", {});
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
      throw error;
    }
  };
  try {
    await client.shutdown();
    await expect.poll(alive, { timeout: 2000 }).toBe(false);
  } finally {
    await client.shutdown();
    if (alive()) process.kill(pid, "SIGKILL");
  }
});

test("Svelte binds its eager compiler peer to the compatible project SDK without changing dependencies", async () => {
  const { root, definition, installer } = await project("6.0.3");
  const server = join(root, "node_modules", "svelte-language-server");
  const peer = join(server, "node_modules", "typescript");
  await mkdir(join(server, "bin"), { recursive: true });
  await mkdir(peer, { recursive: true });
  await copyFile(
    fileURLToPath(new URL("./fixtures/framework-sdk-server.cjs", import.meta.url)),
    join(server, "bin", "server.js"),
  );
  await writeFile(
    join(server, "package.json"),
    JSON.stringify({
      name: "svelte-language-server",
      version: "0.18.4",
      peerDependencies: { typescript: "^5.9.2 || ^6.0.2" },
    }),
  );
  await writeFile(
    join(peer, "package.json"),
    JSON.stringify({ name: "typescript", version: "7.0.2", main: "index.js" }),
  );
  const peerSource = 'module.exports = { version: "7.0.2" };\n';
  await writeFile(join(peer, "index.js"), peerSource);
  const client = await startFramework(
    root,
    {
      ...definition,
      id: "svelte",
      command: "svelteserver",
      environment: { ...definition.environment, PI_FRAMEWORK_SVELTE: "1" },
    },
    installer,
  );
  try {
    expect(
      await client.request("textDocument/hover", {
        textDocument: { uri: pathToFileURL(join(root, "App.svelte")).href },
        position: { line: 0, character: 0 },
      }),
    ).toEqual({ contents: "TypeScript SDK 6.0.3" });
    expect(await readFile(join(peer, "index.js"), "utf8")).toBe(peerSource);
  } finally {
    await client.shutdown();
  }
});

test("Svelte retains its own TypeScript peer constraint", async () => {
  const { root, definition, installer } = await project("5.8.3");
  const server = join(root, "node_modules", "svelte-language-server");
  await mkdir(server, { recursive: true });
  await writeFile(
    join(server, "package.json"),
    JSON.stringify({
      name: "svelte-language-server",
      version: "0.18.4",
      peerDependencies: { typescript: "^5.9.2 || ^6.0.2" },
    }),
  );
  await expect(
    startFramework(root, { ...definition, id: "svelte", command: "svelteserver" }, installer),
  ).rejects.toThrow("not installed");
});

test("explicit framework definitions bypass compatibility acquisition", async () => {
  const { root, sdk, server, definition, installer } = await project("7.0.2");
  const explicit = {
    ...definition,
    preset: false,
    command: process.execPath,
    args: [join(server, "bin", "nodeServer.js"), "--stdio"],
    initializationOptions: { typescript: { tsdk: join(sdk, "lib") } },
  };
  const client = await startFramework(root, explicit, installer);
  try {
    expect(
      await client.request("textDocument/hover", {
        textDocument: { uri: pathToFileURL(join(root, "index.astro")).href },
        position: { line: 0, character: 0 },
      }),
    ).toEqual({ contents: "TypeScript SDK 7.0.2" });
  } finally {
    await client.shutdown();
  }
});
