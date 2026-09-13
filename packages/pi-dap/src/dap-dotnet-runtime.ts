import { access, mkdir, readFile } from "node:fs/promises";
import { delimiter, dirname, extname, join } from "node:path";
import type {
  InstallationOptions,
  ToolInstaller,
  ToolRequest,
} from "@ian-pascoe/pi-tool-installer";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { probeDapRuntime } from "./dap-runtime-probe.js";

const Version = Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$" });
const Framework = Type.Object(
  { name: Type.String(), version: Version },
  { additionalProperties: false },
);
const Dependencies = Type.Object({ runtimeTarget: Type.Object({ name: Type.String() }) });
const RuntimeConfig = Type.Object({
  runtimeOptions: Type.Object({
    framework: Type.Optional(Framework),
    frameworks: Type.Optional(Type.Array(Framework)),
    includedFrameworks: Type.Optional(Type.Array(Framework)),
    rollForward: Type.Optional(Type.String()),
    applyPatches: Type.Optional(Type.Boolean()),
    additionalProbingPaths: Type.Optional(Type.Any()),
    rollForwardOnNoCandidateFx: Type.Optional(Type.Any()),
  }),
});
const Releases = Type.Object({
  releases: Type.Array(
    Type.Object({ runtime: Type.Optional(Type.Object({ version: Type.String() })) }),
  ),
});
const Policy = Type.Union([
  Type.Literal("Minor"),
  Type.Literal("LatestPatch"),
  Type.Literal("Disable"),
]);
type RuntimePolicy = Static<typeof Policy>;
const unsupported = () =>
  new Error(
    "The compiled application's .NET runtime requirements are ambiguous or unsupported; configure an explicit Adapter Definition and Launch Profile. Pi does not build projects or override runtime roll-forward.",
  );

function compatible(version: string, floor: string, policy: RuntimePolicy): boolean {
  const [major, minor, patch] = version.split(".").map(Number);
  const [wantedMajor, wantedMinor, wantedPatch] = floor.split(".").map(Number);
  if (policy === "Disable") return version === floor;
  return (
    major === wantedMajor &&
    ((policy === "Minor" && minor! > wantedMinor!) ||
      (minor === wantedMinor && patch! >= wantedPatch!))
  );
}

/** Keep compatible runtime selections distinct without adding project/session persistence. */
export function dotnetRuntimeId(version: string, policy: RuntimePolicy): string {
  return `dap-dotnet-runtime-${version.replaceAll(".", "-")}-${policy.toLowerCase()}`;
}

export async function dotnetRuntimeRequest(
  version: string,
  policy: RuntimePolicy,
  signal?: AbortSignal,
): Promise<ToolRequest> {
  let selected = version;
  if (policy !== "Disable") {
    const channel = version.split(".").slice(0, 2).join(".");
    const response = await fetch(
      `https://builds.dotnet.microsoft.com/dotnet/release-metadata/${channel}/releases.json`,
      { signal: signal ?? null },
    );
    if (!response.ok)
      throw new Error(`Cannot discover compatible .NET runtimes: HTTP ${response.status}`);
    const metadata: unknown = await response.json();
    if (!Value.Check(Releases, metadata)) throw new Error("Invalid .NET runtime release metadata");
    const versions = metadata.releases
      .flatMap((release) => release.runtime?.version ?? [])
      .filter(
        (candidate) =>
          Value.Check(Version, candidate) &&
          candidate.startsWith(`${channel}.`) &&
          compatible(candidate, version, policy),
      );
    versions.sort((a, b) => Number(b.split(".")[2]) - Number(a.split(".")[2]));
    if (!versions[0]) throw new Error(`No compatible published .NET runtime for ${version}`);
    selected = versions[0];
  }
  return {
    id: dotnetRuntimeId(version, policy),
    requirements: { runtime: `core:dotnet[runtime=dotnet]@${selected}` },
  };
}

export async function updateDotnetRuntimeRequest(
  id: string,
  signal?: AbortSignal,
): Promise<ToolRequest | undefined> {
  const match = /^dap-dotnet-runtime-(\d+)-(\d+)-(\d+)-(minor|latestpatch|disable)$/.exec(id);
  if (!match) return undefined;
  const policy =
    match[4] === "minor" ? "Minor" : match[4] === "latestpatch" ? "LatestPatch" : "Disable";
  return dotnetRuntimeRequest(`${match[1]}.${match[2]}.${match[3]}`, policy, signal);
}

/** Validate CLR architecture instead of mistaking an AnyCPU PE32 assembly for x86. */
function nativeAssembly(bytes: Buffer): boolean {
  try {
    if (bytes.readUInt16LE(0) !== 0x5a4d) return false;
    const pe = bytes.readUInt32LE(0x3c);
    if (bytes.readUInt32LE(pe) !== 0x4550) return false;
    const machine = bytes.readUInt16LE(pe + 4);
    const optional = pe + 24;
    const magic = bytes.readUInt16LE(optional);
    const directories = optional + (magic === 0x10b ? 96 : magic === 0x20b ? 112 : bytes.length);
    const clrRva = bytes.readUInt32LE(directories + 14 * 8);
    const sectionStart = optional + bytes.readUInt16LE(pe + 20);
    for (let i = 0; i < bytes.readUInt16LE(pe + 6); i++) {
      const section = sectionStart + i * 40;
      const start = bytes.readUInt32LE(section + 12);
      const size = bytes.readUInt32LE(section + 16);
      if (clrRva < start || clrRva >= start + size) continue;
      const clr = clrRva - start + bytes.readUInt32LE(section + 20);
      const flags = bytes.readUInt32LE(clr + 16);
      if ((flags & 1) === 0 || (flags & (2 | 0x20000)) !== 0) return false;
      return machine === 0x14c || machine === (process.arch === "arm64" ? 0xaa64 : 0x8664);
    }
  } catch {
    return false;
  }
  return false;
}

