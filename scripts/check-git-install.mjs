import { execFile as execFileCallback } from "node:child_process";
import { access, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import {
  getNodeProcessErrorStderr,
  hasNodeProcessErrorCode,
  parseNodeProcessError,
} from "./node-process-error.mjs";
import { readJsonDocument, rootPiManifestSchema } from "./root-project-contract.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const excludedDirectoryNames = new Set([".git", "coverage", "dist", "node_modules"]);

function assertGitInstallCondition(condition, message) {
  if (!condition) throw new Error(`Git install check failed: ${message}`);
}

function includeWorkingTreePath(source) {
  const name = basename(source);
  if (excludedDirectoryNames.has(name)) return false;
  if (name.endsWith(".tgz")) return false;
  return true;
}

async function runNpmProductionInstall(installDirectory) {
  try {
    await execFile(
      "npm",
      ["install", "--omit=dev", "--package-lock=false", "--no-audit", "--no-fund"],
      {
        cwd: installDirectory,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        env: {
          ...process.env,
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

async function assertByteroverCliExcludedFromProductionInstall(installDirectory) {
  try {
    await access(resolve(installDirectory, "node_modules/byterover-cli/package.json"));
    throw new Error("Git install check failed: byterover-cli is present in the production install");
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
  assertGitInstallCondition(
    configuredPaths.length === 6,
    "temporary root manifest does not contain six extension paths",
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
    result.extensions.length === 6,
    "temporary install did not load six extensions",
  );
  assertGitInstallCondition(
    JSON.stringify(result.extensions.map((extension) => extension.resolvedPath)) ===
      JSON.stringify(entrypoints),
    "temporary install loaded an unexpected extension path order",
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
  await assertByteroverCliExcludedFromProductionInstall(installDirectory);
  await assertGitInstalledExtensionsLoad(installDirectory, agentDirectory);
} finally {
  await Promise.all([
    rm(installDirectory, { recursive: true, force: true }),
    rm(agentDirectory, { recursive: true, force: true }),
  ]);
}

console.log("Validated the clean npm production Git-install path.");
