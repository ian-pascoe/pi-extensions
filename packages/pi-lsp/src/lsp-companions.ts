import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { rcompare, satisfies, validRange } from "semver";
import { dirname, isAbsolute, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type InstallationOptions,
  type ManagedInstallation,
  type ToolRequest,
  ToolInstaller,
} from "@ian-pascoe/pi-tool-installer";
import {
  findLspExecutable,
  inspectLspExecutable,
  lspAncestorPaths,
  lspExecutableDirectories,
} from "./lsp-executables.js";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { LspServerDefinition } from "./pi-lsp-settings.js";

/** Official released VSIX; native mise owns downloading, digest verification and extraction. */
export const ESLINT_SERVER_SELECTOR =
  "http:eslint[url=https://open-vsx.org/api/dbaeumer/vscode-eslint/{{version}}/file/dbaeumer.vscode-eslint-{{version}}.vsix,format=zip,bin_path=extension/server/out,strip_components=0,version_list_url=https://open-vsx.org/api/dbaeumer/vscode-eslint,version_json_path=.version,checksum_url=https://open-vsx.org/api/dbaeumer/vscode-eslint/{{version}}/file/dbaeumer.vscode-eslint-{{version}}.sha256]";

const OfficialEslintManifest = Type.Object({
  name: Type.Literal("vscode-eslint"),
  publisher: Type.Literal("dbaeumer"),
  repository: Type.Object({
    url: Type.String({ pattern: "^https://github\\.com/[Mm]icrosoft/vscode-eslint(?:\\.git)?$" }),
  }),
});

/** An old extracted npm server with the same executable name is not the official server. */
export async function isOfficialEslintServer(path: string): Promise<boolean> {
  for (let directory = dirname(await realpath(path)); ; directory = dirname(directory)) {
    try {
      const manifest: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (Value.Check(OfficialEslintManifest, manifest)) return true;
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        !(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTDIR"].includes(String(error.code))
        )
      )
        throw error;
    }
    if (dirname(directory) === directory) return false;
  }
}

/** Keep the native cache in its managed home while fitting macOS's Unix socket path limit. */
async function biomeSocketHome(home: string): Promise<string> {
  const target = await realpath(home);
  const uid = process.getuid!();
  const identity = createHash("sha256").update(`${uid}\0${target}`).digest("hex").slice(0, 24);
  const directory = `/tmp/pi-b-${identity}`;
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o777) !== 0o700)
    throw new Error(`Pi LSP: unsafe Biome socket alias directory ${directory}`);
  const alias = join(directory, "h");
  try {
    await symlink(target, alias);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const link = await lstat(alias);
  if (!link.isSymbolicLink() || link.uid !== uid || (await readlink(alias)) !== target)
    throw new Error(`Pi LSP: unsafe Biome socket alias ${alias}`);
  // Persist the alias: detached native daemons and versioned sockets are shared across sessions.
  return alias;
}

/** Apply protocol policy only after the preset's executable/runtime precedence is resolved. */
export async function prepareCompanionPreset(
  definition: LspServerDefinition,
  root: string,
  installer: ToolInstaller,
  allowDownload: boolean,
  options: InstallationOptions,
): Promise<LspServerDefinition> {
  if (!definition.preset) return definition;
  options.signal?.throwIfAborted();
  if (definition.id === "oxlint") {
    return prepareOxlintHelper(
      {
        ...definition,
        protocol: "oxlint",
        initializationOptions: [{ workspaceUri: pathToFileURL(root).href, options: {} }],
      },
      root,
      installer,
      allowDownload,
      options,
    );
  }
  if (definition.id === "eslint") {
    return {
      ...definition,
      protocol: "eslint",
      settings: {
        validate: "on",
        run: "onType",
        workspaceFolder: { uri: pathToFileURL(root).href, name: "workspace" },
        workingDirectory: { mode: "auto" },
      },
    };
  }
  if (definition.id === "biome") {
    const home = join(installer.directory, "lsp", "biome");
    await mkdir(home, { recursive: true, mode: 0o700 });
    // The native daemon stops after its final LSP connection. Never run `biome stop`,
    // which could terminate another root/session's active daemon.
    return {
      ...definition,
      diagnosticMode: "push",
      protocol: "biome",
      environment: {
        ...definition.environment,
        HOME: process.platform === "darwin" ? await biomeSocketHome(home) : home,
        USERPROFILE: home,
        XDG_CACHE_HOME: join(home, "cache"),
        LOCALAPPDATA: join(home, "AppData", "Local"),
        BIOME_LOG_PATH: join(home, "logs"),
      },
    };
  }
  return definition;
}

