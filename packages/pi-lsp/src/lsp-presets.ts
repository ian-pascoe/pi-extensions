import { createHash } from "node:crypto";
import { resolveDenoExecutable } from "@ian-pascoe/pi-utils";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { readFile, readdir, realpath } from "node:fs/promises";
import {
  findLspExecutable,
  inspectLspExecutable,
  lspExecutableDirectories,
  lspAncestorPaths as ancestors,
} from "./lsp-executables.js";
import { delimiter, dirname, join, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  ToolInstaller,
  type InstallationOptions,
  type ManagedInstallation,
  type ToolRequest,
} from "@ian-pascoe/pi-tool-installer";
import type { LspServerDefinition, ResolvedLspSettings } from "./pi-lsp-settings.js";
import {
  ESLINT_SERVER_SELECTOR,
  isOfficialEslintServer,
  prepareCompanionPreset,
} from "./lsp-companions.js";
import { prepareFrameworkPreset, SVELTE_SERVER_SELECTOR } from "./lsp-frameworks.js";

const SCRIPT_LANGUAGES: LspServerDefinition["languages"] = [
  { extensions: [".ts", ".mts", ".cts"], fileNames: [], languageId: "typescript" },
  { extensions: [".tsx"], fileNames: [], languageId: "typescriptreact" },
  { extensions: [".js", ".mjs", ".cjs"], fileNames: [], languageId: "javascript" },
  { extensions: [".jsx"], fileNames: [], languageId: "javascriptreact" },
];

interface LspPreset extends Pick<
  LspServerDefinition,
  "id" | "command" | "args" | "languages" | "rootMarkers"
> {
  requirements: Record<string, string>;
  requireRootMarker?: boolean;
  diagnosticMode?: "push";
  settings?: NonNullable<LspServerDefinition["settings"]>;
  script?: string;
}

