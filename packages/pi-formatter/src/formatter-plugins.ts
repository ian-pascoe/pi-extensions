import { readFile, realpath } from "node:fs/promises";
import * as nodeModule from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  InstallationOptions,
  ManagedInstallation,
  NpmPackage,
  ToolInstaller,
  ToolRequest,
} from "@ian-pascoe/pi-tool-installer";
import { rcompare, satisfies, subset, valid, validRange } from "semver";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { FormatterDefinition } from "./pi-formatter-settings.js";
import { runFormatterCommand, formatFormatterFailure } from "./formatter-process.js";

const PackageSchema = Type.Object({
  name: Type.String(),
  version: Type.String(),
  peerDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
  engines: Type.Optional(Type.Object({ node: Type.Optional(Type.String()) })),
});
const CompatibilitySchema = Type.Object({
  prettier: Type.String(),
  framework: Type.String(),
  node: Type.String(),
});
type PluginCompatibility = Static<typeof CompatibilitySchema>;
const InspectSchema = Type.Object({
  ignored: Type.Boolean(),
  plugins: Type.Array(Type.String()),
  node: Type.String(),
  framework: Type.Optional(Type.Union([Type.Literal("svelte"), Type.Literal("astro")])),
  needsHooks: Type.Boolean(),
  pending: Type.Optional(
    Type.Union([Type.Literal("prettier-plugin-svelte"), Type.Literal("prettier-plugin-astro")]),
  ),
});
const ManifestSchema = Type.Object({
  dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
  devDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
});
const runnerPath = fileURLToPath(new URL("./formatter-plugin-runner.mjs", import.meta.url));

async function readPackage(directory: string) {
  let text: string;
  try {
    text = await readFile(join(directory, "package.json"), "utf8");
  } catch (error) {
    if (Value.Check(Type.Object({ code: Type.Literal("ENOENT") }), error)) return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!Value.Check(PackageSchema, value) || !valid(value.version))
    throw new Error(`Invalid package metadata in ${directory}`);
  return value;
}

async function projectPackage(name: string, root: string, boundary: string) {
  for (let directory = root; ; directory = dirname(directory)) {
    const path = join(directory, "node_modules", name);
    const metadata = await readPackage(path);
    if (metadata) return { directory: path, metadata };
    if (directory === boundary || dirname(directory) === directory) return undefined;
  }
}

async function frameworkRange(framework: string, root: string, boundary: string): Promise<string> {
  const installed = await projectPackage(framework, root, boundary);
  if (installed) return installed.metadata.version;
  for (let directory = root; ; directory = dirname(directory)) {
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (!Value.Check(ManifestSchema, value))
        throw new Error(`Invalid dependencies in ${directory}`);
      const range = value.dependencies?.[framework] ?? value.devDependencies?.[framework];
      if (range !== undefined) {
        if (!validRange(range))
          throw new Error(
            `Cannot determine ${framework} compatibility from ${range}; prepare the project dependency or configure an explicit formatter`,
          );
        return range;
      }
    } catch (error) {
      if (!Value.Check(Type.Object({ code: Type.Literal("ENOENT") }), error)) throw error;
    }
    if (directory === boundary || dirname(directory) === directory) return "*";
  }
}

async function prettierPackage(executable: string, required: boolean) {
  let path: string;
  try {
    path = nodeModule.createRequire(await realpath(executable)).resolve("prettier/package.json");
  } catch (cause) {
    if (!required) return undefined; // Ordinary files retain opaque CLI wrapper ownership.
    throw new Error(
      "Framework formatting needs a discoverable Prettier module; configure an explicit formatter for opaque wrapper commands",
      { cause },
    );
  }
  const directory = dirname(path);
  const metadata = await readPackage(directory);
  if (metadata?.name !== "prettier")
    throw new Error(`Invalid selected Prettier module: ${directory}`);
  return { directory, metadata };
}

function compatible(
  metadata: NpmPackage,
  framework: string,
  constraint: PluginCompatibility,
): boolean {
  const peers = metadata.peerDependencies;
  return (
    metadata.name === `prettier-plugin-${framework}` &&
    !!peers?.prettier &&
    satisfies(constraint.prettier, peers.prettier) &&
    (constraint.framework === "*" ||
      (framework === "astro" && !peers.astro) ||
      (!!peers[framework] && subset(constraint.framework, peers[framework]))) &&
    (!metadata.engines?.node || satisfies(constraint.node, metadata.engines.node))
  );
}

function selectionId(framework: string, constraint: PluginCompatibility): string {
  // ponytail: reversible compatibility fits one receipt filename; add owner metadata
  // to receipts if unusually long dependency ranges need managed selections.
  const id = `formatter-plugin-${framework}-${Buffer.from(JSON.stringify(constraint)).toString("hex")}`;
  if (id.length > 230)
    throw new Error(
      "Framework compatibility declaration is too long; use an installed project plugin or explicit formatter",
    );
  return id;
}