const OxlintConfigurationSchema = Type.Object({
  options: Type.Optional(Type.Object({ typeAware: Type.Optional(Type.Boolean()) })),
});
const OxlintPackageSchema = Type.Object({
  name: Type.Literal("oxlint"),
  version: Type.String(),
  peerDependencies: Type.Record(Type.String(), Type.String()),
});

async function oxlintCommand(
  definition: LspServerDefinition,
  root: string,
  argument: string,
  options: InstallationOptions,
): Promise<string> {
  return inspectLspExecutable(
    definition.command,
    [...definition.args.filter((arg) => arg !== "--lsp"), argument],
    { cwd: root, environment: definition.environment, signal: options.signal, timeoutMs: 10_000 },
  );
}

async function oxlintPeer(
  definition: LspServerDefinition,
  root: string,
  installer: ToolInstaller,
  allowDownload: boolean,
  options: InstallationOptions,
): Promise<string> {
  const version = /\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b/.exec(
    await oxlintCommand(definition, root, "--version", options),
  )?.[1];
  if (!version)
    throw new Error("Cannot determine selected Oxlint version for type-aware compatibility");
  for (const location of [definition.args[0], definition.command, join(root, "package.json")]) {
    if (!location) continue;
    try {
      const manifestPath = createRequire(await realpath(location)).resolve("oxlint/package.json");
      const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
      if (Value.Check(OxlintPackageSchema, manifest) && manifest.version === version) {
        const peer = manifest.peerDependencies["oxlint-tsgolint"];
        if (peer && validRange(peer)) return peer;
      }
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "MODULE_NOT_FOUND"].includes(String(error.code))
        )
      )
        throw error;
    }
  }
  if (!allowDownload)
    throw new Error(
      "Oxlint type-aware compatibility metadata is unavailable in Installed-only Mode; configure an explicit helper/server",
    );
  const manifest = (await installer.npmVersions("oxlint", options)).find(
    (candidate) => candidate.version === version,
  );
  const peer = manifest?.peerDependencies?.["oxlint-tsgolint"];
  if (!peer || !validRange(peer))
    throw new Error(
      `Oxlint ${version} does not declare a supported oxlint-tsgolint compatibility range`,
    );
  return peer;
}

function companionPeerForInstallation(installationId: string): string | undefined {
  const match = /^lsp-oxlint-compat-(.*)$/u.exec(installationId);
  if (!match) return undefined;
  const encoded = match[1]!;
  const peer = Buffer.from(encoded, "hex").toString("utf8");
  if (
    installationId.length > 230 ||
    !/^(?:[a-f0-9]{2})+$/u.test(encoded) ||
    !validRange(peer) ||
    Buffer.from(peer).toString("hex") !== encoded
  )
    throw new Error(`Pi LSP: invalid Oxlint compatibility selection ${installationId}`);
  return peer;
}

export function companionPresetForInstallation(installationId: string): "oxlint" | undefined {
  return installationId === "lsp-oxlint" || companionPeerForInstallation(installationId)
    ? "oxlint"
    : undefined;
}

async function latestHelper(
  installer: ToolInstaller,
  peer: string,
  options: InstallationOptions,
): Promise<string> {
  const compatible = (await installer.npmVersions("oxlint-tsgolint", options))
    .filter((candidate) => satisfies(candidate.version, peer))
    .sort((a, b) => rcompare(a.version, b.version));
  if (!compatible[0]) throw new Error(`No oxlint-tsgolint version satisfies ${peer}`);
  return compatible[0].version;
}

async function nativeHelper(path: string): Promise<string> {
  const manifests = [
    join(dirname(path), "..", "oxlint-tsgolint", "package.json"),
    join(dirname(path), "node_modules", "oxlint-tsgolint", "package.json"),
    ...lspAncestorPaths(dirname(await realpath(path))).map((directory) =>
      join(directory, "package.json"),
    ),
  ];
  for (const manifest of manifests) {
    try {
      const value: unknown = JSON.parse(await readFile(manifest, "utf8"));
      if (Value.Check(Type.Object({ name: Type.Literal("oxlint-tsgolint") }), value)) {
        return createRequire(await realpath(manifest)).resolve(
          `@oxlint-tsgolint/${process.platform}-${process.arch}/tsgolint${process.platform === "win32" ? ".exe" : ""}`,
        );
      }
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        !(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTDIR", "MODULE_NOT_FOUND"].includes(String(error.code))
        )
      )
        throw error;
    }
  }
  return path;
}

