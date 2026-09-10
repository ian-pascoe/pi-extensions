import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import {
  type ToolInstaller,
  type InstallationOptions,
  type ManagedInstallation,
  type ToolRequest,
} from "@ian-pascoe/pi-tool-installer";
import { parse as parseToml } from "smol-toml";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { FormatterDefinition } from "./pi-formatter-settings.js";

const ObjectSchema = Type.Record(Type.String(), Type.Unknown());
const DependencySchema = Type.Record(Type.String(), Type.String());
const PackageSchema = Type.Object({
  prettier: Type.Optional(Type.Union([Type.String(), ObjectSchema])),
  dependencies: Type.Optional(DependencySchema),
  devDependencies: Type.Optional(DependencySchema),
});

export const formatterPresetIds = [
  "prettier",
  "biome",
  "black",
  "ruff",
  "gofmt",
  "rustfmt",
] as const;
export type FormatterPresetId = (typeof formatterPresetIds)[number];

function* ancestors(path: string): Generator<string> {
  let directory = path;
  for (;;) {
    yield directory;
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (
      Value.Check(
        Type.Object({ code: Type.Union([Type.Literal("ENOENT"), Type.Literal("ENOTDIR")]) }),
        error,
      )
    )
      return false;
    throw error;
  }
}

async function jsMarkers(root: string): Promise<FormatterPresetId[]> {
  const markers = new Set<FormatterPresetId>();
  for (const name of [
    ".prettierrc",
    ...["json", "json5", "yml", "yaml", "toml", "js", "cjs", "mjs", "ts", "cts", "mts"].map(
      (extension) => `.prettierrc.${extension}`,
    ),
    ...["js", "cjs", "mjs", "ts", "cts", "mts"].map((extension) => `prettier.config.${extension}`),
  ]) {
    if (await fileExists(join(root, name))) markers.add("prettier");
  }
  for (const name of ["biome.json", "biome.jsonc"]) {
    if (await fileExists(join(root, name))) markers.add("biome");
  }
  if (await fileExists(join(root, "package.json"))) {
    const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (!Value.Check(PackageSchema, manifest))
      throw new Error(`Invalid formatter declarations in ${join(root, "package.json")}`);
    if (
      manifest.prettier !== undefined ||
      manifest.dependencies?.prettier !== undefined ||
      manifest.devDependencies?.prettier !== undefined
    )
      markers.add("prettier");
    if (
      manifest.dependencies?.["@biomejs/biome"] !== undefined ||
      manifest.devDependencies?.["@biomejs/biome"] !== undefined
    )
      markers.add("biome");
  }
  return [...markers];
}

const PythonSchema = Type.Object({
  tool: Type.Optional(
    Type.Object({
      black: Type.Optional(ObjectSchema),
      ruff: Type.Optional(ObjectSchema),
      poetry: Type.Optional(
        Type.Object({
          dependencies: Type.Optional(ObjectSchema),
          "dev-dependencies": Type.Optional(ObjectSchema),
          group: Type.Optional(
            Type.Record(Type.String(), Type.Object({ dependencies: Type.Optional(ObjectSchema) })),
          ),
        }),
      ),
      uv: Type.Optional(
        Type.Object({ "dev-dependencies": Type.Optional(Type.Array(Type.String())) }),
      ),
    }),
  ),
  project: Type.Optional(
    Type.Object({
      dependencies: Type.Optional(Type.Array(Type.String())),
      "optional-dependencies": Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
    }),
  ),
  "dependency-groups": Type.Optional(
    Type.Record(
      Type.String(),
      Type.Array(Type.Union([Type.String(), Type.Object({ "include-group": Type.String() })])),
    ),
  ),
});

async function pythonMarkers(root: string): Promise<FormatterPresetId[]> {
  const markers = new Set<FormatterPresetId>();
  for (const name of ["ruff.toml", ".ruff.toml"]) {
    if (await fileExists(join(root, name))) markers.add("ruff");
  }
  if (await fileExists(join(root, "pyproject.toml"))) {
    const manifest: unknown = parseToml(await readFile(join(root, "pyproject.toml"), "utf8"));
    if (!Value.Check(PythonSchema, manifest))
      throw new Error(`Invalid formatter declarations in ${join(root, "pyproject.toml")}`);
    if (manifest.tool?.black) markers.add("black");
    if (manifest.tool?.ruff) markers.add("ruff");
    const poetry = manifest.tool?.poetry;
    const dependencies = [
      ...(manifest.project?.dependencies ?? []),
      ...Object.values(manifest.project?.["optional-dependencies"] ?? {}).flat(),
      ...Object.values(manifest["dependency-groups"] ?? {})
        .flat()
        .filter((value) => Value.Check(Type.String(), value)),
      ...(manifest.tool?.uv?.["dev-dependencies"] ?? []),
      ...Object.keys(poetry?.dependencies ?? {}),
      ...Object.keys(poetry?.["dev-dependencies"] ?? {}),
      ...Object.values(poetry?.group ?? {}).flatMap((group) =>
        Object.keys(group.dependencies ?? {}),
      ),
    ];
    for (const dependency of dependencies) {
      // Parse the distribution name, not mentions inside comments, URLs, or other settings.
      const name = dependency
        .match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[|[<>=!~;@]|$)/)?.[1]
        ?.toLowerCase();
      if (name === "black" || name === "ruff") markers.add(name);
    }
  }
  return [...markers];
}

