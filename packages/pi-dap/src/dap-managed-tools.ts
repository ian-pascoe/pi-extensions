import { constants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { resolveDenoExecutable } from "@ian-pascoe/pi-utils";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import type {
  InstallationOptions,
  ToolInstaller,
  ToolRequest,
  ManagedInstallation,
} from "@ian-pascoe/pi-tool-installer";
import type { DapLaunchInput } from "./dap-session.js";
import { allocateTcpPort } from "./dap-protocol-client.js";
import { resolveDotnetRuntime } from "./dap-dotnet-runtime.js";
import { probeDapRuntime } from "./dap-runtime-probe.js";
import type {
  DapAdapterDefinition,
  DapLaunchProfile,
  ResolvedDapSettings,
} from "./pi-dap-settings.js";

export const DAP_MANAGED_REQUESTS = new Map<string, ToolRequest>([
  [
    "javascript",
    {
      id: "dap-javascript",
      requirements: {
        node: "core:node",
        adapter: "github:microsoft/vscode-js-debug[asset_pattern=js-debug-dap-v*.tar.gz]",
      },
    },
  ],
  [
    "deno",
    {
      id: "dap-deno",
      requirements: {
        node: "core:node",
        adapter: "github:microsoft/vscode-js-debug[asset_pattern=js-debug-dap-v*.tar.gz]",
        deno: "core:deno",
      },
    },
  ],
  ["go", { id: "dap-go", requirements: { adapter: "github:go-delve/delve" } }],
  [
    "codelldb",
    {
      id: "dap-codelldb",
      requirements: {
        adapter: `github:vadimcn/codelldb[asset_pattern=codelldb-${process.platform}-${process.arch}.vsix,bin_path=extension/adapter]`,
      },
    },
  ],
  ["dotnet", { id: "dap-dotnet", requirements: { adapter: "github:Samsung/netcoredbg" } }],
  [
    "python",
    {
      id: "dap-python",
      requirements: { python: "core:python", uv: "aqua:astral-sh/uv", adapter: "pipx:debugpy" },
    },
  ],
]);

async function firstFile(
  paths: readonly string[],
  executable = false,
): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await access(path, executable ? constants.X_OK : constants.R_OK);
      if ((await stat(path)).isFile()) return path;
    } catch {
      // Missing External Installations are fallbacks, not failed Explicit Definitions.
    }
  }
  return undefined;
}

async function denoRuntime(directories: readonly string[]): Promise<string | undefined> {
  for (const directory of directories) {
    for (const name of process.platform === "win32" ? ["deno.exe", "deno.cmd"] : ["deno"]) {
      const executable = await resolveDenoExecutable(join(directory, name));
      if (executable) return executable;
    }
  }
  return undefined;
}

function roots(cwd: string): string[] {
  const result: string[] = [];
  for (let root = cwd; ; root = dirname(root)) {
    result.push(root);
    if (root === dirname(root)) return result;
  }
}

function component(installation: ManagedInstallation, name: string, file: string): string {
  const directory = installation.components[name]?.directory;
  if (!directory) throw new Error(`Incomplete Managed Installation ${installation.id}: ${name}`);
  return join(directory, file);
}

