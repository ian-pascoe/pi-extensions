import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ToolInstaller } from "@ian-pascoe/pi-tool-installer";
import { LspServerClient } from "../src/lsp-server-client.js";
import { frameworkUpdateRequest, prepareFrameworkPreset } from "../src/lsp-frameworks.js";

const roots: string[] = [];
let store = process.env.PI_LSP_FRAMEWORK_STORE;
beforeAll(async () => {
  if (process.env.PI_LSP_FRAMEWORK_NATIVE === "1" && !store) {
    store = await mkdtemp(join(tmpdir(), "pi-framework-tools-"));
    roots.push(store);
  }
});
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function prepareProjectSdk(root: string, installer: ToolInstaller, version: string) {
  if (version === "managed") return;
  const fixture = await installer.ensure(
    {
      id: `framework-fixture-sdk-${version.replaceAll(".", "-")}`,
      requirements: { node: "core:node", sdk: `npm:typescript@${version}` },
    },
    { allowDownload: true, signal: AbortSignal.timeout(240_000), onProgress: console.info },
  );
  await mkdir(join(root, "node_modules"), { recursive: true });
  await symlink(
    join(fixture.components.sdk!.directory, "node_modules", "typescript"),
    join(root, "node_modules", "typescript"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

describe.runIf(process.env.PI_LSP_FRAMEWORK_NATIVE === "1")("native framework operations", () => {
  test.each(["managed", "5.8.3"])(
    "Vue template hover uses the private tsserver plugin bridge with %s SDK without project changes",
    async (sdkVersion) => {
      const root = await mkdtemp(join(tmpdir(), "pi-vue-native-"));
      roots.push(root);
      const file = join(root, "App.vue");
      const source =
        '<script setup lang="ts">\nconst answer: number = 42;\n</script>\n<template>{{ answer }}</template>\n';
      await writeFile(file, source);
      const installer = new ToolInstaller(store!);
      // Prepared project dependency, not an acquisition side effect of the LSP preset.
      const fixture = await installer.ensure(
        { id: "framework-fixture-vue", requirements: { node: "core:node", library: "npm:vue" } },
        { allowDownload: true, signal: AbortSignal.timeout(240_000), onProgress: console.info },
      );
      await mkdir(join(root, "node_modules"));
      await symlink(
        join(fixture.components.library!.directory, "node_modules", "vue"),
        join(root, "node_modules", "vue"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await prepareProjectSdk(root, installer, sdkVersion);
      const definition = await prepareFrameworkPreset(
        {
          id: "vue",
          preset: true,
          command: "vue-language-server",
          args: ["--stdio"],
          environment: { PATH: "" },
          languages: [],
          rootMarkers: [],
          requireRootMarker: false,
        },
        root,
        installer,
        true,
        { signal: AbortSignal.timeout(240_000), onProgress: console.info },
      );
      const client = await LspServerClient.start({
        serverId: "vue",
        rootPath: root,
        ...definition,
        initializationOptions: definition.initializationOptions ?? {},
        settings: definition.settings ?? {},
        stderrPath: join(root, "stderr"),
        timeouts: {
          initializeMs: 30_000,
          requestMs: 30_000,
          diagnosticsMs: 10_000,
          shutdownMs: 3000,
        },
      });
      try {
        const status = await client.request<{ body: { version: string } }>(
          "workspace/executeCommand",
          {
            command: "typescript.tsserverRequest",
            arguments: ["status", {}, { executionTarget: 0 }],
          },
        );
        expect(status.body.version).toBe(
          sdkVersion === "managed"
            ? (await installer.installed("lsp-vue"))!.components.sdk!.version
            : sdkVersion,
        );
        const document = await client.synchronizeDocument(file, "vue");
        const hover = await client.request("textDocument/hover", {
          textDocument: { uri: document.uri },
          position: { line: 3, character: 16 },
        });
        expect(JSON.stringify(hover)).toContain("answer");
        expect(JSON.stringify(hover)).toContain("number");
        expect(await readFile(file, "utf8")).toBe(source);
        expect((await readdir(root)).sort()).toEqual(["App.vue", "node_modules", "stderr"]);
        await writeFile(file, source.replace("= 42", '= "bad"'));
        await client.synchronizeDocument(file, "vue");
        const diagnostics = await client.documentDiagnostics(file, "vue");
        expect(diagnostics.status).toBe("fresh");
        expect(diagnostics.diagnostics).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: 2322 })]),
        );
        await writeFile(file, source);
        const clean = await client.documentDiagnostics(file, "vue");
        expect(clean.status).toBe("fresh");
        expect(clean.diagnostics).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ code: 2322 })]),
        );
      } catch (error) {
        console.error(await readFile(join(root, "stderr"), "utf8"));
        throw error;
      } finally {
        await client.shutdown();
      }
    },
    300_000,
  );

  test("installed-only SDK sharing starts an external protocol fixture without reacquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-framework-sharing-"));
    roots.push(root);
    const installer = new ToolInstaller(store!);
    await installer.ensure(
      {
        id: "framework-donor-sdk",
        requirements: { node: "core:node", compiler: "npm:typescript@6" },
      },
      { allowDownload: true, signal: AbortSignal.timeout(240_000), onProgress: console.info },
    );
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
    await writeFile(join(peer, "index.js"), 'module.exports = { version: "7.0.2" };\n');
    const definition = await prepareFrameworkPreset(
      {
        id: "svelte",
        preset: true,
        command: "svelteserver",
        args: ["--stdio"],
        environment: {
          PATH: dirname(process.execPath),
          PI_FRAMEWORK_SVELTE: "1",
          PI_FRAMEWORK_PROTOCOL: createRequire(import.meta.url).resolve(
            "vscode-languageserver-protocol/node",
          ),
        },
        languages: [],
        rootMarkers: [],
        requireRootMarker: false,
      },
      root,
      installer,
      false,
      {},
    );
    const client = await LspServerClient.start({
      serverId: "svelte",
      rootPath: root,
      ...definition,
      initializationOptions: definition.initializationOptions ?? {},
      settings: {},
      stderrPath: join(root, "stderr"),
      timeouts: { initializeMs: 30_000, requestMs: 30_000, diagnosticsMs: 1000, shutdownMs: 3000 },
    });
    try {
      expect(JSON.stringify(await client.request("textDocument/hover", {}))).toContain(
        "TypeScript SDK 6.",
      );
    } finally {
      await client.shutdown();
    }
  }, 300_000);

  test("Svelte script hover uses a compatible private SDK", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-svelte-native-"));
    roots.push(root);
    const file = join(root, "App.svelte");
    await writeFile(
      file,
      '<script lang="ts">\nconst answer: number = 42;\n</script>\n<p>{answer}</p>\n',
    );
    const installer = new ToolInstaller(store!);
    const definition = await prepareFrameworkPreset(
      {
        id: "svelte",
        preset: true,
        command: "svelteserver",
        args: ["--stdio"],
        environment: { PATH: "" },
        languages: [],
        rootMarkers: [],
        requireRootMarker: false,
      },
      root,
      installer,
      true,
      { signal: AbortSignal.timeout(240_000), onProgress: console.info },
    );
    const client = await LspServerClient.start({
      serverId: "svelte",
      rootPath: root,
      ...definition,
      initializationOptions: definition.initializationOptions ?? {},
      settings: {},
      stderrPath: join(root, "stderr"),
      timeouts: {
        initializeMs: 30_000,
        requestMs: 30_000,
        diagnosticsMs: 10_000,
        shutdownMs: 3000,
      },
    });
    try {
      const document = await client.synchronizeDocument(file, "svelte");
      const hover = await client.request("textDocument/hover", {
        textDocument: { uri: document.uri },
        position: { line: 1, character: 8 },
      });
      expect(JSON.stringify(hover)).toContain("answer");
      expect(JSON.stringify(hover)).toContain("number");
      expect((await readdir(root)).sort()).toEqual(["App.svelte", "stderr"]);
      const installation = (await installer.installed("lsp-svelte"))!;
      const update = (await frameworkUpdateRequest("svelte", installation, installer, root, {}))!;
      for (const selector of [installation.components.server!.selector, update.requirements.server])
        expect(selector).toMatch(
          /^npm:svelte-language-server\[trust_policy_excludes=svelte@4\.2\.20\]@\d+\.\d+\.\d+$/,
        );
      console.info(
        JSON.stringify({
          preset: "svelte",
          platform: process.platform,
          arch: process.arch,
          components: Object.fromEntries(
            Object.entries(installation.components).map(([name, component]) => [
              name,
              { version: component.version, selector: component.selector },
            ]),
          ),
        }),
      );
    } finally {
      await client.shutdown();
    }
  }, 300_000);

  test.each(["managed", "5.8.3"])(
    "Astro frontmatter hover uses a compatible %s SDK",
    async (sdkVersion) => {
      const root = await mkdtemp(join(tmpdir(), "pi-astro-native-"));
      roots.push(root);
      const file = join(root, "index.astro");
      await writeFile(file, "---\nconst answer: number = 42;\n---\n<p>{answer}</p>\n");
      const installer = new ToolInstaller(store!);
      await prepareProjectSdk(root, installer, sdkVersion);
      const definition = await prepareFrameworkPreset(
        {
          id: "astro",
          preset: true,
          command: "astro-ls",
          args: ["--stdio"],
          environment: { PATH: "" },
          languages: [],
          rootMarkers: [],
          requireRootMarker: false,
        },
        root,
        installer,
        true,
        { signal: AbortSignal.timeout(240_000), onProgress: console.info },
      );
      const client = await LspServerClient.start({
        serverId: "astro",
        rootPath: root,
        ...definition,
        initializationOptions: definition.initializationOptions ?? {},
        settings: {},
        stderrPath: join(root, "stderr"),
        timeouts: {
          initializeMs: 30_000,
          requestMs: 30_000,
          diagnosticsMs: 10_000,
          shutdownMs: 3000,
        },
      });
      try {
        const document = await client.synchronizeDocument(file, "astro");
        const hover = await client.request("textDocument/hover", {
          textDocument: { uri: document.uri },
          position: { line: 1, character: 8 },
        });
        expect(JSON.stringify(hover)).toContain("answer");
        expect(JSON.stringify(hover)).toContain("number");
      } finally {
        await client.shutdown();
      }
    },
    300_000,
  );
});
