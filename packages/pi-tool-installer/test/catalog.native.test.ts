import { execFile, type ExecFileOptions } from "node:child_process";
import { existsSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LspServerClient } from "../../pi-lsp/src/lsp-server-client.js";
import { DapSession } from "../../pi-dap/src/dap-session.js";
import { createDapSessionFiles } from "../../pi-dap/src/dap-session-files.js";
import type {
  DapAdapterDefinition,
  DapLaunchProfile,
  ResolvedDapSettings,
} from "../../pi-dap/src/pi-dap-settings.js";
import { ToolInstaller, type ManagedInstallation } from "../src/index.js";

const executeFile = promisify(execFile);
const execute = (command: string, args: string[], options: Pick<ExecFileOptions, "env">) =>
  executeFile(command, args, { ...options, encoding: "utf8", timeout: 45_000 });
const nativeExecutable = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);
let directory = "";
let temporaryDirectory = "";
let installer: ToolInstaller;

function component(installation: ManagedInstallation, name: string): string {
  const result = installation.components[name];
  if (!result) throw new Error(`Missing managed component ${name}`);
  return result.directory;
}

function environment(installation: ManagedInstallation) {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[name] = value;
  }
  return {
    ...inherited,
    ...installation.environment,
    HOME: join(directory, "child-home"),
    USERPROFILE: join(directory, "child-home"),
    APPDATA: join(directory, "child-home", "AppData", "Roaming"),
    LOCALAPPDATA: join(directory, "child-home", "AppData", "Local"),
    XDG_CONFIG_HOME: join(directory, "child-home", ".config"),
    XDG_CACHE_HOME: join(directory, "child-home", ".cache"),
    XDG_DATA_HOME: join(directory, "child-home", ".local", "share"),
    TMPDIR: temporaryDirectory,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    PATH: [...installation.binDirectories, process.env.PATH ?? ""].join(delimiter),
  };
}

function nodeExecutable(installation: ManagedInstallation): string {
  return join(
    component(installation, "node"),
    process.platform === "win32" ? "node.exe" : "bin/node",
  );
}

async function acquire(
  id: string,
  requirements: Record<string, string>,
): Promise<ManagedInstallation> {
  const result = await installer.ensure(
    { id, requirements },
    {
      allowDownload: true,
      signal: AbortSignal.timeout(300_000),
      onProgress: (message) => console.info(`[${id}] ${message}`),
    },
  );
  console.info(
    JSON.stringify({ platform: process.platform, arch: process.arch, installation: result }),
  );
  return result;
}

async function workspace(id: string): Promise<string> {
  const path = join(directory, "projects", id);
  await mkdir(path, { recursive: true });
  return path;
}

async function symbols(
  installation: ManagedInstallation,
  command: string,
  args: string[],
  file: string,
  language: string,
  initializationOptions: Record<string, string | { path: string }> = {},
): Promise<void> {
  const stderrPath = join(directory, `${installation.id}.stderr`);
  let client: LspServerClient | undefined;
  try {
    client = await LspServerClient.start({
      serverId: installation.id,
      rootPath: dirname(file),
      command,
      args,
      environment: environment(installation),
      initializationOptions,
      settings: {},
      timeouts: {
        initializeMs: 45_000,
        requestMs: 30_000,
        diagnosticsMs: 10_000,
        shutdownMs: 3_000,
      },
      stderrPath,
    });
    const document = await client.synchronizeDocument(file, language);
    const result = await client.request<Array<{ name: string }>>("textDocument/documentSymbol", {
      textDocument: { uri: document.uri },
    });
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ name: "answer" })]));
  } catch (error) {
    await client?.shutdown();
    console.error(await readFile(stderrPath, "utf8"));
    throw error;
  } finally {
    await client?.shutdown();
  }
}