export async function resolveDotnetRuntime(
  program: string,
  projectRoots: readonly string[],
  installer: ToolInstaller,
  allowDownload: boolean,
  options: InstallationOptions,
): Promise<{ host?: string; environment: Record<string, string> }> {
  const dll = extname(program).toLowerCase() === ".dll";
  const suffix = extname(program).toLowerCase();
  const stem = suffix === ".dll" || suffix === ".exe" ? program.slice(0, -suffix.length) : program;
  let config: unknown;
  try {
    config = JSON.parse(await readFile(`${stem}.runtimeconfig.json`, "utf8"));
  } catch {
    throw unsupported();
  }
  if (!Value.Check(RuntimeConfig, config)) throw unsupported();
  const runtime = config.runtimeOptions;
  if ((runtime.framework && runtime.frameworks) || runtime.rollForwardOnNoCandidateFx !== undefined)
    throw unsupported();
  try {
    const dependencies: unknown = JSON.parse(await readFile(`${stem}.deps.json`, "utf8"));
    if (!Value.Check(Dependencies, dependencies)) throw unsupported();
    const rid = dependencies.runtimeTarget.name.split("/")[1];
    const os =
      process.platform === "win32" ? "win" : process.platform === "darwin" ? "osx" : "linux";
    if (rid !== undefined && rid !== `${os}-${process.arch}`) throw unsupported();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw unsupported();
  }
  const state = join(installer.directory, "runtime-cache", "dotnet");
  const environment = {
    DOTNET_CLI_HOME: state,
    NUGET_PACKAGES: join(state, "nuget"),
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_GENERATE_ASPNET_CERTIFICATE: "0",
    DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: "0",
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: "1",
    DOTNET_CLI_VULNERABILITY_AUDIT_DISABLE: "1",
    DOTNET_NOLOGO: "1",
  };
  if (
    runtime.includedFrameworks?.length &&
    !runtime.framework &&
    !runtime.frameworks?.length &&
    !dll
  ) {
    const library =
      process.platform === "win32"
        ? "coreclr.dll"
        : process.platform === "darwin"
          ? "libcoreclr.dylib"
          : "libcoreclr.so";
    try {
      await access(join(dirname(program), library));
    } catch {
      throw unsupported();
    }
    await mkdir(state, { recursive: true, mode: 0o700 });
    return { environment };
  }
  const frameworks = runtime.framework ? [runtime.framework] : runtime.frameworks;
  const framework = frameworks?.[0];
  const policy = runtime.rollForward ?? "Minor";
  if (
    !dll ||
    !nativeAssembly(await readFile(program)) ||
    frameworks?.length !== 1 ||
    framework?.name !== "Microsoft.NETCore.App" ||
    !Value.Check(Policy, policy) ||
    runtime.applyPatches === false ||
    runtime.additionalProbingPaths !== undefined ||
    runtime.includedFrameworks?.length
  )
    throw unsupported();
  try {
    await access(`${stem}.runtimeconfig.dev.json`);
    throw unsupported();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const executable = process.platform === "win32" ? "dotnet.exe" : "dotnet";
  const candidates = [
    ...projectRoots.map((root) => join(root, ".dotnet", executable)),
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((path) => join(path, executable)),
  ];
  await mkdir(state, { recursive: true, mode: 0o700 });
  for (const candidate of candidates) {
    options.signal?.throwIfAborted();
    try {
      const stdout = await probeDapRuntime(candidate, ["--list-runtimes"], {
        signal: options.signal,
        env: { ...process.env, ...environment },
      });
      if (
        stdout.split(/\r?\n/).some((line) => {
          const match = /^Microsoft\.NETCore\.App (\d+\.\d+\.\d+) \[/.exec(line);
          return match && compatible(match[1]!, framework.version, policy);
        })
      )
        return { host: candidate, environment };
    } catch {
      options.signal?.throwIfAborted();
    }
  }
  const id = dotnetRuntimeId(framework.version, policy);
  let installation = await installer.installed(id);
  if (!installation) {
    if (!allowDownload)
      throw new Error(
        `Compatible .NET runtime ${framework.version} is not installed; enable automatic downloads or configure an external runtime.`,
      );
    const request = await dotnetRuntimeRequest(framework.version, policy, options.signal);
    installation = await installer.ensure(request, { ...options, allowDownload });
  }
  const directory = installation.components.runtime?.directory;
  if (!directory) throw new Error("Incomplete managed .NET runtime installation");
  return {
    host: join(directory, executable),
    environment: { ...installation.environment, ...environment },
  };
}