/** Package-owned language behavior, independent of acquisition metadata. */
export const LSP_PRESETS: readonly LspPreset[] = [
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
  {
    id: "vue",
    command: "vue-language-server",
    args: ["--stdio"],
    languages: [{ extensions: [".vue"], fileNames: [], languageId: "vue" }, ...SCRIPT_LANGUAGES],
    rootMarkers: ["vue.config.*", "tsconfig.json", "jsconfig.json", "package.json", ".git"],
    requirements: { node: "core:node", server: "npm:@vue/language-server" },
  },
  {
    id: "svelte",
    command: "svelteserver",
    args: ["--stdio"],
    languages: [{ extensions: [".svelte"], fileNames: [], languageId: "svelte" }],
    rootMarkers: ["svelte.config.*", "package.json", ".git"],
    requirements: { node: "core:node", server: SVELTE_SERVER_SELECTOR },
  },
  {
    id: "astro",
    command: "astro-ls",
    args: ["--stdio"],
    languages: [{ extensions: [".astro"], fileNames: [], languageId: "astro" }],
    rootMarkers: ["astro.config.*", "package.json", ".git"],
    requirements: { node: "core:node", server: "npm:@astrojs/language-server" },
  },
  {
    id: "html",
    command: "vscode-html-language-server",
    args: ["--stdio"],
    languages: [{ extensions: [".html", ".htm"], fileNames: [], languageId: "html" }],
    rootMarkers: ["package.json", ".git"],
    requirements: { node: "core:node", server: "npm:vscode-langservers-extracted" },
    script: "node_modules/vscode-langservers-extracted/bin/vscode-html-language-server",
  },
  {
    id: "css",
    command: "vscode-css-language-server",
    args: ["--stdio"],
    languages: [
      { extensions: [".css"], fileNames: [], languageId: "css" },
      { extensions: [".scss"], fileNames: [], languageId: "scss" },
      { extensions: [".less"], fileNames: [], languageId: "less" },
    ],
    rootMarkers: ["package.json", ".git"],
    requirements: { node: "core:node", server: "npm:vscode-langservers-extracted" },
    script: "node_modules/vscode-langservers-extracted/bin/vscode-css-language-server",
    settings: { css: {}, scss: {}, less: {} },
  },
  {
    id: "json",
    command: "vscode-json-language-server",
    args: ["--stdio"],
    languages: [
      { extensions: [".json"], fileNames: [], languageId: "json" },
      { extensions: [".jsonc"], fileNames: [], languageId: "jsonc" },
    ],
    rootMarkers: ["package.json", ".git"],
    requirements: { node: "core:node", server: "npm:vscode-langservers-extracted" },
    script: "node_modules/vscode-langservers-extracted/bin/vscode-json-language-server",
    settings: { json: { validate: { enable: true } } },
  },
  {
    id: "yaml",
    command: "yaml-language-server",
    args: ["--stdio"],
    languages: [{ extensions: [".yaml", ".yml"], fileNames: [], languageId: "yaml" }],
    rootMarkers: ["package.json", ".git"],
    requirements: { node: "core:node", server: "npm:yaml-language-server" },
    script: "node_modules/yaml-language-server/bin/yaml-language-server",
    diagnosticMode: "push",
  },
  {
    id: "bash",
    command: "bash-language-server",
    args: ["start"],
    languages: [
      {
        extensions: [".sh", ".bash"],
        fileNames: [".bashrc", ".bash_profile", ".profile"],
        languageId: "shellscript",
      },
    ],
    rootMarkers: [".git"],
    requirements: { node: "core:node", server: "npm:bash-language-server" },
    script: "node_modules/bash-language-server/out/cli.js",
  },
  {
    id: "dockerfile",
    command: "docker-langserver",
    args: ["--stdio"],
    languages: [
      {
        extensions: [".dockerfile"],
        fileNames: ["Dockerfile", "Containerfile"],
        languageId: "dockerfile",
      },
    ],
    rootMarkers: ["Dockerfile", "Containerfile", ".git"],
    requirements: { node: "core:node", server: "npm:dockerfile-language-server-nodejs" },
    script: "node_modules/dockerfile-language-server-nodejs/bin/docker-langserver",
    diagnosticMode: "push",
  },
  {
    id: "terraform",
    command: "terraform-ls",
    args: ["serve"],
    languages: [{ extensions: [".tf", ".tfvars"], fileNames: [], languageId: "terraform" }],
    rootMarkers: [".terraform.lock.hcl", ".terraform", ".git"],
    requirements: { server: "aqua:hashicorp/terraform-ls" },
  },
  {
    id: "eslint",
    command: "vscode-eslint-language-server",
    args: ["--stdio"],
    languages: [
      ...SCRIPT_LANGUAGES,
      { extensions: [".vue"], fileNames: [], languageId: "vue" },
      { extensions: [".svelte"], fileNames: [], languageId: "svelte" },
      { extensions: [".astro"], fileNames: [], languageId: "astro" },
    ],
    rootMarkers: ["eslint.config.*", ".eslintrc*", "package.json"],
    requireRootMarker: true,
    requirements: { node: "core:node", server: ESLINT_SERVER_SELECTOR },
    script: "extension/server/out/eslintServer.js",
  },
  {
    id: "biome",
    command: "biome",
    args: ["lsp-proxy"],
    languages: [
      ...SCRIPT_LANGUAGES,
      { extensions: [".json", ".jsonc"], fileNames: [], languageId: "json" },
      { extensions: [".css"], fileNames: [], languageId: "css" },
      { extensions: [".graphql", ".gql"], fileNames: [], languageId: "graphql" },
    ],
    rootMarkers: ["biome.json", "biome.jsonc", "package.json"],
    requireRootMarker: true,
    requirements: { node: "core:node", server: "npm:@biomejs/biome" },
    script: "node_modules/@biomejs/biome/bin/biome",
  },
  {
    id: "oxlint",
    command: "oxlint",
    args: ["--lsp"],
    languages: SCRIPT_LANGUAGES,
    rootMarkers: [
      ".oxlintrc.json",
      ".oxlintrc.jsonc",
      "oxlint.config.ts",
      "oxlint.config.mts",
      "package.json",
    ],
    requireRootMarker: true,
    requirements: { node: "core:node", server: "npm:oxlint" },
    script: "node_modules/oxlint/bin/oxlint",
  },
  {
    id: "deno",
    command: "deno",
    args: ["lsp"],
    languages: [
      { extensions: [".ts", ".mts", ".cts"], fileNames: [], languageId: "typescript" },
      { extensions: [".tsx"], fileNames: [], languageId: "typescriptreact" },
      { extensions: [".js", ".mjs", ".cjs"], fileNames: [], languageId: "javascript" },
      { extensions: [".jsx"], fileNames: [], languageId: "javascriptreact" },
    ],
    rootMarkers: ["deno.json", "deno.jsonc"],
    requireRootMarker: true,
    requirements: { runtime: "core:deno" },
  },
];

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
    servers.set(preset.id, {
      ...preset,
      environment,
      preset: true,
      requireRootMarker: preset.requireRootMarker ?? false,
    });
  }
  return { ...settings, servers: new Map([...servers].sort(([a], [b]) => a.localeCompare(b))) };
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
  try {
    const output = await inspectLspExecutable(path, ["--version"], {
      environment,
      signal: options.signal,
      timeoutMs: 5000,
    });
    return /^Version\s+(?:[7-9]|\d{2,})\./u.test(output);
  } catch {
    options.signal?.throwIfAborted();
    return false;
  }
}

