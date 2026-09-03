import { execFile as execFileCallback } from "node:child_process";
import { access, cp, mkdtemp, rm } from "node:fs/promises";
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
import {
  piSettingsDocumentSchema,
  readJsonDocument,
  rootPiManifestSchema,
} from "./root-project-contract.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piUtilsDistDirectory = resolve(repositoryRoot, "packages/pi-utils/dist");
const excludedDirectoryNames = new Set([".git", ".repos", "coverage", "dist", "node_modules"]);
const npmChildProcessEnvironment = { ...process.env };
delete npmChildProcessEnvironment.npm_config_manage_package_manager_versions;

function assertGitInstallCondition(condition, message) {
  if (!condition) throw new Error(`Git install check failed: ${message}`);
}

function includeWorkingTreePath(source) {
  const name = basename(source);
  if (source === piUtilsDistDirectory) return true;
  if (excludedDirectoryNames.has(name)) return false;
  if (name.endsWith(".tgz")) return false;
  return true;
}

async function runNpmProductionInstall(installDirectory) {
  try {
    await execFile(
      "npm",
      ["install", "--force", "--omit=dev", "--package-lock=false", "--no-audit", "--no-fund"],
      {
        cwd: installDirectory,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        env: {
          ...npmChildProcessEnvironment,
          NODE_ENV: "production",
          npm_config_omit: "dev",
        },
      },
    );
  } catch (cause) {
    const processError = parseNodeProcessError(cause);
    throw new Error(
      `Git install check npm install failed:\n${getNodeProcessErrorStderr(processError)}`,
      {
        cause,
      },
    );
  }
}

async function assertPackageExcludedFromProductionInstall(installDirectory, packagePath) {
  try {
    await access(resolve(installDirectory, "node_modules", packagePath, "package.json"));
    throw new Error(
      `Git install check failed: ${packagePath} is present in the production install`,
    );
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("Git install check failed:")) {
      throw cause;
    }
    if (!hasNodeProcessErrorCode(parseNodeProcessError(cause), "ENOENT")) {
      throw cause;
    }
  }
}

async function assertGitInstalledExtensionsLoad(installDirectory, agentDirectory) {
  const manifest = await readJsonDocument(
    resolve(installDirectory, "package.json"),
    rootPiManifestSchema,
  );
  const configuredPaths = manifest.pi.extensions;
  const configuredSkillPaths = manifest.pi.skills;
  assertGitInstallCondition(
    configuredPaths.length === 10,
    "temporary root manifest does not contain ten extension paths",
  );
  assertGitInstallCondition(
    configuredPaths.every((configuredPath) => configuredPath.endsWith("/src/index.ts")),
    "temporary root manifest contains a non-source extension path",
  );
  assertGitInstallCondition(
    configuredSkillPaths.length === 10 &&
      configuredSkillPaths.every((configuredPath) => configuredPath.endsWith("/skills")),
    "temporary root manifest does not contain ten skill paths",
  );
  const resources = await new DefaultPackageManager({
    agentDir: agentDirectory,
    cwd: installDirectory,
    settingsManager: SettingsManager.inMemory(),
  }).resolveExtensionSources([installDirectory], { temporary: true });
  assertGitInstallCondition(
    resources.skills.length === 10,
    "temporary install did not expose ten configuration skills",
  );
  const loadedSkills = loadSkills({
    agentDir: agentDirectory,
    cwd: installDirectory,
    includeDefaults: false,
    skillPaths: resources.skills.map(({ path }) => path),
  });
  assertGitInstallCondition(
    loadedSkills.diagnostics.length === 0 && loadedSkills.skills.length === 10,
    "temporary install did not load ten valid configuration skills",
  );
  const entrypoints = configuredPaths.map((configuredPath) =>
    resolve(installDirectory, configuredPath),
  );
  const result = await discoverAndLoadExtensions(entrypoints, installDirectory, agentDirectory);
  assertGitInstallCondition(
    result.errors.length === 0,
    `temporary source entrypoints failed to load: ${JSON.stringify(result.errors)}`,
  );
  assertGitInstallCondition(
    result.extensions.length === 10,
    "temporary install did not load ten extensions",
  );
  assertGitInstallCondition(
    JSON.stringify(result.extensions.map((extension) => extension.resolvedPath)) ===
      JSON.stringify(entrypoints),
    "temporary install loaded an unexpected extension path order",
  );
  await assertCodeModeDenoProcessSmoke(
    resolve(installDirectory, "packages/pi-codemode/src/codemode-worker.ts"),
    "production Git copy",
  );
}

async function assertFilteredProjectPackageLoadsSkills(installDirectory, agentDirectory) {
  const projectSettings = await readJsonDocument(
    resolve(installDirectory, ".pi/settings.json"),
    piSettingsDocumentSchema,
  );
  const localPackage = projectSettings.packages?.find((entry) => entry.source === "..");
  assertGitInstallCondition(
    localPackage && localPackage.autoload === false,
    "project settings do not contain the filtered local collection",
  );

  const settingsManager = SettingsManager.inMemory();
  settingsManager.setProjectPackages([localPackage]);
  const resources = await new DefaultPackageManager({
    agentDir: agentDirectory,
    cwd: installDirectory,
    settingsManager,
  }).resolve();
  const enabledSkills = resources.skills.filter(
    ({ enabled, path }) => enabled && path.startsWith(resolve(installDirectory, "packages/")),
  );
  const selectedSkills = localPackage.skills
    ?.filter((path) => path.startsWith("+"))
    .map((path) => resolve(installDirectory, path.slice(1)));
  assertGitInstallCondition(
    JSON.stringify(enabledSkills.map(({ path }) => path)) === JSON.stringify(selectedSkills),
    "filtered project package did not enable its selected configuration skills",
  );
}

const installDirectory = await mkdtemp(resolve(tmpdir(), "pi-git-install-"));
const agentDirectory = await mkdtemp(resolve(tmpdir(), "pi-git-install-agent-"));
try {
  await cp(repositoryRoot, installDirectory, {
    recursive: true,
    filter: includeWorkingTreePath,
  });
  await runNpmProductionInstall(installDirectory);
  await assertPackageExcludedFromProductionInstall(installDirectory, "vscode-js-debug");
  await assertGitInstalledExtensionsLoad(installDirectory, agentDirectory);
  await assertFilteredProjectPackageLoadsSkills(installDirectory, agentDirectory);
} finally {
  await Promise.all([
    rm(installDirectory, { recursive: true, force: true }),
    rm(agentDirectory, { recursive: true, force: true }),
  ]);
}

console.log(
  "Validated the clean npm production Git-install path with the shared utility and ten configuration skills.",
);
