import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DefaultPackageManager,
  discoverAndLoadExtensions,
  loadSkills,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  getNodeProcessErrorStderr,
  hasNodeProcessErrorCode,
  parseNodeProcessError,
} from "./node-process-error.mjs";
import { assertCodeModeDenoProcessSmoke } from "./codemode-worker-smoke.mjs";
import { readJsonDocument, workspacePackageManifestSchema } from "./root-project-contract.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piMcpPackageName = "@ian-pascoe/pi-mcp";

function assertPackCondition(condition, message) {
  if (!condition) throw new Error(`Package pack check failed: ${message}`);
}

async function runCommand(command, args, options = {}) {
  try {
    return await execFile(command, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      ...options,
    });
  } catch (cause) {
    const processError = parseNodeProcessError(cause);
    throw new Error(
      `Package pack check command failed: ${command} ${args.join(" ")}\n${getNodeProcessErrorStderr(processError)}`,
      { cause },
    );
  }
}

async function discoverWorkspaceManifests() {
  const packagesDirectory = resolve(repositoryRoot, "packages");
  const entries = await readdir(packagesDirectory, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = resolve(packagesDirectory, entry.name, "package.json");
    try {
      manifests.push({
        manifest: await readJsonDocument(manifestPath, workspacePackageManifestSchema),
      });
    } catch (cause) {
      if (hasNodeProcessErrorCode(parseNodeProcessError(cause), "ENOENT")) continue;
      throw cause;
    }
  }
  manifests.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
  assertPackCondition(
    manifests.length === 12,
    `expected 12 workspace manifests, found ${manifests.length}`,
  );
  return manifests;
}

function parsePackJson(stdout, packageName) {
  const result = JSON.parse(stdout);
  if (Array.isArray(result)) {
    assertPackCondition(result.length === 1, `${packageName} returned invalid npm pack JSON`);
    return result[0];
  }
  const workspaceResults = Object.values(result);
  assertPackCondition(
    workspaceResults.length === 1,
    `${packageName} returned invalid workspace npm pack JSON`,
  );
  return workspaceResults[0];
}

function validatePackedFileList(packageName, files) {
  const paths = files.map((file) => file.path).sort();
  const packageSlug = packageName.split("/").at(-1);
  const requiredPaths = [
    "LICENSE",
    "README.md",
    "package.json",
    `skills/${packageSlug}/SKILL.md`,
    "src/index.ts",
  ];
  if (packageName === piMcpPackageName) requiredPaths.push("dist/pi-mcp-cli.js");
  for (const requiredPath of requiredPaths) {
    assertPackCondition(paths.includes(requiredPath), `${packageName} omits ${requiredPath}`);
  }
  for (const path of paths) {
    const allowed =
      path === "LICENSE" ||
      path === "README.md" ||
      path === "package.json" ||
      path.startsWith("skills/") ||
      path.startsWith("src/") ||
      (packageName === piMcpPackageName && path === "dist/pi-mcp-cli.js");
    assertPackCondition(allowed, `${packageName} unexpectedly packs ${path}`);
  }
}

function validatePackedManifest(sourceManifest, packedManifest) {
  const packageName = sourceManifest.name;
  for (const field of [
    "name",
    "version",
    "license",
    "author",
    "description",
    "homepage",
    "bugs",
    "repository",
    "publishConfig",
  ]) {
    assertPackCondition(
      JSON.stringify(packedManifest[field]) === JSON.stringify(sourceManifest[field]),
      `${packageName} changes manifest field ${field}`,
    );
  }
  assertPackCondition(
    JSON.stringify(packedManifest.pi?.extensions) === JSON.stringify(["./src/index.ts"]),
    `${packageName} has an invalid pi.extensions contract`,
  );
  assertPackCondition(
    JSON.stringify(packedManifest.pi?.skills) === JSON.stringify(["./skills"]),
    `${packageName} has an invalid pi.skills contract`,
  );
  if (packageName === piMcpPackageName) {
    assertPackCondition(
      packedManifest.bin?.["pi-mcp"] === "dist/pi-mcp-cli.js",
      `${packageName} has an invalid pi-mcp bin`,
    );
    assertPackCondition(
      packedManifest.scripts?.["build:cli"],
      `${packageName} omits its build:cli script`,
    );
    assertPackCondition(packedManifest.scripts?.prepack, `${packageName} omits its prepack script`);
  } else {
    assertPackCondition(!("bin" in packedManifest), `${packageName} contains a bin`);
    assertPackCondition(!packedManifest.scripts?.build, `${packageName} contains a build script`);
    assertPackCondition(
      !packedManifest.scripts?.["build:cli"],
      `${packageName} contains a build:cli script`,
    );
    assertPackCondition(
      !packedManifest.scripts?.prepack,
      `${packageName} contains a prepack script`,
    );
  }
  for (const forbiddenField of ["main", "types", "exports"]) {
    assertPackCondition(
      !(forbiddenField in packedManifest),
      `${packageName} contains ${forbiddenField}`,
    );
  }
  if (packageName === "@ian-pascoe/pi-codemode") {
    assertPackCondition(
      packedManifest.dependencies?.deno === "2.9.5" &&
        packedManifest.dependencies?.typescript === "6.0.3",
      `${packageName} does not pin its Deno-native TypeScript runtime`,
    );
    assertPackCondition(
      !Object.keys(packedManifest.dependencies ?? {}).some((name) => name.includes("quickjs")),
      `${packageName} still depends on QuickJS`,
    );
  }
}

