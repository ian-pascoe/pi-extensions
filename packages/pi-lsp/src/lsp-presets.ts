import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import spawn from "cross-spawn";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  ToolInstaller,
  type InstallationOptions,
  type ManagedInstallation,
  type ToolRequest,
} from "@ian-pascoe/pi-tool-installer";
import type { LspServerDefinition, ResolvedLspSettings } from "./pi-lsp-settings.js";

/** Package-owned language behavior, independent of acquisition metadata. */
export const LSP_PRESETS = [
  {
    id: "typescript",
    command: "tsc",
    args: ["--lsp", "--stdio"],
    languages: [
      { extensions: [".ts", ".mts", ".cts"], fileNames: [], languageId: "typescript" },
      { extensions: [".tsx"], fileNames: [], languageId: "typescriptreact" },
      { extensions: [".js", ".mjs", ".cjs"], fileNames: [], languageId: "javascript" },
      { extensions: [".jsx"], fileNames: [], languageId: "javascriptreact" },
    ],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
    requirements: { node: "core:node", compiler: "npm:typescript" },
  },
  {
    id: "pyright",
    command: "pyright-langserver",
    args: ["--stdio"],
    languages: [{ extensions: [".py", ".pyi"], fileNames: [], languageId: "python" }],
    rootMarkers: ["pyrightconfig.json", "pyproject.toml", "setup.py", ".git"],
    requirements: { node: "core:node", server: "npm:pyright" },
  },
  {
    id: "gopls",
    command: "gopls",
    args: [],
    languages: [
      { extensions: [".go"], fileNames: [], languageId: "go" },
      { extensions: [], fileNames: ["go.mod"], languageId: "gomod" },
      { extensions: [], fileNames: ["go.work"], languageId: "gowork" },
    ],
    rootMarkers: ["go.work", "go.mod", ".git"],
    requirements: { go: "core:go", server: "go:golang.org/x/tools/gopls" },
  },
  {
    id: "rust-analyzer",
    command: "rust-analyzer",
    args: [],
    languages: [{ extensions: [".rs"], fileNames: [], languageId: "rust" }],
    rootMarkers: ["Cargo.toml", ".git"],
    requirements: { rust: "core:rust", server: "aqua:rust-lang/rust-analyzer" },
  },
] satisfies readonly (Pick<
  LspServerDefinition,
  "id" | "command" | "args" | "languages" | "rootMarkers"
> & { requirements: Record<string, string> })[];

/** Add fallback definitions only after explicit settings have been parsed and quarantined. */
export function withLspPresets(settings: ResolvedLspSettings): ResolvedLspSettings {
  const servers = new Map(settings.servers);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const preset of LSP_PRESETS) {
    if (servers.has(preset.id) || settings.excludedServerIds?.has(preset.id)) continue;
    servers.set(preset.id, { ...preset, environment, preset: true, requireRootMarker: false });
  }
  return { ...settings, servers: new Map([...servers].sort(([a], [b]) => a.localeCompare(b))) };
}

function ancestors(root: string): string[] {
  const result: string[] = [];
  for (let path = resolve(root); ; path = dirname(path)) {
    result.push(path);
    if (dirname(path) === path) return result;
  }
}

async function usable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return (await stat(path)).isFile();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
    )
      return false;
    throw error;
  }
}

function executableNames(name: string): string[] {
  return process.platform === "win32"
    ? [`${name}.exe`, `${name}.com`, `${name}.cmd`, `${name}.bat`, name]
    : [name];
}

async function findExecutable(
  name: string,
  directories: readonly string[],
  accepts?: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  for (const directory of directories) {
    for (const file of executableNames(name)) {
      const path = resolve(directory, file);
      if ((await usable(path)) && (accepts === undefined || (await accepts(path)))) return path;
    }
  }
  return undefined;
}

function component(installation: ManagedInstallation, name: string): string {
  const selected = installation.components[name];
  if (!selected) throw new Error(`Pi LSP: missing managed ${name}`);
  return selected.directory;
}

const TypeScriptPackageSchema = Type.Object({
  name: Type.Literal("typescript"),
  version: Type.String(),
});

async function isNativeTypeScript(
  path: string,
  environment: Readonly<Record<string, string>>,
  options: InstallationOptions,
): Promise<boolean> {
  const manifests = [
    join(dirname(path), "..", "typescript", "package.json"),
    join(dirname(path), "node_modules", "typescript", "package.json"),
    ...ancestors(dirname(await realpath(path))).map((directory) => join(directory, "package.json")),
  ];
  for (const manifest of manifests) {
    try {
      const value: unknown = JSON.parse(await readFile(manifest, "utf8"));
      if (Value.Check(TypeScriptPackageSchema, value))
        return /^(?:[7-9]|\d{2,})\./u.test(value.version);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTDIR"].includes(String(error.code))
        )
      )
        throw error;
    }
  }
  // cross-spawn handles npm .cmd shims on Windows, unlike Pi's generic exec helper.
  const result = await new Promise<boolean>((done) => {
    const child = spawn(path, ["--version"], {
      env: environment,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (text: string) => {
      output = (output + text).slice(-4096);
    });
    const cancel = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        spawn(
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        ).once("error", () => child.kill());
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
            child.kill("SIGKILL");
        }
      }
    };
    const timeout = setTimeout(cancel, 5000);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.once("error", () => done(false));
    child.once("close", (code) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", cancel);
      done(code === 0 && /^Version\s+(?:[7-9]|\d{2,})\./u.test(output.trim()));
    });
  });
  options.signal?.throwIfAborted();
  return result;
}