export async function selectFormatterPreset(
  path: string,
): Promise<{ id: FormatterPresetId; root: string } | undefined> {
  const extension = extname(path);
  if (extension === ".go" || extension === ".rs")
    return { id: extension === ".go" ? "gofmt" : "rustfmt", root: dirname(path) };
  const python = extension === ".py" || extension === ".pyi";
  if (
    !python &&
    ![".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"].includes(extension)
  )
    return undefined;
  for (const root of ancestors(dirname(path))) {
    const markers = await (python ? pythonMarkers(root) : jsMarkers(root));
    if (markers.length > 1)
      throw new Error(
        `Conflicting Formatter Markers at ${root}: ${markers.join(", ")}. Configure an explicit formatter choice.`,
      );
    const id = markers[0];
    if (id) return { id, root };
  }
  return undefined;
}

async function executable(path: string): Promise<boolean> {
  if (!(await fileExists(path))) return false;
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findNode(root: string): Promise<string | undefined> {
  const name = process.platform === "win32" ? "node.exe" : "node";
  for (const directory of ancestors(root)) {
    for (const relative of [join("node_modules", ".bin", name), join("bin", name)]) {
      const path = join(directory, relative);
      if (await executable(path)) return path;
    }
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const path = join(directory, name);
    if (await executable(path)) return path;
  }
  return undefined;
}

export function formatterRequest(id: FormatterPresetId): ToolRequest {
  const requirements = {
    prettier: { node: "core:node", formatter: "npm:prettier" },
    biome: { node: "core:node", formatter: "npm:@biomejs/biome" },
    black: { python: "core:python", uv: "aqua:astral-sh/uv", formatter: "pipx:black" },
    ruff: { formatter: "aqua:astral-sh/ruff" },
    gofmt: { go: "core:go" },
    rustfmt: { rust: "core:rust" },
  } satisfies Record<FormatterPresetId, ToolRequest["requirements"]>;
  return { id: `formatter-${id}`, requirements: requirements[id] };
}

function component(installation: ManagedInstallation, name: string): string {
  const value = installation.components[name];
  if (!value) throw new Error(`Missing managed ${name} component for ${installation.id}`);
  return value.directory;
}

const nativeName = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);
const pathDirectories = () => (process.env.PATH ?? "").split(delimiter).filter(Boolean);

async function externalFormatter(
  id: FormatterPresetId,
  root: string,
): Promise<{ command: string; script: boolean } | undefined> {
  const script =
    id === "prettier"
      ? "prettier/bin/prettier.cjs"
      : id === "biome"
        ? "@biomejs/biome/bin/biome"
        : undefined;
  const names = process.platform === "win32" ? [`${id}.exe`, `${id}.cmd`] : [id];
  for (const directory of ancestors(root)) {
    if (script) {
      const path = join(directory, "node_modules", script);
      if (await fileExists(path)) return { command: path, script: true };
    }
    for (const bin of [
      "node_modules/.bin",
      ".venv/bin",
      ".venv/Scripts",
      "venv/bin",
      "venv/Scripts",
      "bin",
      ".cargo/bin",
    ]) {
      for (const name of names) {
        const path = join(directory, bin, name);
        if (await executable(path)) return { command: path, script: false };
      }
    }
  }
  for (const directory of pathDirectories()) {
    for (const name of names) {
      const path = join(directory, name);
      if (await executable(path)) return { command: path, script: false };
    }
  }
  return undefined;
}

const CargoSchema = Type.Object({
  package: Type.Optional(
    Type.Object({
      edition: Type.Optional(
        Type.Union([Type.String(), Type.Object({ workspace: Type.Literal(true) })]),
      ),
      workspace: Type.Optional(Type.String()),
    }),
  ),
  workspace: Type.Optional(
    Type.Object({ package: Type.Optional(Type.Object({ edition: Type.Optional(Type.String()) })) }),
  ),
});

async function readCargo(root: string) {
  const path = join(root, "Cargo.toml");
  const manifest: unknown = parseToml(await readFile(path, "utf8"));
  if (!Value.Check(CargoSchema, manifest))
    throw new Error(`Invalid Rust edition declaration in ${path}`);
  return manifest;
}