async function assertTarballRunsPiMcpCli(packageName, installDirectory) {
  if (packageName !== piMcpPackageName) return;
  const { stdout } = await runCommand(
    resolve(installDirectory, "node_modules", ".bin", "pi-mcp"),
    ["--help"],
    { cwd: installDirectory },
  );
  assertPackCondition(stdout.startsWith("Usage: pi-mcp "), `${packageName} CLI omits help output`);
}

async function assertTarballLoads(packageName, tarballPath) {
  const installDirectory = await mkdtemp(resolve(tmpdir(), "pi-package-install-"));
  const agentDirectory = await mkdtemp(resolve(tmpdir(), "pi-package-agent-"));
  try {
    await writeFile(
      resolve(installDirectory, "package.json"),
      JSON.stringify({ name: "pi-package-pack-check", private: true, type: "module" }),
    );
    await runCommand(
      "npm",
      [
        "install",
        tarballPath,
        "--legacy-peer-deps",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: installDirectory },
    );
    const installedPackageDirectory = resolve(
      installDirectory,
      "node_modules",
      ...packageName.split("/"),
    );
    const entrypoint = resolve(installedPackageDirectory, "src/index.ts");
    const result = await discoverAndLoadExtensions([entrypoint], installDirectory, agentDirectory);
    assertPackCondition(
      result.errors.length === 0,
      `${packageName} installed entrypoint errors: ${JSON.stringify(result.errors)}`,
    );
    assertPackCondition(
      result.extensions.length === 1,
      `${packageName} installed entrypoint did not load exactly once`,
    );
    assertPackCondition(
      result.extensions[0]?.resolvedPath === entrypoint,
      `${packageName} resolved the wrong installed entrypoint`,
    );
    const resources = await new DefaultPackageManager({
      agentDir: agentDirectory,
      cwd: installDirectory,
      settingsManager: SettingsManager.inMemory(),
    }).resolveExtensionSources([installedPackageDirectory], { temporary: true });
    assertPackCondition(
      resources.skills.length === 1 &&
        resources.skills[0]?.path ===
          resolve(installedPackageDirectory, "skills", packageName.split("/").at(-1), "SKILL.md"),
      `${packageName} installed package did not expose its configuration skill`,
    );
    const loadedSkills = loadSkills({
      agentDir: agentDirectory,
      cwd: installDirectory,
      includeDefaults: false,
      skillPaths: resources.skills.map(({ path }) => path),
    });
    assertPackCondition(
      loadedSkills.diagnostics.length === 0 &&
        loadedSkills.skills.length === 1 &&
        loadedSkills.skills[0]?.name === packageName.split("/").at(-1),
      `${packageName} installed configuration skill did not load cleanly`,
    );
    if (packageName === "@ian-pascoe/pi-codemode") {
      await assertCodeModeDenoProcessSmoke(
        resolve(installedPackageDirectory, "src/codemode-worker.ts"),
        "installed package tarball",
      );
    }
    await assertTarballRunsPiMcpCli(packageName, installDirectory);
  } finally {
    await Promise.all([
      rm(installDirectory, { recursive: true, force: true }),
      rm(agentDirectory, { recursive: true, force: true }),
    ]);
  }
}

const packDirectory = await mkdtemp(resolve(tmpdir(), "pi-package-packs-"));
try {
  const workspaces = await discoverWorkspaceManifests();
  for (const { manifest } of workspaces) {
    const packed = parsePackJson(
      (
        await runCommand("npm", [
          "pack",
          "--workspace",
          manifest.name,
          "--json",
          "--package-lock=false",
          "--pack-destination",
          packDirectory,
        ])
      ).stdout,
      manifest.name,
    );
    validatePackedFileList(manifest.name, packed.files);
    const tarballPath = resolve(packDirectory, basename(packed.filename));
    const packedManifestText = (
      await runCommand("tar", ["-xOf", tarballPath, "package/package.json"])
    ).stdout;
    validatePackedManifest(manifest, JSON.parse(packedManifestText));
    await assertTarballLoads(manifest.name, tarballPath);
    await rm(tarballPath, { force: true });
  }
} finally {
  await rm(packDirectory, { recursive: true, force: true });
}

console.log(
  "Validated twelve package tarballs, source entrypoints, configuration skills, and the Pi MCP CLI.",
);