async function debugScript(
  adapter: DapAdapterDefinition,
  arguments_: DapLaunchProfile["arguments"],
  file: string,
): Promise<void> {
  const files = await createDapSessionFiles(join(directory, "session-files"));
  const settings: ResolvedDapSettings = {
    adapters: new Map([[adapter.id, adapter]]),
    profiles: new Map([
      [adapter.id, { id: adapter.id, adapterId: adapter.id, arguments: arguments_ }],
    ]),
    timeouts: { startupMs: 30_000, requestMs: 15_000, executionMs: 30_000, shutdownMs: 5_000 },
    warnings: [],
  };
  const session = new DapSession({ cwd: dirname(file), settings, sessionFiles: files });
  try {
    await session.setBreakpoints({ filePath: file, breakpoints: [{ line: 3 }] });
    const launch = await session.launch({ profile: adapter.id, program: file, cwd: dirname(file) });
    expect(launch.snapshot).toMatchObject({ state: "stopped", stopReason: "entry" });
    expect((await session.continue()).snapshot).toMatchObject({
      state: "stopped",
      stopReason: "breakpoint",
    });
    const stack = await session.stack();
    const sourcePath = stack.stackFrames?.[0]?.source?.path;
    if (!sourcePath) throw new Error("The stopped frame has no source path");
    expect(await realpath(sourcePath)).toBe(await realpath(file));
    expect((await session.evaluate({ expression: "answer" })).evaluation?.result).toBe("42");
    const finished = await session.continue();
    expect(finished.snapshot.state).toBe("terminated");
    expect(finished.output).toContain("answer=42");
    await session.launch({ profile: adapter.id, program: file, cwd: dirname(file) });
    await session.stop();
    expect(session.status().snapshot.state).toBe("terminated");
  } catch (error) {
    for (const name of await readdir(files.directoryPath)) {
      console.error((await readFile(join(files.directoryPath, name), "utf8")).slice(-16_000));
    }
    throw error;
  } finally {
    await session.stop();
    await files.close();
  }
}

