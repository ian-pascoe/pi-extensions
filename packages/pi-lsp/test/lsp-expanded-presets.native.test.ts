import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { resolveLspPreset, withLspPresets } from "../src/lsp-presets.js";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ToolInstaller } from "@ian-pascoe/pi-tool-installer";
import { LspServerClient } from "../src/lsp-server-client.js";
import { LspServerManager } from "../src/lsp-server-manager.js";

const cases = [
  {
    id: "html",
    selector: "npm:vscode-langservers-extracted",
    script: "vscode-langservers-extracted/bin/vscode-html-language-server",
    file: "index.html",
    language: "html",
    text: '<main id="answer"><h1>Hello</h1></main>\n',
    args: ["--stdio"],
  },
  {
    id: "css",
    selector: "npm:vscode-langservers-extracted",
    script: "vscode-langservers-extracted/bin/vscode-css-language-server",
    file: "style.css",
    language: "css",
    text: ".answer { color: red; }\n",
    args: ["--stdio"],
  },
  {
    id: "json",
    selector: "npm:vscode-langservers-extracted",
    script: "vscode-langservers-extracted/bin/vscode-json-language-server",
    file: "data.json",
    language: "json",
    text: '{"answer":42}\n',
    args: ["--stdio"],
  },
  {
    id: "yaml",
    selector: "npm:yaml-language-server",
    script: "yaml-language-server/bin/yaml-language-server",
    file: "data.yaml",
    language: "yaml",
    text: "answer: 42\n",
    args: ["--stdio"],
  },
  {
    id: "bash",
    selector: "npm:bash-language-server",
    script: "bash-language-server/out/cli.js",
    file: "main.sh",
    language: "shellscript",
    text: "#!/bin/sh\nanswer() { echo 42; }\nanswer\n",
    args: ["start"],
  },
  {
    id: "dockerfile",
    selector: "npm:dockerfile-language-server-nodejs",
    script: "dockerfile-language-server-nodejs/bin/docker-langserver",
    file: "Dockerfile",
    language: "dockerfile",
    text: "FROM alpine:3.21\nENV ANSWER=42\n",
    args: ["--stdio"],
  },
];

let directory = "";
let installer: ToolInstaller;

