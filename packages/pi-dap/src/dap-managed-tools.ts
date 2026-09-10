import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  InstallationOptions,
  ToolInstaller,
  ToolRequest,
  ManagedInstallation,
} from "@ian-pascoe/pi-tool-installer";
import type { DapLaunchInput } from "./dap-session.js";
import type {
  DapAdapterDefinition,
  DapLaunchProfile,
  ResolvedDapSettings,
} from "./pi-dap-settings.js";

const executeFile = promisify(execFile);

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
  const extension = extname(input.program ?? "");
  const inferred = [".js", ".mjs", ".cjs"].includes(extension)
    ? "javascript"
    : extension === ".py"
      ? "python"
      : undefined;
  const id = input.profile ?? inferred;
  const request = id === undefined ? undefined : DAP_MANAGED_REQUESTS.get(id);
  if (id === undefined || request === undefined || settings.configuredAdapterIds?.has(id))
    return undefined;
  if (!input.program || inferred !== id)
    throw new Error(
      `Built-in ${id} requires a direct script (${id === "python" ? ".py" : ".js, .mjs, .cjs"}); configure a Launch Profile for loaders, frameworks, tests, or builds`,
    );
  signal?.throwIfAborted();
  const root = resolve(cwd, input.cwd ?? cwd);
  const projectRoots = roots(input.cwd === undefined ? dirname(resolve(cwd, input.program)) : root);
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
        await executeFile(candidate, ["-c", "import debugpy.adapter"], {
          cwd: root,
          timeout: 5_000,
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
  let environment: ManagedInstallation["environment"] = {};
  if (!node || !script) {
    const installation = await acquire();
    signal?.throwIfAborted();
    node ??= component(installation, "node", windows ? "node.exe" : "bin/node");
    script ??= component(installation, "adapter", "src/dapDebugServer.js");
    environment = installation.environment;
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
      arguments: {
        type: "pwa-node",
        request: "launch",
        name: "Direct Node script",
        runtimeExecutable: node,
        console: "internalConsole",
        stopOnEntry: true,
        cwd: root,
      },
    },
  };
}
