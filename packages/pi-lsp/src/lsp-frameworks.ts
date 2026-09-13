import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import {
  type InstallationOptions,
  type ManagedInstallation,
  type NpmPackage,
  type ToolRequest,
  ToolInstaller,
} from "@ian-pascoe/pi-tool-installer";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { LspServerDefinition } from "./pi-lsp-settings.js";
import {
  lspAncestorPaths as ancestors,
  findLspExecutable as executable,
  lspExecutableDirectories,
  inspectLspExecutable,
} from "./lsp-executables.js";

const PackageSchema = Type.Object({
  name: Type.String(),
  version: Type.String(),
  peerDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
  engines: Type.Optional(Type.Object({ node: Type.Optional(Type.String()) })),
});
/** Approved historical backport exception; native integrity and script-denial checks remain. */
export const SVELTE_SERVER_SELECTOR =
  "npm:svelte-language-server[trust_policy_excludes=svelte@4.2.20]";

const frameworks = {
  vue: {
    name: "@vue/language-server",
    command: "vue-language-server",
    script: "vue-language-server.js",
  },
  svelte: { name: "svelte-language-server", command: "svelteserver", script: "server.js" },
  astro: { name: "@astrojs/language-server", command: "astro-ls", script: "nodeServer.js" },
};
type FrameworkId = keyof typeof frameworks;
function serverRequirement(id: FrameworkId, version: string): string {
  const selector = id === "svelte" ? SVELTE_SERVER_SELECTOR : `npm:${frameworks[id].name}`;
  return `${selector}@${version}`;
}
function frameworkId(id: string): id is FrameworkId {
  return Object.hasOwn(frameworks, id);
}

