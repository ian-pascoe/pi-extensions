/**
 * Publish-manifest rewrite for workspace packages whose `publishConfig` overrides package fields.
 *
 * The workspace manifest of `@ian-pascoe/pi-utils` points `main`, `types`, and `exports` at `src`,
 * and its `publishConfig` names the `dist` entrypoints for the release. pnpm applied those
 * overrides when it packed. npm and Bun honour only registry options (`access`, `provenance`, ...)
 * from `publishConfig`, and npm reads the manifest again after packing, so a prepack/postpack
 * rewrite that restores the file would publish registry metadata that points at `src`.
 *
 * Usage: `node scripts/publish-manifest.mjs <apply|check|restore> [package directory...]`. Without
 * directories, every `packages/*` workspace is processed.
 *
 * - `apply` lifts the overrides to the top level, leaves only registry options in `publishConfig`,
 *   and keeps the original manifest next to it. It never restores afterwards; `publish-packages`
 *   runs it once before `changeset publish`.
 * - `check` fails unless the top-level fields already match the overrides. The package's
 *   `prepack` runs it, so `npm pack` and `npm publish` refuse an unapplied manifest.
 * - `restore` puts the original manifest back byte for byte. Only local checks use it.
 */
import { access, copyFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { hasNodeProcessErrorCode, parseNodeProcessError } from "./node-process-error.mjs";
import { Type } from "typebox";
import { Value } from "typebox/value";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Fields a `publishConfig` may override at the top level of the manifest. */
export const overridableFields = ["main", "types", "exports"];
/** The only other `publishConfig` keys npm itself reads. */
export const registryOptions = ["access", "provenance", "registry", "tag"];
/** The original manifest, kept beside the rewritten one until `restore`. */
export const originalManifestFileName = "package.json.pre-publish";

const manifestSchema = Type.Object(
  { publishConfig: Type.Optional(Type.Record(Type.String(), Type.Unknown())) },
  { additionalProperties: true },
);

/**
 * @typedef {{ [key: string]: unknown }} ManifestDocument
 * @typedef {{ manifestPath: string, originalText: string, manifest: ManifestDocument, overrides: ManifestDocument, remainder: ManifestDocument }} LoadedManifest
 */

/**
 * Reads a manifest and splits its `publishConfig` into field overrides and registry options.
 *
 * @param {string} packageDirectory
 * @returns {Promise<LoadedManifest>}
 */
async function loadManifest(packageDirectory) {
  const manifestPath = resolve(packageDirectory, "package.json");
  const originalText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(originalText);
  Value.Assert(manifestSchema, manifest);
  /** @type {ManifestDocument} */
  const overrides = {};
  /** @type {ManifestDocument} */
  const remainder = {};
  for (const [key, value] of Object.entries(manifest.publishConfig ?? {})) {
    if (overridableFields.includes(key)) overrides[key] = value;
    else if (registryOptions.includes(key)) remainder[key] = value;
    else {
      throw new Error(
        `${manifestPath} publishConfig.${key} is neither an overridable field (${overridableFields.join(", ")}) nor a registry option (${registryOptions.join(", ")})`,
      );
    }
  }
  return { manifestPath, originalText, manifest, overrides, remainder };
}

/**
 * Serializes a manifest the way the repository formats it: two spaces and the original final newline.
 *
 * @param {ManifestDocument} manifest
 * @param {string} originalText
 */
function serializeManifest(manifest, originalText) {
  return `${JSON.stringify(manifest, null, 2)}${originalText.endsWith("\n") ? "\n" : ""}`;
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (cause) {
    if (hasNodeProcessErrorCode(parseNodeProcessError(cause), "ENOENT")) return false;
    throw cause;
  }
}

/**
 * Lifts `publishConfig` field overrides to the top level and keeps the original manifest.
 *
 * @param {string} packageDirectory
 * @returns {Promise<{ handled: boolean }>} Whether the manifest was rewritten.
 */
export async function applyPublishManifest(packageDirectory) {
  const { manifestPath, originalText, manifest, overrides, remainder } =
    await loadManifest(packageDirectory);
  if (Object.keys(overrides).length === 0) return { handled: false };
  const originalPath = resolve(packageDirectory, originalManifestFileName);
  if (await exists(originalPath)) {
    throw new Error(
      `${manifestPath} still has overrides and ${originalManifestFileName} already exists; run restore first`,
    );
  }
  await writeFile(originalPath, originalText);
  const applied = { ...manifest, ...overrides };
  if (Object.keys(remainder).length === 0) delete applied.publishConfig;
  else applied.publishConfig = remainder;
  await writeFile(manifestPath, serializeManifest(applied, originalText));
  return { handled: true };
}

/**
 * Fails unless every field `publishConfig` overrides already holds that value at the top level.
 *
 * @param {string} packageDirectory
 * @returns {Promise<{ handled: boolean }>} Whether the package still names overrides it verified.
 */
export async function checkPublishManifest(packageDirectory) {
  const { manifestPath, manifest, overrides } = await loadManifest(packageDirectory);
  const mismatched = Object.keys(overrides).filter(
    (field) => !isDeepStrictEqual(manifest[field], overrides[field]),
  );
  if (mismatched.length > 0) {
    throw new Error(
      `${manifestPath} does not match its publishConfig overrides for ${mismatched.join(", ")}; run \`node scripts/publish-manifest.mjs apply\` first`,
    );
  }
  return { handled: Object.keys(overrides).length > 0 };
}

/**
 * Puts the manifest that `apply` replaced back, byte for byte.
 *
 * @param {string} packageDirectory
 * @returns {Promise<{ handled: boolean }>}
 */
export async function restorePublishManifest(packageDirectory) {
  const originalPath = resolve(packageDirectory, originalManifestFileName);
  if (!(await exists(originalPath))) return { handled: false };
  await copyFile(originalPath, resolve(packageDirectory, "package.json"));
  await rm(originalPath);
  return { handled: true };
}

/**
 * Lists every `packages/*` directory that holds a manifest.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function listWorkspacePackageDirectories(root = repositoryRoot) {
  const packagesDirectory = resolve(root, "packages");
  const entries = await readdir(packagesDirectory, { withFileTypes: true });
  const directories = [];
  for (const entry of entries) {
    const directory = resolve(packagesDirectory, entry.name);
    if (entry.isDirectory() && (await exists(resolve(directory, "package.json")))) {
      directories.push(directory);
    }
  }
  return directories.sort();
}

const modes = {
  apply: applyPublishManifest,
  check: checkPublishManifest,
  restore: restorePublishManifest,
};

/**
 * Runs one mode over the given package directories, or every workspace package.
 *
 * @param {string} mode
 * @param {string[]} packageDirectories
 * @returns {Promise<string[]>} One report line per package the mode rewrote, verified, or restored.
 */
export async function runPublishManifest(mode, packageDirectories) {
  if (!Object.hasOwn(modes, mode)) {
    throw new Error(`Usage: publish-manifest.mjs <apply|check|restore> [package directory...]`);
  }
  const directories =
    packageDirectories.length > 0
      ? packageDirectories.map((directory) => resolve(directory))
      : await listWorkspacePackageDirectories();
  const lines = [];
  for (const directory of directories) {
    const result = await modes[mode](directory);
    if (result.handled) {
      lines.push(`publish-manifest ${mode}: ${relative(process.cwd(), directory) || "."}`);
    }
  }
  return lines;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode = "", ...packageDirectories] = process.argv.slice(2);
  try {
    for (const line of await runPublishManifest(mode, packageDirectories)) console.log(line);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