async function pluginRequest(
  framework: string,
  constraint: PluginCompatibility,
  installer: ToolInstaller,
  options: InstallationOptions,
): Promise<ToolRequest> {
  const name = `prettier-plugin-${framework}`;
  const candidate = (await installer.npmVersions(name, options))
    .filter(
      (metadata) =>
        valid(metadata.version) &&
        !metadata.version.includes("-") &&
        compatible(metadata, framework, constraint),
    )
    .sort((left, right) => rcompare(left.version, right.version))[0];
  if (!candidate)
    throw new Error(
      `No compatible ${name} for Prettier ${constraint.prettier}, ${framework} ${constraint.framework}, Node ${constraint.node}; configure an explicit formatter`,
    );
  return {
    id: selectionId(framework, constraint),
    requirements: { node: "core:node", plugin: `npm:${name}@${candidate.version}` },
  };
}

async function managedPlugin(
  framework: string,
  constraint: PluginCompatibility,
  installer: ToolInstaller,
  options: InstallationOptions & { allowDownload: boolean },
) {
  const id = selectionId(framework, constraint);
  let installation = await installer.installed(id);
  if (!installation) {
    for (const donor of await installer.list()) {
      if (!donor.id.startsWith(`formatter-plugin-${framework}-`) || !donor.components.plugin)
        continue;
      const directory = join(
        donor.components.plugin.directory,
        "node_modules",
        `prettier-plugin-${framework}`,
      );
      const metadata = await readPackage(directory);
      if (metadata && compatible(metadata, framework, constraint)) return { directory, metadata };
    }
    if (!options.allowDownload)
      throw new Error(
        `No installed compatible prettier-plugin-${framework} for Prettier ${constraint.prettier}; provide a project plugin or enable automatic downloads`,
      );
    installation = await installer.ensure(
      await pluginRequest(framework, constraint, installer, options),
      options,
    );
  }
  const component = installation.components.plugin;
  if (!component) throw new Error(`Missing curated plugin in ${id}`);
  const directory = join(component.directory, "node_modules", `prettier-plugin-${framework}`);
  const metadata = await readPackage(directory);
  if (!metadata || !compatible(metadata, framework, constraint))
    throw new Error(
      `Incompatible managed prettier-plugin-${framework}; the selected formatter was not replaced`,
    );
  return { directory, metadata };
}

const hookRange = "^22.15.0 || >=23.5.0";

async function helperRequest(
  range: string,
  installer: ToolInstaller,
  options: InstallationOptions,
): Promise<ToolRequest> {
  const id = `formatter-prettier-helper-${Buffer.from(range).toString("hex")}`;
  if (!validRange(range) || id.length > 230)
    throw new Error("Invalid or oversized Prettier helper compatibility declaration");
  const candidate = (await installer.npmVersions("node", options))
    .filter(
      (pkg) =>
        valid(pkg.version) &&
        !pkg.version.includes("-") &&
        satisfies(pkg.version, hookRange) &&
        satisfies(pkg.version, range),
    )
    .sort((a, b) => rcompare(a.version, b.version))[0];
  if (!candidate)
    throw new Error(
      `Pi Formatter cannot provide a compatible module.registerHooks helper for Prettier (Node ${range}); configure an explicit formatter`,
    );
  return { id, requirements: { node: `core:node@${candidate.version}` } };
}

async function helperNode(
  definition: FormatterDefinition,
  current: string,
  range: string,
  cwd: string,
  installer: ToolInstaller,
  options: InstallationOptions & { allowDownload: boolean; timeoutMs?: number },
): Promise<string> {
  const checked = new Set([current]);
  const compatibleRuntime = async (command: string) => {
    if (checked.has(command)) return false;
    checked.add(command);
    let stdout = "";
    const failure = await runFormatterCommand(
      { ...definition, command },
      [
        "-e",
        "console.log('PI_FORMATTER_RUNTIME='+JSON.stringify({node:process.versions.node,hooks:typeof require('node:module').registerHooks==='function'}))",
      ],
      cwd,
      options.timeoutMs ?? 30_000,
      options.signal,
      undefined,
      (output) => {
        stdout = output;
      },
    );
    options.signal?.throwIfAborted();
    if (failure) return false;
    let value: unknown;
    try {
      value = JSON.parse(stdout.match(/^PI_FORMATTER_RUNTIME=(.+)$/m)?.[1] ?? "null");
    } catch {
      return false;
    }
    return (
      Value.Check(Type.Object({ node: Type.String(), hooks: Type.Literal(true) }), value) &&
      !!valid(value.node) &&
      satisfies(value.node, hookRange) &&
      satisfies(value.node, range)
    );
  };
  if (await compatibleRuntime(process.execPath)) return process.execPath;
  for (const installation of await installer.list()) {
    for (const component of Object.values(installation.components)) {
      if (!/^core:node(?:@|$)/u.test(component.selector)) continue;
      const candidate = join(
        component.directory,
        process.platform === "win32" ? "node.exe" : "bin/node",
      );
      if (await compatibleRuntime(candidate)) return candidate;
    }
  }
  if (!options.allowDownload)
    throw new Error(
      "No installed compatible Prettier Node helper; enable automatic downloads or configure an explicit formatter",
    );
  const installed = await installer.ensure(await helperRequest(range, installer, options), options);
  const node = join(
    installed.components.node!.directory,
    process.platform === "win32" ? "node.exe" : "bin/node",
  );
  if (!(await compatibleRuntime(node)))
    throw new Error("Managed Prettier Node helper is incompatible; run /formatter update prettier");
  return node;
}

