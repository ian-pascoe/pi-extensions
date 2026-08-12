import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

const inheritedNpmPackages = [
  ["pi-adaptive-thinking", "pi-adaptive-thinking"],
  ["@ian-pascoe/pi-minimal-subagents", "pi-minimal-subagents"],
  ["@ian-pascoe/pi-bible-verses", "pi-bible-verses"],
  ["@ian-pascoe/pi-tps-tracker", "pi-tps-tracker"],
  ["@ian-pascoe/pi-git-status-widget", "pi-git-status-widget"],
] as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("project extension overrides", () => {
  test("loads workspace sources instead of inherited npm package entrypoints", async () => {
    const projectSettings = JSON.parse(
      await readFile(resolve(repositoryRoot, ".pi/settings.json"), "utf8"),
    ) as {
      packages?: Array<
        | string
        | {
            source: string;
            autoload: boolean;
            extensions: string[];
          }
      >;
    };
    const repositoryManifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { pi?: { extensions?: string[] } };
    const authoritativeExtensionPaths = repositoryManifest.pi?.extensions;

    expect(projectSettings.packages).toEqual([
      "..",
      ...inheritedNpmPackages.map(([packageName]) => ({
        source: `npm:${packageName}`,
        autoload: false,
        extensions: ["-src/index.ts"],
      })),
    ]);
    expect(authoritativeExtensionPaths).toHaveLength(6);

    const agentDirectory = await mkdtemp(resolve(tmpdir(), "pi-project-overrides-agent-"));
    temporaryDirectories.push(agentDirectory);
    await writeFile(
      resolve(agentDirectory, "settings.json"),
      JSON.stringify({
        packages: inheritedNpmPackages.map(([packageName]) => `npm:${packageName}`),
      }),
    );

    for (const [packageName, packageDirectory] of inheritedNpmPackages) {
      const installedPackageDirectory = resolve(
        agentDirectory,
        "npm/node_modules",
        ...packageName.split("/"),
      );
      await mkdir(dirname(installedPackageDirectory), { recursive: true });
      await cp(resolve(repositoryRoot, "packages", packageDirectory), installedPackageDirectory, {
        recursive: true,
      });
    }

    const settingsManager = SettingsManager.create(repositoryRoot, agentDirectory, {
      projectTrusted: true,
    });
    const packageManager = new DefaultPackageManager({
      cwd: repositoryRoot,
      agentDir: agentDirectory,
      settingsManager,
    });
    const resolvedPaths = await packageManager.resolve(async () => "error");

    expect(
      resolvedPaths.extensions
        .filter((extension) => extension.enabled)
        .map((extension) => extension.path),
    ).toEqual(
      authoritativeExtensionPaths?.map((extensionPath) => resolve(repositoryRoot, extensionPath)),
    );

    for (const [packageName] of inheritedNpmPackages) {
      expect(resolvedPaths.extensions).toContainEqual(
        expect.objectContaining({
          path: resolve(
            agentDirectory,
            "npm/node_modules",
            ...packageName.split("/"),
            "src/index.ts",
          ),
          enabled: false,
        }),
      );
    }
  });
});