/** Resolve each server and prerequisite independently without changing the user's environment. */
export async function resolveLspPreset(
  definition: LspServerDefinition,
  root: string,
  installer: ToolInstaller,
  allowDownload: boolean,
  options: InstallationOptions,
): Promise<LspServerDefinition> {
  if (!definition.preset) return definition;
  const preset = LSP_PRESETS.find(({ id }) => id === definition.id);
  if (!preset) throw new Error(`Pi LSP: unknown preset ${definition.id}`);
  options.signal?.throwIfAborted();
  const projectPaths = [
    ...ancestors(root).map((path) => join(path, "node_modules", ".bin")),
    join(root, ".venv", "bin"),
    join(root, ".venv", "Scripts"),
    join(root, ".cargo", "bin"),
    join(root, ".go", "bin"),
    join(root, "bin"),
    join(root, ".bin"),
  ];
  const pathKey =
    Object.keys(definition.environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const paths = [
    ...projectPaths,
    ...(definition.environment[pathKey] ?? "").split(delimiter).filter(Boolean),
  ];
  const nativeTypeScript = (path: string) =>
    isNativeTypeScript(
      path,
      { ...definition.environment, [pathKey]: paths.join(delimiter) },
      options,
    );
  const externalServer = await findExecutable(
    preset.command,
    paths,
    preset.id === "typescript" ? nativeTypeScript : undefined,
  );
  const runtimeName =
    preset.id === "gopls" ? "go" : preset.id === "rust-analyzer" ? "rustc" : "node";
  const runtimeKey = runtimeName === "rustc" ? "rust" : runtimeName;
  const externalRuntime = await findExecutable(runtimeName, paths);
  const externalCargo =
    preset.id === "rust-analyzer" ? await findExecutable("cargo", paths) : undefined;
  const requirements: Record<string, string> = {};
  if (!externalRuntime || (preset.id === "rust-analyzer" && !externalCargo))
    requirements[runtimeKey] = preset.requirements[runtimeKey] ?? "";
  const serverKey = preset.id === "typescript" ? "compiler" : "server";
  if (!externalServer) {
    if (preset.id === "gopls") requirements.go = "core:go"; // gopls acquisition runs go install in the installer's isolated environment.
    requirements[serverKey] = preset.requirements[serverKey] ?? "";
  }
  let installation: ManagedInstallation | undefined;
  if (Object.keys(requirements).length > 0) {
    // Keep previously acquired components selected when only another prerequisite is missing.
    const previous = await installer.installed(`lsp-${preset.id}`);
    const retained = Object.fromEntries(
      Object.entries(previous?.components ?? {}).map(([key, value]) => [key, value.selector]),
    );
    installation = await installer.ensure(
      {
        id: `lsp-${preset.id}`,
        requirements: Object.fromEntries(
          Object.entries(preset.requirements).filter(
            ([key]) => requirements[key] !== undefined || retained[key] !== undefined,
          ),
        ),
      },
      { ...options, allowDownload },
    );
  }
  options.signal?.throwIfAborted();
  const managedEnvironment = { ...installation?.environment };
  if (externalRuntime) {
    delete managedEnvironment.GOROOT;
    if (externalCargo) {
      delete managedEnvironment.CARGO_HOME;
      delete managedEnvironment.RUSTUP_HOME;
      delete managedEnvironment.RUSTUP_TOOLCHAIN;
    }
  }
  const environment = { ...definition.environment, ...managedEnvironment };
  const runtimePaths = [externalRuntime, externalCargo].flatMap((path) =>
    path ? [dirname(path)] : [],
  );
  environment[pathKey] = [
    ...runtimePaths,
    ...projectPaths,
    ...paths.slice(projectPaths.length),
    ...(installation?.binDirectories ?? []),
  ].join(delimiter);
  let command = externalServer;
  let args = [...preset.args];
  if (!command && installation) {
    if (preset.id === "typescript" || preset.id === "pyright") {
      command =
        externalRuntime ??
        join(
          component(installation, "node"),
          process.platform === "win32" ? "node.exe" : "bin/node",
        );
      const script =
        preset.id === "typescript"
          ? "node_modules/typescript/bin/tsc"
          : "node_modules/pyright/langserver.index.js";
      args = [join(component(installation, serverKey), script), ...args];
    } else {
      command = await findExecutable(preset.command, installation.binDirectories);
    }
  }
  if (!command)
    throw new Error(
      `Pi LSP: ${preset.id} executable unavailable; configure lsp.servers.${preset.id} or enable lsp.autoInstall, then use lsp restart.`,
    );
  return { ...definition, command, args, environment };
}

/** Update only the components actually acquired for this preset, never an unused catalog entry. */
export function installedLspRequest(id: string, installation: ManagedInstallation): ToolRequest {
  return {
    id: `lsp-${id}`,
    requirements: Object.fromEntries(
      Object.entries(installation.components).map(([key, value]) => [key, value.selector]),
    ),
  };
}