/** Reconstruct only this owner's compatibility identity, for explicit updates. */
export async function prettierCompanionUpdateRequest(
  installation: ManagedInstallation,
  installer: ToolInstaller,
  options: InstallationOptions,
): Promise<ToolRequest | undefined> {
  const helper = installation.id.match(/^formatter-prettier-helper-([a-f0-9]+)$/);
  if (helper)
    return helperRequest(Buffer.from(helper[1]!, "hex").toString("utf8"), installer, options);
  const match = installation.id.match(/^formatter-plugin-(svelte|astro)-([a-f0-9]+)$/);
  if (!match) return undefined;
  const value: unknown = JSON.parse(Buffer.from(match[2]!, "hex").toString("utf8"));
  if (
    !Value.Check(CompatibilitySchema, value) ||
    !valid(value.prettier) ||
    !valid(value.node) ||
    !validRange(value.framework)
  )
    throw new Error(`Invalid plugin compatibility identity: ${installation.id}`);
  return pluginRequest(match[1]!, value, installer, options);
}

/** Framework execution keeps the selected Prettier and only supplies curated plugins. */
export async function withPrettierPlugin(
  definition: FormatterDefinition,
  framework: "svelte" | "astro" | undefined,
  file: string,
  root: string,
  projectRoot: string,
  formatterRoot: string,
  node: string,
  installer: ToolInstaller,
  options: InstallationOptions & { allowDownload: boolean; timeoutMs?: number },
): Promise<FormatterDefinition> {
  const prettier = await prettierPackage(
    definition.args.length === 3 ? definition.args[0]! : definition.command,
    framework !== undefined,
  );
  if (!prettier) return definition;
  const prettierEntry = nodeModule
    .createRequire(join(prettier.directory, "package.json"))
    .resolve(prettier.directory);
  const plugins: Record<string, string> = {};
  // At most one runtime upgrade and one discovery per curated import.
  for (let attempt = 0; attempt < 4; attempt++) {
    let stdout = "";
    const failure = await runFormatterCommand(
      { ...definition, command: node },
      [runnerPath, "inspect", prettierEntry, JSON.stringify(plugins), file, framework ?? ""],
      formatterRoot,
      options.timeoutMs ?? 30_000,
      options.signal,
      undefined,
      (output) => {
        stdout = output;
      },
    );
    if (failure) throw new Error(formatFormatterFailure(definition, file, failure));
    const info = stdout.match(/^PI_FORMATTER_INFO=(.+)$/m)?.[1];
    if (!info) throw new Error("Prettier configuration inspection returned no result");
    const result: unknown = JSON.parse(info);
    if (!Value.Check(InspectSchema, result) || !valid(result.node))
      throw new Error("Invalid Prettier configuration inspection");
    if (
      !result.ignored &&
      (result.needsHooks ||
        (prettier.metadata.engines?.node &&
          !satisfies(result.node, prettier.metadata.engines.node)))
    ) {
      node = await helperNode(
        definition,
        node,
        prettier.metadata.engines?.node ?? "*",
        formatterRoot,
        installer,
        options,
      );
      continue;
    }
    const selectedFramework = result.framework ?? framework;
    if (!result.ignored) {
      const frameworks = new Set([
        ...(selectedFramework ? [selectedFramework] : []),
        ...result.plugins
          .filter((name) => name === "prettier-plugin-svelte" || name === "prettier-plugin-astro")
          .map((name) => name.slice("prettier-plugin-".length)),
      ]);
      for (const selected of frameworks) {
        if (plugins[`prettier-plugin-${selected}`]) continue;
        const constraint = {
          prettier: prettier.metadata.version,
          framework: await frameworkRange(selected, root, projectRoot),
          node: result.node,
        };
        const name = `prettier-plugin-${selected}`;
        const project = await projectPackage(name, root, projectRoot);
        const plugin =
          project && compatible(project.metadata, selected, constraint)
            ? project
            : await managedPlugin(selected, constraint, installer, options);
        plugins[name] = nodeModule
          .createRequire(join(plugin.directory, "package.json"))
          .resolve(plugin.directory);
      }
    }
    if (result.pending) continue;
    if (!selectedFramework && !result.ignored && Object.keys(plugins).length === 0)
      return definition;
    return {
      ...definition,
      command: node,
      args: [
        runnerPath,
        "format",
        prettierEntry,
        JSON.stringify(plugins),
        "$FILE",
        selectedFramework ?? "",
      ],
    };
  }
  throw new Error("Prettier curated plugin discovery did not settle");
}
