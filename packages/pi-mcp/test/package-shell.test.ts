import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Static, Type } from "typebox";
import { Parse } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";

const PackResultSchema = Type.Object({
  filename: Type.String(),
  files: Type.Array(Type.Object({ path: Type.String() })),
});
const PackOutputSchema = Type.Union([
  Type.Array(PackResultSchema),
  Type.Record(Type.String(), PackResultSchema),
]);

type PackResult = Static<typeof PackResultSchema>;

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

function findAddedResources(before: readonly string[], after: readonly string[]): string[] {
  const remaining = [...before];
  return after.filter((resource) => {
    const index = remaining.indexOf(resource);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
}

function parsePackResult(json: string): PackResult {
  const output = Parse(PackOutputSchema, JSON.parse(json));
  const candidates = Array.isArray(output) ? output : Object.values(output);
  const result = candidates[0];
  if (result === undefined) throw new Error("npm pack returned no valid package result");
  return result;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Pi MCP package shell", () => {
  test("loads the source entrypoint without starting runtime work", async () => {
    const beforeHandles = process.getActiveResourcesInfo();
    const extensionModule = await import("../src/index.js");
    expect(extensionModule.default).toBeTypeOf("function");
    expect(findAddedResources(beforeHandles, process.getActiveResourcesInfo())).toEqual([]);
  }, 20_000);

  test("builds and runs the packed CLI under plain Node", async () => {
    await execFile("pnpm", ["build:cli"], { cwd: packageRoot });
    const compiledCli = resolve(packageRoot, "dist/pi-mcp-cli.js");
    expect(await readFile(compiledCli, "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);

    const packDirectory = await mkdtemp(resolve(tmpdir(), "pi-mcp-pack-"));
    const installDirectory = await mkdtemp(resolve(tmpdir(), "pi-mcp-install-"));
    temporaryDirectories.push(packDirectory, installDirectory);
    const { stdout: packOutput } = await execFile(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--package-lock=false",
        "--pack-destination",
        packDirectory,
      ],
      { cwd: packageRoot },
    );
    const packResult = parsePackResult(packOutput);
    expect(packResult.files.map(({ path }) => path)).toContain("dist/pi-mcp-cli.js");

    await writeFile(
      resolve(installDirectory, "package.json"),
      JSON.stringify({ name: "pi-mcp-packed-tracer", private: true, type: "module" }),
    );
    await execFile(
      "npm",
      [
        "install",
        resolve(packDirectory, packResult.filename),
        "--legacy-peer-deps",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: installDirectory },
    );

    const { stdout } = await execFile(
      process.execPath,
      [resolve(installDirectory, "node_modules/@ian-pascoe/pi-mcp/dist/pi-mcp-cli.js"), "--help"],
      { cwd: installDirectory },
    );
    expect(stdout).toContain("Usage: pi-mcp");
  }, 60_000);
});