describe.runIf(process.env.PI_LSP_PRESETS_NATIVE === "1")(
  "expanded native LSP acquisition and symbols",
  () => {
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "pi-lsp-presets-"));
      installer = new ToolInstaller(join(directory, "store"));
    });
    afterAll(async () => {
      if (!directory) return;
      if (process.platform !== "win32") {
        for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
          if (entry.isDirectory()) await chmod(join(entry.parentPath, entry.name), 0o700);
        }
      }
      await rm(directory, { recursive: true, force: true });
    });

    test("Bash privately resolves helpers or reports unsupported ShellCheck while retaining navigation and formatting", async () => {
      const root = join(directory, "bash-helpers");
      await mkdir(root);
      const file = join(root, "main.sh");
      await writeFile(file, "#!/bin/sh\nanswer() { echo $1; }\nif true;then echo hi;fi\n");
      const settings = withLspPresets({
        servers: new Map(),
        enablement: new Map(),
        warnings: [],
        timeouts: {
          initializeMs: 30_000,
          requestMs: 15_000,
          diagnosticsMs: 10_000,
          shutdownMs: 3_000,
        },
      });
      const definition = await resolveLspPreset(
        { ...settings.servers.get("bash")!, environment: { PATH: "" } },
        root,
        installer,
        true,
        { signal: AbortSignal.timeout(300_000) },
      );
      const client = await LspServerClient.start({
        ...definition,
        initializationOptions: definition.initializationOptions,
        settings: definition.settings,
        serverId: "bash",
        rootPath: root,
        timeouts: settings.timeouts,
        stderrPath: join(root, "server.stderr"),
      });
      try {
        console.info(
          JSON.stringify({
            platform: process.platform,
            arch: process.arch,
            installation: await installer.installed("lsp-bash"),
          }),
        );
        if (process.platform === "win32") {
          await expect(client.documentDiagnostics(file, "shellscript")).rejects.toThrow(
            `shellcheck diagnostics unavailable: Managed ShellCheck is not verified for win32/${process.arch}`,
          );
          expect((await installer.installed("lsp-bash"))?.components.shellcheck).toBeUndefined();
        } else {
          const diagnostics = await client.documentDiagnostics(file, "shellscript");
          expect(JSON.stringify(diagnostics)).toContain("2086");
        }
        const document = await client.synchronizeDocument(file, "shellscript");
        expect(
          JSON.stringify(
            await client.request("textDocument/documentSymbol", {
              textDocument: { uri: document.uri },
            }),
          ),
        ).toContain("answer");
        const edits = await client.request<unknown[]>("textDocument/formatting", {
          textDocument: { uri: document.uri },
          options: { tabSize: 2, insertSpaces: true },
        });
        expect(edits.length).toBeGreaterThan(0);
        expect(await readFile(file, "utf8")).toBe(
          "#!/bin/sh\nanswer() { echo $1; }\nif true;then echo hi;fi\n",
        );
      } finally {
        await client.shutdown();
      }
    }, 360_000);

    test.each([
      {
        id: "css",
        file: "style.css",
        valid: ".answer { color: red; }\n",
        invalid: ".answer { color red; }\n",
      },
      {
        id: "css",
        file: "style.scss",
        valid: ".answer { color: red; }\n",
        invalid: ".answer { color red; }\n",
      },
      {
        id: "css",
        file: "style.less",
        valid: ".answer { color: red; }\n",
        invalid: ".answer { color red; }\n",
      },
      {
        id: "json",
        file: "data.jsonc",
        valid: '// answer\n{"answer":42}\n',
        invalid: '// answer\n{"answer": }\n',
      },
      { id: "json", file: "data.json", valid: '{"answer":42}\n', invalid: '{"answer": }\n' },
      { id: "yaml", file: "data.yaml", valid: "answer: 42\n", invalid: "answer: [\n" },
      { id: "dockerfile", file: "Dockerfile", valid: "FROM alpine:3.21\n", invalid: "FROM\n" },
    ])(
      "$file preset participates in automatic diagnostics with fresh mutation feedback",
      async (candidate) => {
        const root = join(directory, `${candidate.file}-diagnostics`);
        await mkdir(root);
        const file = join(root, candidate.file);
        await writeFile(file, candidate.invalid);
        const settings = withLspPresets({
          servers: new Map(),
          enablement: new Map(),
          warnings: [],
          timeouts: {
            initializeMs: 30_000,
            requestMs: 15_000,
            diagnosticsMs: 10_000,
            shutdownMs: 3_000,
          },
        });
        const manager = new LspServerManager({
          cwd: root,
          settings,
          startClient: async ({ definition, rootPath, signal, timeouts }) => {
            const selected = await resolveLspPreset(
              { ...definition, environment: { PATH: "" } },
              rootPath,
              installer,
              true,
              { signal },
            );
            return LspServerClient.start({
              ...selected,
              serverId: definition.id,
              rootPath,
              signal,
              timeouts,
              settings: selected.settings,
              initializationOptions: selected.initializationOptions,
              stderrPath: join(root, `${definition.id}.stderr`),
            });
          },
        });
        const diagnose = () =>
          manager.runRead(
            file,
            undefined,
            (client) => client.hasCapability("textDocument/diagnostic"),
            (client, route) => client.documentDiagnostics(file, route.language.languageId),
          );
        try {
          const broken = await diagnose();
          expect(broken.failures).toEqual([]);
          expect(broken.successes).toHaveLength(1);
          expect(broken.successes[0]).toMatchObject({
            serverId: candidate.id,
            value: {
              status: "fresh",
              source: ["css", "json"].includes(candidate.id) ? "document_pull" : "push",
            },
          });
          const result = broken.successes[0]!.value;
          expect(result.diagnostics.length).toBeGreaterThan(0);
          await writeFile(file, candidate.valid);
          expect(await diagnose()).toMatchObject({
            failures: [],
            successes: [{ serverId: candidate.id, value: { status: "fresh", diagnostics: [] } }],
          });
          expect(await readFile(file, "utf8")).toBe(candidate.valid);
          const installation = await installer.installed(`lsp-${candidate.id}`);
          console.info(
            JSON.stringify({
              preset: candidate.id,
              file: candidate.file,
              platform: process.platform,
              arch: process.arch,
              components: Object.fromEntries(
                Object.entries(installation!.components).map(([name, component]) => [
                  name,
                  component.version,
                ]),
              ),
            }),
          );
        } finally {
          await manager.shutdown();
        }
      },
      360_000,
    );

    test("Deno reports missing remote dependencies without fetching or changing the project lock", async () => {
      let requests = 0;
      const remote = createServer((_request, response) => {
        requests++;
        response.end("export const remote = 1;\n");
      });
      await new Promise<void>((done) => remote.listen(0, "127.0.0.1", done));
      const address = Value.Parse(
        Type.Object({ port: Type.Integer({ minimum: 1 }) }),
        remote.address(),
      );
      const url = `http://127.0.0.1:${address.port}/remote.ts`;
      const root = join(directory, "deno-cache-policy");
      await mkdir(root);
      await writeFile(join(root, "deno.json"), "{}\n");
      const lock = '{"version":"5"}\n';
      await writeFile(join(root, "deno.lock"), lock);
      await writeFile(join(root, "dep.ts"), "export const answer = 42;\n");
      const file = join(root, "main.ts");
      await writeFile(
        file,
        `import { answer } from './dep.ts';\nimport { remote } from '${url}';\nconsole.log(answer, remote);\n`,
      );
      const settings = withLspPresets({
        servers: new Map(),
        enablement: new Map(),
        warnings: [],
        timeouts: {
          initializeMs: 30_000,
          requestMs: 15_000,
          diagnosticsMs: 10_000,
          shutdownMs: 3_000,
        },
      });
      const definition = await resolveLspPreset(
        { ...settings.servers.get("deno")!, environment: { PATH: "" } },
        root,
        installer,
        true,
        { signal: AbortSignal.timeout(300_000) },
      );
      const client = await LspServerClient.start({
        ...definition,
        initializationOptions: definition.initializationOptions,
        settings: definition.settings,
        serverId: "deno",
        rootPath: root,
        timeouts: settings.timeouts,
        stderrPath: join(root, "server.stderr"),
      });
      try {
        const missing = await client.documentDiagnostics(file, "typescript");
        expect(JSON.stringify(missing)).toContain(url);
        expect(requests).toBe(0);
        await writeFile(file, "import { answer } from './dep.ts';\nconsole.log(answer);\n");
        const ready = await client.documentDiagnostics(file, "typescript");
        expect(ready).toMatchObject({ diagnostics: [] });
        expect(requests).toBe(0);
        expect(await readFile(join(root, "deno.lock"), "utf8")).toBe(lock);
        expect((await readdir(root)).sort()).toEqual([
          "deno.json",
          "deno.lock",
          "dep.ts",
          "main.ts",
          "server.stderr",
        ]);
        expect(definition.environment.DENO_DIR).toContain(installer.directory);
      } finally {
        await client.shutdown();
        await new Promise<void>((done) => remote.close(() => done()));
      }
    }, 360_000);

    test.each([
      {
        id: "deno",
        selector: "core:deno",
        command: "deno",
        args: ["lsp"],
        file: "main.ts",
        language: "typescript",
        text: "export const answer = 42;\n",
      },
      {
        id: "terraform",
        selector: "aqua:hashicorp/terraform-ls",
        command: "terraform-ls",
        args: ["serve"],
        file: "main.tf",
        language: "terraform",
        text: 'variable "answer" { default = 42 }\n',
      },
    ])(
      "$id native executable returns symbols without changing project inputs",
      async (candidate) => {
        const installation = await installer.ensure(
          { id: `proof-${candidate.id}`, requirements: { server: candidate.selector } },
          {
            allowDownload: true,
            signal: AbortSignal.timeout(300_000),
            onProgress: (message) => console.info(`[${candidate.id}] ${message}`),
          },
        );
        console.info(
          JSON.stringify({ platform: process.platform, arch: process.arch, installation }),
        );
        const root = join(directory, candidate.id);
        await mkdir(root);
        const file = join(root, candidate.file);
        await writeFile(file, candidate.text);
        if (candidate.id === "deno") await writeFile(join(root, "deno.json"), "{}\n");
        const executable = candidate.command + (process.platform === "win32" ? ".exe" : "");
        let command = "";
        for (const bin of installation.binDirectories) {
          if ((await readdir(bin)).includes(executable)) {
            command = join(bin, executable);
            break;
          }
        }
        expect(command).not.toBe("");
        const settings =
          candidate.id === "deno"
            ? {
                deno: { enable: true, cacheOnSave: false, cache: join(directory, "deno-cache") },
                javascript: {},
                typescript: {},
              }
            : {};
        const client = await LspServerClient.start({
          serverId: candidate.id,
          rootPath: root,
          command,
          args: candidate.args,
          environment: {
            ...process.env,
            ...installation.environment,
            DENO_DIR: join(directory, "deno-cache"),
            PATH: installation.binDirectories.join(delimiter),
          },
          initializationOptions: candidate.id === "deno" ? settings.deno : {},
          settings,
          timeouts: {
            initializeMs: 30_000,
            requestMs: 15_000,
            diagnosticsMs: 5_000,
            shutdownMs: 3_000,
          },
          stderrPath: join(root, "server.stderr"),
        });
        try {
          const document = await client.synchronizeDocument(file, candidate.language);
          await expect
            .poll(
              async () =>
                await client.request<Array<{ name: string }>>("textDocument/documentSymbol", {
                  textDocument: { uri: document.uri },
                }),
              { timeout: 10_000 },
            )
            .toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  name: candidate.id === "terraform" ? 'variable "answer"' : "answer",
                }),
              ]),
            );
          expect(await readFile(file, "utf8")).toBe(candidate.text);
          expect((await readdir(root)).sort()).toEqual(
            [
              candidate.file,
              "server.stderr",
              ...(candidate.id === "deno" ? ["deno.json"] : []),
            ].sort(),
          );
        } finally {
          await client.shutdown();
        }
      },
      360_000,
    );

    test.each(cases)(
      "$id privately acquires its runtime and returns document symbols",
      async (candidate) => {
        const installation = await installer.ensure(
          {
            id: `proof-${candidate.id}`,
            requirements: { node: "core:node", server: candidate.selector },
          },
          {
            allowDownload: true,
            signal: AbortSignal.timeout(300_000),
            onProgress: (message) => console.info(`[${candidate.id}] ${message}`),
          },
        );
        console.info(
          JSON.stringify({ platform: process.platform, arch: process.arch, installation }),
        );
        const root = join(directory, candidate.id);
        await mkdir(root);
        const file = join(root, candidate.file);
        await writeFile(file, candidate.text);
        const node = installation.components.node!;
        const server = installation.components.server!;
        const client = await LspServerClient.start({
          serverId: candidate.id,
          rootPath: root,
          command: join(node.directory, process.platform === "win32" ? "node.exe" : "bin/node"),
          args: [join(server.directory, "node_modules", candidate.script), ...candidate.args],
          environment: {
            ...process.env,
            ...installation.environment,
            PATH: installation.binDirectories.join(delimiter),
          },
          settings: {},
          initializationOptions: {},
          timeouts: {
            initializeMs: 30_000,
            requestMs: 15_000,
            diagnosticsMs: 5_000,
            shutdownMs: 3_000,
          },
          stderrPath: join(root, "server.stderr"),
        });
        try {
          const document = await client.synchronizeDocument(file, candidate.language);
          await expect
            .poll(
              async () =>
                (
                  await client.request<unknown[]>("textDocument/documentSymbol", {
                    textDocument: { uri: document.uri },
                  })
                ).length,
              { timeout: 10_000 },
            )
            .toBeGreaterThan(0);
          expect(await readFile(file, "utf8")).toBe(candidate.text);
          expect((await readdir(root)).sort()).toEqual([candidate.file, "server.stderr"].sort());
        } finally {
          await client.shutdown();
        }
      },
      360_000,
    );
  },
);
