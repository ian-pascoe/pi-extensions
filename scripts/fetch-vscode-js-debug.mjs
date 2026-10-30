/**
 * Fetches the vscode-js-debug release that Pi DAP's Supported Adapter tests run against.
 *
 * The release tarball ships no `package.json`, so a package manager cannot install it. The pinned
 * version, URL, and SHA-512 integrity live in `tools/pi-dap-vscode-js-debug/fixture.json`; this
 * script downloads that tarball, verifies the hash, and extracts it, with a minimal `package.json`, to the gitignored
 * `tools/pi-dap-vscode-js-debug/js-debug/`. It is idempotent: an extract that records the same
 * integrity is left alone. `node scripts/fetch-vscode-js-debug.mjs` runs it by hand; Pi DAP's
 * Vitest global setup and the root `prepare` script run it automatically.
 */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { hasNodeProcessErrorCode, parseNodeProcessError } from "./node-process-error.mjs";
import { Type } from "typebox";
import { Value } from "typebox/value";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The fixture directory that holds `fixture.json` and, once fetched, the `js-debug/` extract. */
export const defaultFixtureDirectory = resolve(repositoryRoot, "tools/pi-dap-vscode-js-debug");
/** The directory, inside the fixture directory, that holds the extracted release. */
export const extractDirectoryName = "js-debug";
/** The extract at its repository location. */
export const defaultExtractDirectory = resolve(defaultFixtureDirectory, extractDirectoryName);
/** Scratch directories this script creates in the fixture directory while it downloads. */
export const scratchDirectoryPrefix = ".fetch-";
/** A stalled download must not hang an install or a test run. */
export const defaultDownloadTimeoutMs = 120_000;
/** Where the extract records the integrity it was verified against. */
export const integrityMarkerName = ".fixture-integrity";

const fixtureSchema = Type.Object({
  version: Type.String(),
  url: Type.String(),
  integrity: Type.String({ pattern: "^sha512-[A-Za-z0-9+/]+={0,2}$" }),
});

/**
 * @typedef {import("typebox").StaticParse<typeof fixtureSchema>} Fixture
 */

/**
 * @param {string} fixtureDirectory
 * @returns {Promise<Fixture>}
 */
async function readFixture(fixtureDirectory) {
  return Value.Parse(
    fixtureSchema,
    JSON.parse(await readFile(resolve(fixtureDirectory, "fixture.json"), "utf8")),
  );
}

/**
 * @param {string} path
 * @returns {Promise<string | undefined>}
 */
async function readTextIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (hasNodeProcessErrorCode(parseNodeProcessError(cause), "ENOENT")) return undefined;
    throw cause;
  }
}

/**
 * Downloads the tarball and checks it against the pinned integrity.
 *
 * @param {Fixture} fixture
 * @param {number} timeoutMs Covers the whole download, body included.
 * @returns {Promise<Buffer>}
 */
async function downloadVerifiedTarball(fixture, timeoutMs) {
  const response = await fetch(fixture.url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`GET ${fixture.url} failed: ${response.status} ${response.statusText}`);
  }
  const tarball = Buffer.from(await response.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (integrity !== fixture.integrity) {
    throw new Error(
      `vscode-js-debug ${fixture.version} integrity mismatch: expected ${fixture.integrity}, got ${integrity}`,
    );
  }
  return tarball;
}

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function sleep(milliseconds) {
  return new Promise((done) => setTimeout(done, milliseconds));
}

/**
 * Makes `<fixtureDirectory>/js-debug/` hold the pinned release.
 *
 * Downloads once more after `retryDelayMs` when the first attempt fails, whether by network, HTTP
 * status, or hash. A second failure throws, and nothing is extracted from an unverified tarball.
 *
 * @param {string} fixtureDirectory
 * @param {number} retryDelayMs
 * @param {number} downloadTimeoutMs
 * @returns {Promise<{ status: "present" | "downloaded", version: string, directory: string }>}
 */
export async function ensureVscodeJsDebug(
  fixtureDirectory = defaultFixtureDirectory,
  retryDelayMs = 1000,
  downloadTimeoutMs = defaultDownloadTimeoutMs,
) {
  const fixture = await readFixture(fixtureDirectory);
  const directory = resolve(fixtureDirectory, extractDirectoryName);
  const recorded = await readTextIfPresent(resolve(directory, integrityMarkerName));
  if (recorded === fixture.integrity) {
    return { status: "present", version: fixture.version, directory };
  }

  /** @type {Buffer} */
  let tarball;
  try {
    tarball = await downloadVerifiedTarball(fixture, downloadTimeoutMs);
  } catch (firstFailure) {
    console.warn(
      `vscode-js-debug fetch failed, retrying in ${retryDelayMs} ms: ${firstFailure instanceof Error ? firstFailure.message : String(firstFailure)}`,
    );
    await sleep(retryDelayMs);
    tarball = await downloadVerifiedTarball(fixture, downloadTimeoutMs);
  }

  // Extract beside the destination so the final rename stays on one filesystem.
  const workDirectory = await mkdtemp(resolve(fixtureDirectory, scratchDirectoryPrefix));
  try {
    const tarballPath = resolve(workDirectory, "js-debug.tar.gz");
    await writeFile(tarballPath, tarball);
    await execFile("tar", ["-xzf", tarballPath, "-C", workDirectory]);
    const extracted = resolve(workDirectory, extractDirectoryName);
    // The release ships no manifest. Without one Node reads the repository root's `"type": "module"`
    // and loads the CommonJS adapter as ESM, which fails on its first `require`.
    await writeFile(
      resolve(extracted, "package.json"),
      `${JSON.stringify({ name: "vscode-js-debug", version: fixture.version, private: true }, null, 2)}\n`,
    );
    await writeFile(resolve(extracted, integrityMarkerName), fixture.integrity);
    await rm(directory, { recursive: true, force: true });
    await rename(extracted, directory);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
  return { status: "downloaded", version: fixture.version, directory };
}

/** Vitest global setup: Pi DAP's integration test needs the adapter on disk. */
export default async function setup() {
  await ensureVscodeJsDebug();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { status, version, directory } = await ensureVscodeJsDebug();
    console.log(`vscode-js-debug ${version} ${status}: ${directory}`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