async function rustEdition(root: string): Promise<string | undefined> {
  for (const directory of ancestors(root)) {
    let found = false;
    for (const name of [".rustfmt.toml", "rustfmt.toml"]) {
      const path = join(directory, name);
      if (!(await fileExists(path))) continue;
      const config = parseToml(await readFile(path, "utf8"));
      if (config.edition !== undefined) return undefined; // The native formatter owns its config.
      found = true;
      break;
    }
    if (found) break;
  }
  for (const directory of ancestors(root)) {
    if (!(await fileExists(join(directory, "Cargo.toml")))) continue;
    const manifest = await readCargo(directory);
    const edition = manifest.package?.edition;
    if (edition === undefined || Value.Check(Type.String(), edition)) return edition;
    const workspace = manifest.package?.workspace;
    const roots = workspace === undefined ? ancestors(directory) : [resolve(directory, workspace)];
    for (const workspaceRoot of roots) {
      if (!(await fileExists(join(workspaceRoot, "Cargo.toml")))) continue;
      const workspaceManifest = await readCargo(workspaceRoot);
      if (!workspaceManifest.workspace) continue;
      const inherited = workspaceManifest.workspace.package?.edition;
      if (inherited) return inherited;
      break;
    }
    throw new Error(`Cannot resolve inherited Rust edition from ${join(directory, "Cargo.toml")}`);
  }
  return undefined;
}

export async function resolvePresetDefinition(
  id: FormatterPresetId,
  root: string,
  installer: ToolInstaller,
  options: InstallationOptions & { allowDownload: boolean },
): Promise<FormatterDefinition> {
  options.signal?.throwIfAborted();
  const external = await externalFormatter(id, root);
  let installation: ManagedInstallation | undefined;
  const javascript = id === "prettier" || id === "biome";
  let node = javascript ? await findNode(root) : undefined;
  if (!external) {
    let request = formatterRequest(id);
    if (javascript && node && !(await installer.installed(request.id))?.components.node) {
      request = {
        ...request,
        requirements: Object.fromEntries(
          Object.entries(request.requirements).filter(([key]) => key !== "node"),
        ),
      };
    }
    installation = await installer.ensure(request, options);
  } else if (javascript && !node) {
    const installed = await installer.installed(`formatter-${id}`);
    if (installed?.components.node) installation = installed;
    else
      installation = await installer.ensure(
        installed?.components.formatter
          ? formatterRequest(id)
          : { id: `formatter-${id}`, requirements: { node: "core:node" } },
        options,
      );
  }
  if (javascript && !node && installation)
    node = join(
      component(installation, "node"),
      process.platform === "win32" ? "node.exe" : "bin/node",
    );
  const args =
    id === "prettier"
      ? ["--write", "$FILE"]
      : id === "biome"
        ? ["format", "--write", "$FILE"]
        : id === "ruff"
          ? ["format", "$FILE"]
          : id === "gofmt"
            ? ["-w", "$FILE"]
            : ["$FILE"];
  if (id === "rustfmt") {
    args.unshift("--config", "skip_children=true");
    const edition = await rustEdition(root);
    if (edition) args.unshift("--edition", edition);
  }
  let command: string;
  if (external) {
    command = external.command;
    if (external.script) {
      if (!node) throw new Error(`${id} needs a Node runtime`);
      args.unshift(command);
      command = node;
    }
  } else {
    if (!installation) throw new Error(`${id} is unavailable`);
    if (javascript) {
      if (!node) throw new Error(`${id} needs a Node runtime`);
      command = node;
      args.unshift(
        join(
          component(installation, "formatter"),
          "node_modules",
          id === "prettier" ? "prettier/bin/prettier.cjs" : "@biomejs/biome/bin/biome",
        ),
      );
    } else if (id === "black") {
      command = join(
        component(installation, "formatter"),
        process.platform === "win32" ? "black/Scripts/python.exe" : "black/bin/python",
      );
      args.unshift("-m", "black");
    } else if (id === "gofmt")
      command = join(component(installation, "go"), "bin", nativeName("gofmt"));
    else if (id === "rustfmt")
      command = join(component(installation, "rust"), nativeName("rustfmt"));
    else {
      const candidates = await Promise.all(
        installation.binDirectories.map(async (directory) => {
          const path = join(directory, nativeName("ruff"));
          return (await executable(path)) ? path : undefined;
        }),
      );
      const found = candidates.find((path) => path !== undefined);
      if (!found) throw new Error("Missing Ruff executable in the managed installation");
      command = found;
    }
  }
  const environment = {
    ...installation?.environment,
    PATH: [
      ...(node ? [dirname(node)] : []),
      ...(installation?.binDirectories ?? []),
      ...pathDirectories(),
    ].join(delimiter),
  };
  return {
    id,
    command,
    args,
    environment,
    extensions: [],
    fileNames: [],
    requireRootMarker: false,
    rootMarkers: [],
  };
}
