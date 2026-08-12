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

type PackageSettingsEntry =
  | string
  | {
      source: string;
      autoload?: boolean;
      extensions?: string[];
    };

function getPackageSource(entry: PackageSettingsEntry): string {
  return typeof entry === "string" ? entry : entry.source;
}

function normalizeExtensionPath(extensionPath: string): string {
  return extensionPath.replace(/^\.\//, "");
}

async function createWorkspacePackageFixture(extensionPaths: string[]): Promise<{
  agentDirectory: string;
  projectDirectory: string;
}> {
  const projectDirectory = await mkdtemp(resolve(tmpdir(), "pi-workspace-toggle-project-"));
  const agentDirectory = await mkdtemp(resolve(tmpdir(), "pi-workspace-toggle-agent-"));
  temporaryDirectories.push(projectDirectory, agentDirectory);

  await mkdir(resolve(projectDirectory, ".pi"), { recursive: true });
  await writeFile(
    resolve(projectDirectory, "package.json"),
    JSON.stringify({ pi: { extensions: extensionPaths } }),
  );

  for (const extensionPath of extensionPaths) {
    const absolutePath = resolve(projectDirectory, extensionPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "export default () => {};\n");
  }

  return { agentDirectory, projectDirectory };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("project extension overrides", () => {
  test("honors workspace toggles while overriding inherited npm package entrypoints", async () => {
    const projectSettings = JSON.parse(
      await readFile(resolve(repositoryRoot, ".pi/settings.json"), "utf8"),
    ) as {
      packages?: PackageSettingsEntry[];
    };
    const repositoryManifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { pi?: { extensions?: string[] } };
    const authoritativeExtensionPaths = repositoryManifest.pi?.extensions;
    const projectPackages = projectSettings.packages ?? [];
    const workspacePackage = projectPackages.find((entry) => getPackageSource(entry) === "..");
    const inheritedPackageOverrides = projectPackages.filter(
      (entry) => getPackageSource(entry) !== "..",
    );

    expect(workspacePackage).toBeDefined();
    expect(inheritedPackageOverrides).toEqual(
      inheritedNpmPackages.map(([packageName]) => ({
        source: `npm:${packageName}`,
        autoload: false,
        extensions: ["-src/index.ts"],
      })),
    );
    expect(authoritativeExtensionPaths).toHaveLength(6);

    const workspaceExtensionOverrides =
      typeof workspacePackage === "object" ? (workspacePackage.extensions ?? []) : undefined;
    const authoritativeNormalizedPaths = authoritativeExtensionPaths?.map(normalizeExtensionPath);

    for (const override of workspaceExtensionOverrides ?? []) {
      expect(override).toMatch(/^[+-]packages\/[^/]+\/src\/index\.ts$/);
      expect(authoritativeNormalizedPaths).toContain(override.slice(1));
    }

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

    const workspaceExtensions = resolvedPaths.extensions.filter(
      (extension) => extension.metadata.source === "..",
    );
    const expectedEnabledWorkspacePaths = authoritativeExtensionPaths
      ?.filter((extensionPath) => {
        if (workspaceExtensionOverrides === undefined) return true;
        if (workspaceExtensionOverrides.length === 0) return false;

        return !workspaceExtensionOverrides.includes(`-${normalizeExtensionPath(extensionPath)}`);
      })
      .map((extensionPath) => resolve(repositoryRoot, extensionPath));

    expect(
      workspaceExtensions
        .filter((extension) => extension.enabled)
        .map((extension) => extension.path),
    ).toEqual(expectedEnabledWorkspacePaths);
    expect(
      workspaceExtensions
        .filter((extension) => !extension.enabled)
        .map((extension) => extension.path),
    ).toEqual(
      authoritativeExtensionPaths
        ?.filter(
          (extensionPath) =>
            !expectedEnabledWorkspacePaths?.includes(resolve(repositoryRoot, extensionPath)),
        )
        .map((extensionPath) => resolve(repositoryRoot, extensionPath)),
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

  test("can disable each workspace extension independently", async () => {
    const repositoryManifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { pi?: { extensions?: string[] } };
    const authoritativeExtensionPaths = repositoryManifest.pi?.extensions ?? [];
    const { agentDirectory, projectDirectory } = await createWorkspacePackageFixture(
      authoritativeExtensionPaths,
    );

    for (const disabledExtensionPath of authoritativeExtensionPaths) {
      await writeFile(
        resolve(projectDirectory, ".pi/settings.json"),
        JSON.stringify({
          packages: [
            {
              source: "..",
              extensions: [`-${normalizeExtensionPath(disabledExtensionPath)}`],
            },
          ],
        }),
      );

      const settingsManager = SettingsManager.create(projectDirectory, agentDirectory, {
        projectTrusted: true,
      });
      const packageManager = new DefaultPackageManager({
        cwd: projectDirectory,
        agentDir: agentDirectory,
        settingsManager,
      });
      const resolvedPaths = await packageManager.resolve(async () => "error");
      const workspaceExtensions = resolvedPaths.extensions.filter(
        (extension) => extension.metadata.source === "..",
      );

      expect(
        workspaceExtensions
          .filter((extension) => !extension.enabled)
          .map((extension) => extension.path),
      ).toEqual([resolve(projectDirectory, disabledExtensionPath)]);
      expect(workspaceExtensions.filter((extension) => extension.enabled)).toHaveLength(5);
    }
  });
});