describe.runIf(process.env.PI_TOOL_INSTALLER_NATIVE === "1")("native managed catalog", () => {
  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "pi catalog 空間 ")));
    installer = new ToolInstaller(join(directory, "managed store"));
    // js-debug's Unix socket must fit macOS's 104-byte path limit.
    temporaryDirectory =
      process.platform === "darwin" ? await mkdtemp("/tmp/pi-ipc-") : join(directory, "tmp");
    await Promise.all([
      mkdir(join(directory, "child-home")),
      mkdir(temporaryDirectory, { recursive: true }),
    ]);
    console.info(`Native catalog: ${process.platform}/${process.arch}; ${directory}`);
  });

  afterAll(async () => {
    if (!directory) return;
    // Go's POSIX module cache has read-only directories; do not follow tool symlinks.
    if (process.platform !== "win32") {
      for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
        if (entry.isDirectory()) await chmod(join(entry.parentPath, entry.name), 0o700);
      }
    }
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      process.platform === "darwin" && rm(temporaryDirectory, { recursive: true, force: true }),
    ]);
  }, 180_000);

  test("TypeScript 7 native language server answers TypeScript and JavaScript document requests", async () => {
    const installation = await acquire("typescript", {
      node: "core:node",
      compiler: "npm:typescript",
    });
    const compiler = join(component(installation, "compiler"), "node_modules/typescript");
    const result = await execute(
      nodeExecutable(installation),
      [join(compiler, "bin/tsc"), "--version"],
      { env: environment(installation) },
    );
    expect(result.stdout.trim()).toBe(
      `Version ${installation.components.compiler?.version ?? "missing"}`,
    );
    for (const [extension, language] of [
      ["ts", "typescript"],
      ["js", "javascript"],
    ] as const) {
      const file = join(await workspace(installation.id), `program.${extension}`);
      await writeFile(file, `export const answer${extension === "ts" ? ": number" : ""} = 42;\n`);
      await symbols(
        installation,
        nodeExecutable(installation),
        [join(compiler, "bin/tsc"), "--lsp", "--stdio"],
        file,
        language,
      );
    }
  }, 360_000);

  test("Pyright initializes and answers a Python document request", async () => {
    const installation = await acquire("pyright", { node: "core:node", server: "npm:pyright" });
    const file = join(await workspace(installation.id), "program.py");
    await writeFile(file, "def answer() -> int:\n    return 42\n");
    await symbols(
      installation,
      nodeExecutable(installation),
      [
        join(component(installation, "server"), "node_modules/pyright/langserver.index.js"),
        "--stdio",
      ],
      file,
      "python",
    );
  }, 360_000);

  test("Prettier formats a JavaScript file with its private Node runtime", async () => {
    const installation = await acquire("prettier", {
      node: "core:node",
      formatter: "npm:prettier",
    });
    const file = join(await workspace(installation.id), "program.js");
    await writeFile(file, "const answer={value:42}\n");
    await execute(
      nodeExecutable(installation),
      [
        join(component(installation, "formatter"), "node_modules/prettier/bin/prettier.cjs"),
        "--write",
        file,
      ],
      { env: environment(installation) },
    );
    expect(await readFile(file, "utf8")).toBe("const answer = { value: 42 };\n");
  }, 360_000);

  test("Biome formats a JavaScript file through its platform package", async () => {
    const installation = await acquire("biome", {
      node: "core:node",
      formatter: "npm:@biomejs/biome",
    });
    const file = join(await workspace(installation.id), "program.js");
    await writeFile(file, "const answer={value:42}\n");
    await execute(
      nodeExecutable(installation),
      [
        join(component(installation, "formatter"), "node_modules/@biomejs/biome/bin/biome"),
        "format",
        "--write",
        file,
      ],
      { env: environment(installation) },
    );
    expect(await readFile(file, "utf8")).toBe("const answer = { value: 42 };\n");
  }, 360_000);

  test("Black formats a Python file with its private Python environment", async () => {
    const installation = await acquire("black", {
      python: "core:python",
      uv: "aqua:astral-sh/uv",
      formatter: "pipx:black",
    });
    const file = join(await workspace(installation.id), "program.py");
    await writeFile(file, "answer= 42\n");
    const python = join(
      component(installation, "formatter"),
      process.platform === "win32" ? "black/Scripts/python.exe" : "black/bin/python",
    );
    const runtime = await execute(python, ["-c", "import sys; print(sys.version.split()[0])"], {
      env: environment(installation),
    });
    expect(runtime.stdout.trim()).toBe(installation.components.python?.version);
    await execute(python, ["-m", "black", file], { env: environment(installation) });
    expect(await readFile(file, "utf8")).toBe("answer = 42\n");
  }, 360_000);

  test("Ruff formats a Python file with its native release binary", async () => {
    const installation = await acquire("ruff", { formatter: "aqua:astral-sh/ruff" });
    const file = join(await workspace(installation.id), "program.py");
    await writeFile(file, "answer= 42\n");
    const command = installation.binDirectories
      .map((path) => join(path, nativeExecutable("ruff")))
      .find((path) => existsSync(path));
    if (!command) throw new Error("No Ruff executable in the managed executable directories");
    await execute(command, ["format", file], { env: environment(installation) });
    expect(await readFile(file, "utf8")).toBe("answer = 42\n");
  }, 360_000);

  test("gofmt formats Go and gopls initializes and answers a document request", async () => {
    const installation = await acquire("go", {
      go: "core:go",
      server: "go:golang.org/x/tools/gopls",
    });
    const runtime = await execute(
      join(component(installation, "go"), "bin", nativeExecutable("go")),
      ["version"],
      { env: environment(installation) },
    );
    expect(runtime.stdout.trim()).toBe(
      `go version go${installation.components.go?.version} ${process.platform === "win32" ? "windows" : process.platform}/${process.arch === "x64" ? "amd64" : process.arch}`,
    );
    const root = await workspace(installation.id);
    const file = join(root, "program.go");
    await writeFile(join(root, "go.mod"), "module example.com/probe\n\ngo 1.20\n");
    await writeFile(file, "package probe\nfunc answer() int{return 42}\n");
    await execute(
      join(component(installation, "go"), "bin", nativeExecutable("gofmt")),
      ["-w", file],
      { env: environment(installation) },
    );
    expect(await readFile(file, "utf8")).toBe("package probe\n\nfunc answer() int { return 42 }\n");
    await symbols(
      installation,
      join(component(installation, "server"), "bin", nativeExecutable("gopls")),
      ["-rpc.trace"],
      file,
      "go",
    );
  }, 360_000);

  test("rustfmt formats Rust and rust-analyzer initializes and answers a document request", async () => {
    const installation = await acquire("rust", {
      rust: "core:rust",
      server: "aqua:rust-lang/rust-analyzer",
    });
    const root = await workspace(installation.id);
    const file = join(root, "lib.rs");
    await writeFile(
      join(root, "Cargo.toml"),
      '[package]\nname = "native_probe"\nversion = "0.1.0"\nedition = "2024"\n[lib]\npath = "lib.rs"\n',
    );
    const sibling = join(root, "sibling.rs");
    const siblingSource = "pub fn value( )->i32{1}\n";
    await writeFile(sibling, siblingSource);
    await writeFile(file, "mod sibling;\npub async fn answer()->i32{42}\n");
    await execute(
      join(component(installation, "rust"), nativeExecutable("rustfmt")),
      ["--edition", "2024", "--config", "skip_children=true", file],
      { env: environment(installation) },
    );
    expect(await readFile(file, "utf8")).toBe(
      "mod sibling;\npub async fn answer() -> i32 {\n    42\n}\n",
    );
    expect(await readFile(sibling, "utf8")).toBe(siblingSource);
    await symbols(
      installation,
      join(component(installation, "server"), nativeExecutable("rust-analyzer")),
      [],
      file,
      "rust",
    );
  }, 360_000);

  test("js-debug standalone launches direct JavaScript and supports breakpoint, stack, continue and stop", async () => {
    const installation = await acquire("js-debug", {
      node: "core:node",
      adapter: "github:microsoft/vscode-js-debug[asset_pattern=js-debug-dap-v*.tar.gz]",
    });
    const file = join(await workspace(installation.id), "program.js");
    await writeFile(
      file,
      "const base = 41;\nconst answer = base + 1;\nconsole.log(`answer=${answer}`);\n",
    );
    const script = join(component(installation, "adapter"), "src/dapDebugServer.js");
    await access(script);
    const node = nodeExecutable(installation);
    await debugScript(
      {
        id: installation.id,
        command: node,
        args: [script, "$PORT", "127.0.0.1"],
        environment: environment(installation),
        transport: { type: "tcp", host: "127.0.0.1", port: 0 },
      },
      {
        type: "pwa-node",
        request: "launch",
        name: "Native Node probe",
        runtimeExecutable: node,
        console: "internalConsole",
        stopOnEntry: true,
      },
      file,
    );
  }, 360_000);

  test("debugpy launches a separate Python runtime and supports breakpoint, stack, continue and stop", async () => {
    const installation = await acquire("debugpy", {
      python: "core:python",
      uv: "aqua:astral-sh/uv",
      adapter: "pipx:debugpy",
    });
    const file = join(await workspace(installation.id), "program.py");
    await writeFile(file, 'base = 41\nanswer = base + 1\nprint(f"answer={answer}")\n');
    const adapterPython = join(
      component(installation, "adapter"),
      process.platform === "win32" ? "debugpy/Scripts/python.exe" : "debugpy/bin/python",
    );
    const python = join(
      component(installation, "python"),
      process.platform === "win32" ? "python.exe" : "bin/python",
    );
    const runtime = await execute(
      adapterPython,
      ["-c", "import sys; print(sys.version.split()[0])"],
      { env: environment(installation) },
    );
    expect(runtime.stdout.trim()).toBe(installation.components.python?.version);
    await debugScript(
      {
        id: installation.id,
        command: adapterPython,
        args: ["-m", "debugpy.adapter"],
        environment: environment(installation),
        transport: { type: "stdio" },
      },
      {
        type: "python",
        request: "launch",
        name: "Native Python probe",
        python: [python],
        console: "internalConsole",
        stopOnEntry: true,
        justMyCode: false,
      },
      file,
    );
  }, 360_000);
});