async function prepareBashPreset(
  definition: LspServerDefinition,
  root: string,
  installer: ToolInstaller,
  allowDownload: boolean,
  options: InstallationOptions,
): Promise<LspServerDefinition> {
  const environment = { ...definition.environment };
  const paths = lspExecutableDirectories(root, environment);
  const helpers: Record<string, string> = {};
  const unavailable: Record<string, string> = {};
  for (const [name, selector] of [
    ["shellcheck", "aqua:koalaman/shellcheck"],
    ["shfmt", "aqua:mvdan/sh"],
  ] as const) {
    let executable = await findLspExecutable(name, paths);
    if (!executable) {
      try {
        if (name === "shellcheck" && process.platform === "win32")
          throw new Error(
            `Managed ShellCheck is not verified for ${process.platform}/${process.arch}`,
          );
        const previous = await installer.installed("lsp-bash");
        const requirements = Object.fromEntries(
          Object.entries(previous?.components ?? {}).map(([key, value]) => [key, value.selector]),
        );
        requirements[name] = selector;
        const installation = await installer.ensure(
          { id: "lsp-bash", requirements },
          { ...options, allowDownload },
        );
        executable = await findLspExecutable(name, installation.binDirectories);
        if (!executable) throw new Error(`Managed ${name} executable is missing`);
      } catch (error) {
        options.signal?.throwIfAborted();
        unavailable[name] =
          `Pi LSP: ${name} ${name === "shellcheck" ? "diagnostics" : "formatting"} unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    helpers[name] = executable ?? "";
  }
  environment.SHELLCHECK_PATH = helpers.shellcheck!;
  environment.SHFMT_PATH = helpers.shfmt!;
  const result: LspServerDefinition = {
    ...definition,
    environment,
    diagnosticMode: "push",
    settings: { bashIde: { shellcheckPath: helpers.shellcheck!, shfmt: { path: helpers.shfmt! } } },
  };
  return {
    ...result,
    unavailableDiagnostics: unavailable.shellcheck,
    unavailableFormatting: unavailable.shfmt,
  };
}

const ProjectManifestSchema = Type.Object({
  dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
  devDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
  peerDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
  eslintConfig: Type.Optional(Type.Unknown()),
});

/** Read declarations only; discovery must never execute project configuration or acquire tools. */
export async function declaredLspProjectTools(root: string): Promise<ReadonlySet<string>> {
  const declared = new Set<string>();
  for (const directory of ancestors(root)) {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    if (entries.includes("package.json")) {
      try {
        const manifest: unknown = JSON.parse(
          await readFile(join(directory, "package.json"), "utf8"),
        );
        if (Value.Check(ProjectManifestSchema, manifest)) {
          const dependencies = {
            ...manifest.dependencies,
            ...manifest.devDependencies,
            ...manifest.peerDependencies,
          };
          for (const [id, name] of [
            ["eslint", "eslint"],
            ["biome", "@biomejs/biome"],
            ["oxlint", "oxlint"],
            ["vue", "vue"],
          ])
            if (dependencies[name!] !== undefined) declared.add(id!);
          if (manifest.eslintConfig !== undefined) declared.add("eslint");
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    if (
      entries.some((entry) =>
        /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.(?:json|ya?ml|[cm]?js))?)$/u.test(entry),
      )
    )
      declared.add("eslint");
    if (
      entries.some((entry) =>
        [".oxlintrc.json", ".oxlintrc.jsonc", "oxlint.config.ts", "oxlint.config.mts"].includes(
          entry,
        ),
      )
    )
      declared.add("oxlint");
    const biomeFile = ["biome.json", "biome.jsonc"].find((name) => entries.includes(name));
    // Declaration is not effective enablement: the native server owns overrides,
    // language settings, nested/extended configuration and ignored files.
    if (biomeFile) declared.add("biome");
  }
  return declared;
}

const DenoConfigurationSchema = Type.Object({
  nodeModulesDir: Type.Optional(
    Type.Union([
      Type.Literal("auto"),
      Type.Literal("manual"),
      Type.Literal("none"),
      Type.Boolean(),
    ]),
  ),
  vendor: Type.Optional(Type.Boolean()),
  workspace: Type.Optional(Type.Array(Type.String())),
});

async function assertDenoNoProjectWrites(root: string, seen = new Set<string>()): Promise<void> {
  root = resolve(root);
  if (seen.has(root)) return;
  seen.add(root);
  for (const name of ["deno.json", "deno.jsonc"]) {
    let text: string;
    try {
      text = await readFile(join(root, name), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    const errors: ParseError[] = [];
    const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length || !Value.Check(DenoConfigurationSchema, value))
      throw new Error(`Pi LSP: cannot validate Deno configuration ${join(root, name)}`);
    if (value.nodeModulesDir === "auto" || value.nodeModulesDir === true || value.vendor === true)
      throw new Error(
        "Pi LSP: Deno configuration requests automatic dependency writes (nodeModulesDir/vendor). Prepare dependencies manually and use a non-writing project configuration or an Explicit Definition.",
      );
    for (const member of value.workspace ?? []) {
      if (/[?*[\]{}]/u.test(member))
        throw new Error(
          "Pi LSP: cannot verify automatic dependency writes for a Deno workspace glob; use an Explicit Definition.",
        );
      await assertDenoNoProjectWrites(resolve(root, member), seen);
    }
    return;
  }
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
  if (["vue", "svelte", "astro"].includes(definition.id))
    return prepareFrameworkPreset(definition, root, installer, allowDownload, options);
  const preset = LSP_PRESETS.find(({ id }) => id === definition.id);
  if (!preset) throw new Error(`Pi LSP: unknown preset ${definition.id}`);
  options.signal?.throwIfAborted();
  if (preset.id === "deno") await assertDenoNoProjectWrites(root);
  const pathKey =
    Object.keys(definition.environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const paths = lspExecutableDirectories(root, definition.environment);
  const nativeTypeScript = (path: string) =>
    isNativeTypeScript(
      path,
      { ...definition.environment, [pathKey]: paths.join(delimiter) },
      options,
    );
  let denoExecutable: string | undefined;
  const externalCandidate = await findLspExecutable(
    preset.command,
    paths,
    preset.id === "typescript"
      ? nativeTypeScript
      : preset.id === "eslint"
        ? isOfficialEslintServer
        : preset.id === "deno"
          ? async (candidate) => {
              denoExecutable = await resolveDenoExecutable(candidate);
              return denoExecutable !== undefined;
            }
          : undefined,
  );
  const externalServer = preset.id === "deno" ? denoExecutable : externalCandidate;
  const runtimeName =
    preset.id === "gopls"
      ? "go"
      : preset.id === "rust-analyzer"
        ? "rustc"
        : preset.requirements.node
          ? "node"
          : undefined;
  const runtimeKey = runtimeName === "rustc" ? "rust" : runtimeName;
  const externalRuntime = runtimeName ? await findLspExecutable(runtimeName, paths) : undefined;
  const externalCargo =
    preset.id === "rust-analyzer" ? await findLspExecutable("cargo", paths) : undefined;
  const requirements: Record<string, string> = {};
  if (runtimeKey && (!externalRuntime || (preset.id === "rust-analyzer" && !externalCargo)))
    requirements[runtimeKey] = preset.requirements[runtimeKey] ?? "";
  const serverKey =
    preset.id === "typescript" ? "compiler" : preset.id === "deno" ? "runtime" : "server";
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
        requirements: Object.fromEntries([
          ...Object.entries(preset.requirements)
            .filter(([key]) => requirements[key] !== undefined || retained[key] !== undefined)
            .map(([key, selector]) => [key, retained[key] ?? selector]),
          ...Object.entries(retained).filter(([key]) => !(key in preset.requirements)),
        ]),
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
  environment[pathKey] = [...runtimePaths, ...paths, ...(installation?.binDirectories ?? [])].join(
    delimiter,
  );
  let command = externalServer;
  let args = [...preset.args];
  if (!command && installation) {
    if (preset.script || preset.id === "typescript" || preset.id === "pyright") {
      command =
        externalRuntime ??
        join(
          component(installation, "node"),
          process.platform === "win32" ? "node.exe" : "bin/node",
        );
      const script =
        preset.script ??
        (preset.id === "typescript"
          ? "node_modules/typescript/bin/tsc"
          : "node_modules/pyright/langserver.index.js");
      args = [join(component(installation, serverKey), script), ...args];
    } else {
      command = await findLspExecutable(preset.command, installation.binDirectories);
    }
  }
  if (!command)
    throw new Error(
      `Pi LSP: ${preset.id} executable unavailable; configure lsp.servers.${preset.id} or enable lsp.autoInstall, then use lsp restart.`,
    );
  if (preset.id === "deno") {
    const cache = join(
      installer.directory,
      "lsp-cache",
      `deno-${createHash("sha256").update(resolve(root)).digest("hex")}`,
    );
    environment.DENO_DIR = cache;
    const deno = { enable: true, cacheOnSave: false, cache };
    return {
      ...definition,
      command,
      args,
      environment,
      initializationOptions: deno,
      settings: { deno, javascript: {}, typescript: {} },
    };
  }
  if (preset.id === "bash")
    return prepareBashPreset(
      { ...definition, command, args, environment },
      root,
      installer,
      allowDownload,
      options,
    );
  return prepareCompanionPreset(
    { ...definition, command, args, environment },
    root,
    installer,
    allowDownload,
    options,
  );
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