async function prepareOxlintHelper(
  definition: LspServerDefinition,
  root: string,
  installer: ToolInstaller,
  allowDownload: boolean,
  options: InstallationOptions,
): Promise<LspServerDefinition> {
  const config: unknown = JSON.parse(
    await oxlintCommand(definition, root, "--print-config", options),
  );
  if (!Value.Check(OxlintConfigurationSchema, config))
    throw new Error("Invalid resolved Oxlint configuration");
  if (config.options?.typeAware !== true) return definition;
  const peer = await oxlintPeer(definition, root, installer, allowDownload, options);
  const accepts = async (path: string) => {
    const candidate = await nativeHelper(path);
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(candidate)) return false;
    try {
      const output = await oxlintCommand(
        { ...definition, command: candidate, args: [] },
        root,
        "--version",
        options,
      );
      const version = /\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b/.exec(output)?.[1];
      return version !== undefined && satisfies(version, peer);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof Error) return false;
      throw error;
    }
  };
  let helper: string | undefined;
  const configured = definition.environment.OXLINT_TSGOLINT_PATH;
  if (configured && (await accepts(configured))) helper = await nativeHelper(configured);
  helper ??= await findLspExecutable(
    "tsgolint",
    lspExecutableDirectories(root, definition.environment),
    accepts,
  );
  if (helper)
    return {
      ...definition,
      environment: { ...definition.environment, OXLINT_TSGOLINT_PATH: await nativeHelper(helper) },
    };
  const base = await installer.installed("lsp-oxlint");
  let managedServer = false;
  if (base?.components.server) {
    const directory = `${await realpath(base.components.server.directory)}${sep}`;
    for (const candidate of [definition.command, ...definition.args.slice(0, 1)]) {
      if (isAbsolute(candidate) && (await realpath(candidate)).startsWith(directory)) {
        managedServer = true;
        break;
      }
    }
  }
  // External servers keep separate helper selections keyed by their published contract.
  const id = managedServer
    ? "lsp-oxlint"
    : `lsp-oxlint-compat-${Buffer.from(peer).toString("hex")}`;
  companionPresetForInstallation(id);
  const previous = id === "lsp-oxlint" ? base : await installer.installed(id);
  let version = previous?.components.helper?.version;
  if (!version && base?.components.helper && satisfies(base.components.helper.version, peer))
    version = base.components.helper.version;
  if (!version || !satisfies(version, peer)) {
    if (!allowDownload)
      throw new Error(
        "Compatible Oxlint type-aware helper is unavailable; enable automatic downloads or configure an external helper",
      );
    version = await latestHelper(installer, peer, options);
  }
  const requirements: ToolRequest["requirements"] = {
    node: "core:node",
    ...Object.fromEntries(
      Object.entries(previous?.components ?? {}).map(([key, value]) => [key, value.selector]),
    ),
  };
  requirements.helper = `npm:oxlint-tsgolint@${version}`;
  const installation = await installer.ensure({ id, requirements }, { ...options, allowDownload });
  const manifest = join(
    installation.components.helper!.directory,
    "node_modules/oxlint-tsgolint/package.json",
  );
  helper = createRequire(await realpath(manifest)).resolve(
    `@oxlint-tsgolint/${process.platform}-${process.arch}/tsgolint${process.platform === "win32" ? ".exe" : ""}`,
  );
  return {
    ...definition,
    environment: { ...definition.environment, OXLINT_TSGOLINT_PATH: helper },
  };
}

/** Resolve an atomic server/helper update before publishing any new working selection. */
export async function companionUpdateRequest(
  id: string,
  installation: ManagedInstallation,
  installer: ToolInstaller,
  root: string,
  options: InstallationOptions,
): Promise<ToolRequest | undefined> {
  if (id !== "oxlint" || !installation.components.helper) return undefined;
  const requirements = Object.fromEntries(
    Object.entries(installation.components).map(([key, value]) => [key, value.selector]),
  );
  let peer: string;
  const capturedPeer = companionPeerForInstallation(installation.id);
  if (capturedPeer) {
    peer = capturedPeer;
  } else if (installation.components.server) {
    const newest = (await installer.npmVersions("oxlint", options)).find(
      (candidate) => candidate.latest,
    );
    const range = newest?.peerDependencies?.["oxlint-tsgolint"];
    if (!newest || !range || !validRange(range))
      throw new Error("Latest Oxlint has no supported type-aware helper compatibility declaration");
    requirements.server = `npm:oxlint@${newest.version}`;
    peer = range;
  } else {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const command = await findLspExecutable("oxlint", lspExecutableDirectories(root, environment));
    if (!command)
      throw new Error(
        "External Oxlint is unavailable in this project; cannot update its private helper compatibly",
      );
    peer = await oxlintPeer(
      {
        id: "oxlint",
        command,
        args: [],
        environment,
        languages: [],
        rootMarkers: [],
        requireRootMarker: false,
      },
      root,
      installer,
      true,
      options,
    );
  }
  requirements.helper = `npm:oxlint-tsgolint@${await latestHelper(installer, peer, options)}`;
  return { id: installation.id, requirements };
}