/** Resolve built-in direct-script launches only when explicit configuration has not taken ownership. */
export async function resolveDapPreset(
  input: DapLaunchInput,
  cwd: string,
  settings: ResolvedDapSettings,
  installer: ToolInstaller,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<{ adapter: DapAdapterDefinition; profile: DapLaunchProfile } | undefined> {
  if (input.profile !== undefined && settings.configuredProfileIds?.has(input.profile))
    return undefined;
  if (
    input.profile === undefined &&
    (settings.configuredProfileIds?.size ?? settings.profiles.size) > 0
  )
    return undefined;
  const root = resolve(cwd, input.cwd ?? cwd);
  const projectRoots = roots(
    input.cwd === undefined ? dirname(resolve(cwd, input.program ?? ".")) : root,
  );
  const extension = extname(input.program ?? "");
  const denoScript = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"].includes(
    extension,
  );
  const denoProject =
    denoScript &&
    (await firstFile(
      projectRoots.flatMap((path) => [join(path, "deno.json"), join(path, "deno.jsonc")]),
    ));
  const inferred = denoProject
    ? "deno"
    : [".js", ".mjs", ".cjs"].includes(extension)
      ? "javascript"
      : extension === ".py"
        ? "python"
        : undefined;
  const id = input.profile ?? inferred;
  const request = id === undefined ? undefined : DAP_MANAGED_REQUESTS.get(id);
  if (id === undefined || request === undefined || settings.configuredAdapterIds?.has(id))
    return undefined;
  const compiled = id === "go" || id === "codelldb" || id === "dotnet";
  const scriptMatches =
    id === "deno"
      ? denoScript
      : id === "javascript"
        ? [".js", ".mjs", ".cjs"].includes(extension)
        : extension === ".py";
  if (!input.program || (!compiled && !scriptMatches))
    throw new Error(
      `Built-in ${id} requires ${compiled ? "an explicit compiled program" : "a direct compatible script"}; configure a Launch Profile for loaders, frameworks, tests, or builds`,
    );
  signal?.throwIfAborted();
  const pathDirectories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const installationOptions: InstallationOptions = {};
  if (signal !== undefined) installationOptions.signal = signal;
  if (onProgress !== undefined) installationOptions.onProgress = onProgress;
  const acquire = () =>
    installer.ensure(request, {
      ...installationOptions,
      allowDownload: settings.autoInstall !== false,
    });
  const windows = process.platform === "win32";
  if (id === "dotnet") {
    const program = resolve(cwd, input.program);
    let command = await firstFile(
      [
        ...projectRoots.flatMap((path) => [
          join(path, ".dotnet/tools", windows ? "netcoredbg.exe" : "netcoredbg"),
          join(path, "bin", windows ? "netcoredbg.exe" : "netcoredbg"),
        ]),
        ...pathDirectories.map((path) => join(path, windows ? "netcoredbg.exe" : "netcoredbg")),
      ],
      true,
    );
    if (
      !command &&
      ((windows && process.arch === "arm64") ||
        (process.platform === "darwin" && process.arch === "x64"))
    )
      throw new Error(
        `Managed NetCoreDbg is unavailable on ${process.platform}/${process.arch}; configure an explicit compatible Adapter Definition.`,
      );
    const runtime = await resolveDotnetRuntime(
      program,
      projectRoots,
      installer,
      settings.autoInstall !== false,
      installationOptions,
    );
    let environment = runtime.environment;
    if (!command) {
      const installation = await acquire();
      command = component(installation, "adapter", windows ? "netcoredbg.exe" : "netcoredbg");
      environment = { ...installation.environment, ...runtime.environment };
    }
    // NetCoreDbg ignores launch.program/args when a startup command is supplied.
    const startup = runtime.host ? [runtime.host, program] : [program];
    return {
      adapter: {
        id,
        command,
        args: ["--interpreter=vscode", "--", ...startup, ...(input.args ?? [])],
        environment,
        transport: { type: "stdio" },
      },
      profile: {
        id,
        adapterId: id,
        arguments: {
          type: "coreclr",
          request: "launch",
          name: "Compiled .NET application",
          stopAtEntry: true,
          cwd: root,
          env: environment,
        },
      },
    };
  }
  if (compiled) {
    const name = id === "go" ? "dlv" : "codelldb";
    let command = await firstFile(
      [
        ...projectRoots.flatMap((path) => [
          join(path, "node_modules/.bin", name + (windows ? ".exe" : "")),
          join(path, "bin", name + (windows ? ".exe" : "")),
        ]),
        ...pathDirectories.map((path) => join(path, name + (windows ? ".exe" : ""))),
      ],
      true,
    );
    let environment: ManagedInstallation["environment"] = {};
    if (id === "go" && process.platform === "darwin") {
      const helper = await firstFile(
        [
          ...(process.env.DELVE_DEBUGSERVER_PATH ? [process.env.DELVE_DEBUGSERVER_PATH] : []),
          ...pathDirectories.map((path) => join(path, "debugserver")),
          "/Library/Developer/CommandLineTools/Library/PrivateFrameworks/LLDB.framework/Resources/debugserver",
          "/Applications/Xcode.app/Contents/SharedFrameworks/LLDB.framework/Resources/debugserver",
        ],
        true,
      );
      if (!helper)
        throw new Error(
          "Delve requires a usable debugserver on macOS; no verified private helper is available. Configure an explicit adapter rather than changing system developer tools.",
        );
      environment.DELVE_DEBUGSERVER_PATH = helper;
    }
    if (!command) {
      if (windows && process.arch === "arm64")
        throw new Error(
          `Managed ${id} is unavailable on Windows ARM64; configure an explicit compatible Adapter Definition.`,
        );
      const installation = await acquire();
      command = component(
        installation,
        "adapter",
        id === "go"
          ? `dlv${windows ? ".exe" : ""}`
          : `extension/adapter/codelldb${windows ? ".exe" : ""}`,
      );
      environment = { ...installation.environment, ...environment };
    }
    const launchArguments: DapLaunchProfile["arguments"] = {
      type: id === "go" ? "go" : "lldb",
      request: "launch",
      name: "Compiled program",
      stopOnEntry: true,
      cwd: root,
    };
    if (id === "go") Object.assign(launchArguments, { mode: "exec", outputMode: "remote" });
    return {
      adapter: {
        id,
        command,
        args:
          id === "go"
            ? ["dap", "--listen=127.0.0.1:$PORT"]
            : ["--settings", '{"consoleMode":"evaluate"}'],
        environment,
        transport: id === "go" ? { type: "tcp", host: "127.0.0.1", port: 0 } : { type: "stdio" },
      },
      profile: {
        id,
        adapterId: id,
        arguments: launchArguments,
      },
    };
  }
  if (id === "python") {
    const pythonPaths = [
      ...projectRoots.flatMap((path) => [
        join(path, windows ? ".venv/Scripts/python.exe" : ".venv/bin/python"),
        join(path, windows ? "venv/Scripts/python.exe" : "venv/bin/python"),
      ]),
      ...pathDirectories.flatMap((path) =>
        windows
          ? [join(path, "python.exe"), join(path, "python3.exe")]
          : [join(path, "python3"), join(path, "python")],
      ),
    ];
    let python = await firstFile(pythonPaths, true);
    let adapterPython: string | undefined;
    for (const candidate of pythonPaths) {
      if (!(await firstFile([candidate], true))) continue;
      signal?.throwIfAborted();
      try {
        await probeDapRuntime(candidate, ["-c", "import debugpy.adapter"], {
          cwd: root,
          signal,
        });
        adapterPython = candidate;
        break;
      } catch {
        signal?.throwIfAborted();
      }
    }
    let environment: ManagedInstallation["environment"] = {};
    if (!adapterPython || !python) {
      const installation = await acquire();
      signal?.throwIfAborted();
      adapterPython ??= component(
        installation,
        "adapter",
        windows ? "debugpy/Scripts/python.exe" : "debugpy/bin/python",
      );
      python ??= component(installation, "python", windows ? "python.exe" : "bin/python");
      environment = installation.environment;
    }
    return {
      adapter: {
        id,
        command: adapterPython,
        args: ["-m", "debugpy.adapter"],
        environment,
        transport: { type: "stdio" },
      },
      profile: {
        id,
        adapterId: id,
        arguments: {
          type: "python",
          request: "launch",
          name: "Direct Python script",
          python: [python],
          console: "internalConsole",
          stopOnEntry: true,
          justMyCode: false,
          cwd: root,
        },
      },
    };
  }
  const nativeNode = windows ? "node.exe" : "node";
  let node = await firstFile(
    [
      ...projectRoots.flatMap((path) => [
        join(path, "node_modules/.bin", nativeNode),
        join(path, "node_modules/node/bin", nativeNode),
      ]),
      ...pathDirectories.map((path) => join(path, nativeNode)),
    ],
    true,
  );
  let script = await firstFile([
    ...projectRoots.flatMap((path) => [
      join(path, "node_modules/@vscode/js-debug/src/dapDebugServer.js"),
      join(path, "node_modules/vscode-js-debug/src/dapDebugServer.js"),
    ]),
    ...pathDirectories.map((path) => join(path, "dapDebugServer.js")),
  ]);
  let deno =
    id === "deno"
      ? await denoRuntime([
          ...projectRoots.map((path) => join(path, "node_modules/.bin")),
          ...pathDirectories,
        ])
      : undefined;
  let environment: ManagedInstallation["environment"] = {};
  if (!node || !script || (id === "deno" && !deno)) {
    const installation = await acquire();
    signal?.throwIfAborted();
    node ??= component(installation, "node", windows ? "node.exe" : "bin/node");
    script ??= component(installation, "adapter", "src/dapDebugServer.js");
    if (id === "deno")
      deno ??= component(installation, "deno", windows ? "bin/deno.exe" : "bin/deno");
    environment = installation.environment;
  }
  if (id === "deno") {
    const cache = join(installer.directory, "runtime-cache", "deno");
    await mkdir(cache, { recursive: true, mode: 0o700 });
    environment = {
      ...environment,
      DENO_DIR: cache,
      DENO_NO_PROMPT: "1",
      DENO_NO_UPDATE_CHECK: "1",
    };
  }
  const javascriptArguments: DapLaunchProfile["arguments"] = {
    type: "pwa-node",
    request: "launch",
    name: "Direct Node script",
    runtimeExecutable: node,
    console: "internalConsole",
    stopOnEntry: true,
    cwd: root,
  };
  if (id === "deno") {
    const port = await allocateTcpPort("127.0.0.1");
    signal?.throwIfAborted();
    Object.assign(javascriptArguments, {
      name: "Direct Deno script",
      runtimeExecutable: deno,
      attachSimplePort: port,
      // VS Code normally expands attachSimplePort=0; standalone DAP does not.
      runtimeArgs: [
        "run",
        `--inspect-brk=127.0.0.1:${port}`,
        "--cached-only",
        "--frozen-lockfile",
        "--node-modules-dir=manual",
        "--vendor=false",
        "--no-prompt",
      ],
      env: environment,
      continueOnAttach: false,
      stopOnEntry: false,
    });
  }
  return {
    adapter: {
      id,
      command: node,
      args: [script, "$PORT", "127.0.0.1"],
      environment,
      transport: { type: "tcp", host: "127.0.0.1", port: 0 },
    },
    profile: {
      id,
      adapterId: id,
      arguments: javascriptArguments,
    },
  };
}