const PackageFactsSchema = Type.Tuple([Type.String(), Type.String(), Type.String()]);
const FrameworkFactsSchema = Type.Tuple([
  Type.Union([PackageFactsSchema, Type.Null()]),
  Type.Union([Type.String(), Type.Null()]),
  Type.Union([PackageFactsSchema, Type.Null()]),
  Type.Union([Type.String(), Type.Null()]),
]);
type FrameworkFacts = Static<typeof FrameworkFactsSchema>;
function packageFacts(pkg: NpmPackage | undefined): FrameworkFacts[0] {
  return pkg
    ? [pkg.version, pkg.peerDependencies?.typescript ?? "*", pkg.engines?.node ?? "*"]
    : null;
}
function packageFromFacts(name: string, facts: NonNullable<FrameworkFacts[0]>): NpmPackage {
  return {
    name,
    version: facts[0],
    peerDependencies: { typescript: facts[1] },
    engines: { node: facts[2] },
  };
}
function frameworkVariant(installationId: string) {
  const match = /^lsp-(vue|svelte|astro)-compat-(.*)$/u.exec(installationId);
  if (!match) return undefined;
  const encoded = match[2]!;
  try {
    if (!/^(?:[a-f0-9]{2})+$/u.test(encoded) || installationId.length > 230) throw new Error();
    const value: unknown = JSON.parse(Buffer.from(encoded, "hex").toString("utf8"));
    if (!Value.Check(FrameworkFactsSchema, value)) throw new Error();
    for (const pkg of [value[0], value[2]])
      if (
        pkg &&
        (!semver.valid(pkg[0]) || !semver.validRange(pkg[1]) || !semver.validRange(pkg[2]))
      )
        throw new Error();
    for (const version of [value[1], value[3]])
      if (version !== null && !semver.valid(version)) throw new Error();
    if (
      value.every((fact) => fact === null) ||
      Buffer.from(JSON.stringify(value)).toString("hex") !== encoded
    )
      throw new Error();
    const id = match[1]!;
    if (!frameworkId(id)) throw new Error();
    return { id, facts: value };
  } catch {
    throw new Error(`Pi LSP: invalid framework compatibility selection ${installationId}`);
  }
}
export function frameworkPresetForInstallation(installationId: string): FrameworkId | undefined {
  const base = /^lsp-(vue|svelte|astro)$/u.exec(installationId);
  const id = base?.[1];
  return id && frameworkId(id) ? id : frameworkVariant(installationId)?.id;
}
function frameworkSelectionId(id: FrameworkId, facts: FrameworkFacts): string {
  if (facts.every((fact) => fact === null)) return `lsp-${id}`;
  const selection = `lsp-${id}-compat-${Buffer.from(JSON.stringify(facts)).toString("hex")}`;
  frameworkVariant(selection);
  return selection;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ENOTDIR"].includes(String(error.code))
    )
      return false;
    throw error;
  }
}
async function compatibleNodeVersion(
  path: string,
  options: InstallationOptions,
  ranges: readonly string[],
): Promise<string | undefined> {
  try {
    const version = await inspectLspExecutable(path, ["--version"], {
      signal: options.signal,
      timeoutMs: 5000,
    });
    return ranges.every((range) => semver.satisfies(version, range))
      ? (semver.clean(version) ?? undefined)
      : undefined;
  } catch {
    options.signal?.throwIfAborted();
    return undefined;
  }
}
async function packagePath(name: string, roots: string[]): Promise<string | undefined> {
  for (const root of roots) {
    try {
      return dirname(
        createRequire(join(await realpath(root), "package.json")).resolve(`${name}/package.json`),
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND"))
        throw error;
    }
  }
  return undefined;
}
async function manifest(path: string) {
  return Value.Parse(PackageSchema, JSON.parse(await readFile(join(path, "package.json"), "utf8")));
}
function compatibleSdk(
  version: string,
  server: Pick<NpmPackage, "peerDependencies">,
  host?: Pick<NpmPackage, "peerDependencies">,
): boolean {
  // Candidate constraints, not a claim that every historical SDK is verified.
  // Native TS7 does not expose the JavaScript SDK API, despite Vue's wildcard peer.
  return (
    semver.satisfies(version, "<7") &&
    semver.satisfies(version, server.peerDependencies?.typescript ?? "*") &&
    semver.satisfies(version, host?.peerDependencies?.typescript ?? "*")
  );
}
async function sdkPath(
  roots: string[],
  server: Pick<NpmPackage, "peerDependencies">,
  host?: Pick<NpmPackage, "peerDependencies">,
): Promise<string | undefined> {
  for (const root of roots) {
    const pkg = await packagePath("typescript", [root]);
    if (
      pkg &&
      compatibleSdk((await manifest(pkg)).version, server, host) &&
      (await exists(join(pkg, "lib", "typescript.js")))
    )
      return join(pkg, "lib");
  }
  return undefined;
}
async function latest(
  installer: ToolInstaller,
  name: string,
  options: InstallationOptions,
): Promise<NpmPackage> {
  const selected = (await installer.npmVersions(name, options)).find(
    (pkg) => "latest" in pkg && pkg.latest === true,
  );
  if (!selected) throw new Error(`Pi LSP: ${name} has no validated npm latest release`);
  return selected;
}
async function latestSdk(
  installer: ToolInstaller,
  server: Pick<NpmPackage, "name" | "version" | "peerDependencies">,
  options: InstallationOptions,
  host?: Pick<NpmPackage, "peerDependencies">,
): Promise<string> {
  const selected = (await installer.npmVersions("typescript", options))
    .filter((pkg) => compatibleSdk(pkg.version, server, host))
    .sort((a, b) => semver.rcompare(a.version, b.version))[0];
  if (!selected)
    throw new Error(
      `Pi LSP: no compatible JavaScript TypeScript SDK for ${server.name}@${server.version}`,
    );
  return selected.version;
}
function componentPackage(
  installation: ManagedInstallation | undefined,
  key: string,
  name: string,
): string | undefined {
  const component = installation?.components[key];
  return component ? join(component.directory, "node_modules", name) : undefined;
}

/** Re-plan the complete compatible graph before the installer can publish an update. */
export async function frameworkUpdateRequest(
  id: string,
  installation: ManagedInstallation,
  installer: ToolInstaller,
  root: string,
  options: InstallationOptions,
): Promise<ToolRequest | undefined> {
  if (!frameworkId(id)) return undefined;
  const name = frameworks[id].name;
  const captured = frameworkVariant(installation.id)?.facts;
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const external = captured
    ? undefined
    : await executable(frameworks[id].command, lspExecutableDirectories(root, environment));
  const lookup = captured
    ? []
    : [...ancestors(root), ...(external ? ancestors(dirname(await realpath(external))) : [])];
  const serverPackage =
    captured || installation.components.server ? undefined : await packagePath(name, lookup);
  if (!installation.components.server && !serverPackage && !captured?.[0])
    throw new Error(
      `Pi LSP: updating ${id}'s compatibility dependencies requires its external server in this project`,
    );
  const server = captured?.[0]
    ? packageFromFacts(name, captured[0])
    : installation.components.server
      ? await latest(installer, name, options)
      : await manifest(serverPackage!);
  const host = captured?.[2]
    ? packageFromFacts("typescript-language-server", captured[2])
    : installation.components.host
      ? await latest(installer, "typescript-language-server", options)
      : undefined;
  if (captured?.[1] && !compatibleSdk(captured[1], server, host))
    throw new Error(
      `Pi LSP: updating ${id} is incompatible with its captured external TypeScript SDK ${captured[1]}`,
    );
  if (
    captured?.[3] &&
    ![">=22.19.0", server.engines?.node ?? "*", host?.engines?.node ?? "*"].every((range) =>
      semver.satisfies(captured[3]!, range),
    )
  )
    throw new Error(
      `Pi LSP: updating ${id} is incompatible with its captured external Node ${captured[3]}`,
    );
  const requirements = Object.fromEntries(
    Object.entries(installation.components).map(([key, component]) => [key, component.selector]),
  );
  if (requirements.server && !captured?.[0])
    requirements.server = serverRequirement(id, server.version);
  if (requirements.sdk) {
    requirements.sdk = `npm:typescript@${await latestSdk(installer, server, options, host)}`;
  } else if (!captured?.[1] && !(await sdkPath(lookup, server, host))) {
    throw new Error(
      `Pi LSP: updating ${id} requires its compatible external TypeScript SDK in this project`,
    );
  }
  if (requirements.host && !captured?.[2])
    requirements.host = `npm:typescript-language-server@${host!.version}`;
  return { id: installation.id, requirements };
}

/** Framework-only compatibility path; explicit definitions never enter managed resolution. */
export async function prepareFrameworkPreset(
  definition: LspServerDefinition,
  root: string,
  installer: ToolInstaller,
  allowDownload: boolean,
  options: InstallationOptions,
): Promise<LspServerDefinition> {
  if (!definition.preset || !frameworkId(definition.id)) return definition;
  options.signal?.throwIfAborted();
  const id = definition.id;
  const { name, command: serverCommand, script } = frameworks[id];
  const roots = ancestors(root);
  const pathKey =
    Object.keys(definition.environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const paths = lspExecutableDirectories(root, definition.environment);
  const externalServer = await executable(serverCommand, paths);
  const serverRoots = externalServer ? ancestors(dirname(await realpath(externalServer))) : [];
  const lookup = [...roots, ...serverRoots];
  const externalServerPackage = await packagePath(name, lookup);
  const externalServerMetadata = externalServerPackage
    ? await manifest(externalServerPackage)
    : undefined;
  const externalHostPackage =
    id === "vue" ? await packagePath("typescript-language-server", lookup) : undefined;
  const externalHostMetadata = externalHostPackage
    ? await manifest(externalHostPackage)
    : undefined;
  let externalSdk = await sdkPath(lookup, externalServerMetadata ?? {});
  let nodeVersion: string | undefined;
  await executable("node", paths, async (path) => {
    nodeVersion = await compatibleNodeVersion(path, options, [
      ">=22.19.0",
      externalServerMetadata?.engines?.node ?? "*",
      externalHostMetadata?.engines?.node ?? "*",
    ]);
    return nodeVersion !== undefined;
  });
  const facts: FrameworkFacts = [
    packageFacts(externalServerMetadata),
    externalSdk ? (await manifest(dirname(externalSdk))).version : null,
    packageFacts(externalHostMetadata),
    nodeVersion ?? null,
  ];
  let selectionId = frameworkSelectionId(id, facts);
  let previous = await installer.installed(selectionId);
  if (!previous) {
    previous = (await installer.list()).find((candidate) => {
      if (frameworkPresetForInstallation(candidate.id) !== id) return false;
      const captured = frameworkVariant(candidate.id)?.facts ?? [null, null, null, null];
      return (
        JSON.stringify(captured[0]) === JSON.stringify(facts[0]) &&
        (captured[1] === facts[1] || captured[1] === null) &&
        JSON.stringify(captured[2]) === JSON.stringify(facts[2])
      );
    });
  }
  let serverPackage = externalServerPackage ?? componentPackage(previous, "server", name);
  let server = serverPackage
    ? await manifest(serverPackage)
    : allowDownload
      ? await latest(installer, name, options)
      : undefined;
  if (!server)
    throw new Error(
      `lsp-${id} is not installed. Enable automatic downloads or configure an external executable.`,
    );
  let hostPackage =
    externalHostPackage ??
    (id === "vue" ? componentPackage(previous, "host", "typescript-language-server") : undefined);
  let host = hostPackage
    ? await manifest(hostPackage)
    : id === "vue" && allowDownload
      ? await latest(installer, "typescript-language-server", options)
      : undefined;
  let nodeRanges = [">=22.19.0", server.engines?.node ?? "*", host?.engines?.node ?? "*"];
  nodeVersion = undefined;
  const externalNode = await executable("node", paths, async (path) => {
    nodeVersion = await compatibleNodeVersion(path, options, nodeRanges);
    return nodeVersion !== undefined;
  });
  externalSdk = await sdkPath(lookup, server, host);
  facts[1] = externalSdk ? (await manifest(dirname(externalSdk))).version : null;
  facts[3] = nodeVersion ?? null;
  selectionId = frameworkSelectionId(id, facts);
  const exact = await installer.installed(selectionId);
  if (exact && exact.id !== previous?.id) {
    previous = exact;
    serverPackage = externalServerPackage ?? componentPackage(exact, "server", name);
    server = serverPackage ? await manifest(serverPackage) : server;
    hostPackage =
      externalHostPackage ??
      (id === "vue" ? componentPackage(exact, "host", "typescript-language-server") : undefined);
    host = hostPackage ? await manifest(hostPackage) : host;
    nodeRanges = [">=22.19.0", server.engines?.node ?? "*", host?.engines?.node ?? "*"];
  }
  let sdk = externalSdk;
  const retainedSdk = componentPackage(previous, "sdk", "typescript");
  if (!sdk && retainedSdk && compatibleSdk((await manifest(retainedSdk)).version, server, host))
    sdk = join(retainedSdk, "lib");
  if (
    !sdk &&
    !previous?.components.server &&
    !previous?.components.host &&
    serverPackage &&
    (id !== "vue" || hostPackage)
  ) {
    for (const donor of await installer.list()) {
      const components = Object.entries(donor.components);
      const index = components.findIndex(
        ([, component]) =>
          /^npm:typescript(?:@|$)/u.test(component.selector) &&
          compatibleSdk(component.version, server, host),
      );
      if (index < 0) continue;
      const candidate = join(components[index]![1].directory, "node_modules", "typescript", "lib");
      if (!(await exists(join(candidate, "typescript.js")))) continue;
      const prefix = components.slice(0, index + 1);
      const node = prefix.find(([, component]) => /^core:node(?:@|$)/u.test(component.selector));
      if (
        !externalNode &&
        (!node ||
          !(await compatibleNodeVersion(
            join(node[1].directory, process.platform === "win32" ? "node.exe" : "bin/node"),
            options,
            nodeRanges,
          )))
      )
        continue;
      const requirements = Object.fromEntries(
        prefix.map(([, component], position) => [
          position === index ? "sdk" : component === node?.[1] ? "node" : `prerequisite${position}`,
          component.selector,
        ]),
      );
      previous = await installer.ensure(
        { id: selectionId, requirements },
        { ...options, allowDownload: false },
      );
      sdk = candidate;
      break;
    }
  }
  const needsNode = !externalNode && !previous?.components.node;
  const needsSdk = !sdk;
  const needsServer = !serverPackage;
  const needsHost = id === "vue" && !hostPackage;
  const usesManaged =
    !externalNode ||
    !externalServerPackage ||
    !externalSdk ||
    (id === "vue" && !externalHostPackage);
  let installation = usesManaged ? previous : undefined;
  if (
    needsNode ||
    needsSdk ||
    needsServer ||
    needsHost ||
    (usesManaged && previous && previous.id !== selectionId)
  ) {
    if (!allowDownload && (needsNode || needsSdk || needsServer || needsHost))
      throw new Error(
        `lsp-${id} is not installed. Enable automatic downloads or configure an external executable.`,
      );
    let requirements: ToolRequest["requirements"] = Object.fromEntries(
      Object.entries(previous?.components ?? {}).map(([key, component]) => [
        key,
        component.selector,
      ]),
    );
    if (needsNode && !requirements.node) requirements = { node: "core:node", ...requirements };
    if (needsSdk) {
      requirements.sdk = `npm:typescript@${await latestSdk(installer, server, options, host)}`;
    } else if (previous?.components.sdk) requirements.sdk = previous.components.sdk.selector;
    if (needsServer) requirements.server = serverRequirement(id, server.version);
    else if (previous?.components.server) requirements.server = previous.components.server.selector;
    if (needsHost) requirements.host = `npm:typescript-language-server@${host!.version}`;
    else if (previous?.components.host) requirements.host = previous.components.host.selector;
    installation = await installer.ensure(
      { id: selectionId, requirements },
      { ...options, allowDownload },
    );
  }
  options.signal?.throwIfAborted();
  sdk ??= join(componentPackage(installation, "sdk", "typescript")!, "lib");
  serverPackage ??= componentPackage(installation, "server", name)!;
  const node =
    externalNode ??
    join(
      installation!.components.node!.directory,
      process.platform === "win32" ? "node.exe" : "bin/node",
    );
  if (!externalNode && !(await compatibleNodeVersion(node, options, nodeRanges)))
    throw new Error(`Pi LSP: ${id}'s managed Node runtime is incompatible; run /lsp update ${id}`);
  const environment = {
    ...definition.environment,
    ...installation?.environment,
    [pathKey]: [...paths, ...(installation?.binDirectories ?? [])].join(delimiter),
  };
  if (id === "vue") {
    hostPackage ??= componentPackage(installation, "host", "typescript-language-server")!;
    const plugin = await packagePath("@vue/typescript-plugin", [serverPackage]);
    if (!plugin)
      throw new Error(
        "Pi LSP: Vue requires its matching @vue/typescript-plugin; install project dependencies or configure an explicit server.",
      );
    return {
      ...definition,
      command: node,
      args: [
        fileURLToPath(new URL("./lsp-vue-bridge.mjs", import.meta.url)),
        join(serverPackage, "bin", script),
        sdk,
        dirname(dirname(plugin)),
        join(hostPackage, "lib", "cli.mjs"),
      ],
      environment,
    };
  }
  const args =
    id === "svelte"
      ? [
          fileURLToPath(new URL("./lsp-svelte-sdk.mjs", import.meta.url)),
          join(serverPackage, "bin", script),
          sdk,
          "--stdio",
        ]
      : [join(serverPackage, "bin", script), "--stdio"];
  return {
    ...definition,
    command: node,
    args,
    environment,
    initializationOptions: { typescript: { tsdk: sdk } },
  };
}
