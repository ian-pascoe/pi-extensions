import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { afterEach, describe, expect, test } from "vitest";
import {
  packageSettingsSourceSchema,
  piSettingsDocumentSchema,
  readJsonDocument,
  rootPiManifestSchema,
  workspacePackageManifestSchema,
} from "../scripts/root-project-contract.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

type ExtensionDescriptor = {
  readonly extensionPath: string;
  readonly packageName: string;
};
type OfflineProjectFixture = {
  readonly agentDirectory: string;
  readonly projectDirectory: string;
  readonly workspaceDirectory: string;
};

function normalizeExtensionPath(extensionPath: string): string {
  return extensionPath.replace(/^\.\//, "");
}

function requireExactlyOne<T>(values: readonly T[], description: string): T {
  const value = values.at(0);
  if (value === undefined || values.length !== 1) {
    throw new Error(`Project extension overrides failed: expected one ${description}`);
  }
  return value;
}

function requireConfiguredExtensions(
  entry: Static<typeof packageSettingsSourceSchema>,
): readonly string[] {
  if (entry.extensions === undefined) {
    throw new Error(
      `Project extension overrides failed: ${entry.source} has no extension overrides`,
    );
  }
  return entry.extensions;
}

function assertSignedSourceOverrides(
  overrides: readonly string[],
  authoritativeExtensionPaths: readonly string[],
): ReadonlySet<string> {
  const authoritativePaths = new Set(authoritativeExtensionPaths.map(normalizeExtensionPath));
  const selectedPaths = new Set<string>();
  const seenPaths = new Set<string>();

  expect(overrides).toHaveLength(authoritativePaths.size);
  for (const override of overrides) {
    expect(override).toMatch(/^[+-]packages\/[^/]+\/src\/index\.ts$/);
    const extensionPath = override.slice(1);
    expect(authoritativePaths).toContain(extensionPath);
    expect(seenPaths.has(extensionPath)).toBe(false);
    seenPaths.add(extensionPath);
    if (override.startsWith("+")) selectedPaths.add(extensionPath);
  }
  expect(seenPaths).toEqual(authoritativePaths);

  return selectedPaths;
}

async function readAuthoritativeExtensionDescriptors(): Promise<readonly ExtensionDescriptor[]> {
  const rootManifest = await readJsonDocument(
    resolve(repositoryRoot, "package.json"),
    rootPiManifestSchema,
  );
  const descriptors: ExtensionDescriptor[] = [];
  for (const extensionPath of rootManifest.pi.extensions) {
    const packageManifestPath = resolve(
      repositoryRoot,
      dirname(dirname(extensionPath)),
      "package.json",
    );
    const packageManifest = await readJsonDocument(
      packageManifestPath,
      workspacePackageManifestSchema,
    );
    descriptors.push({ extensionPath, packageName: packageManifest.name });
  }
  return descriptors;
}

async function createOfflineProjectFixture(
  extensionDescriptors: readonly ExtensionDescriptor[],
  workspaceOverrides: readonly string[],
): Promise<OfflineProjectFixture> {
  const workspaceDirectory = await mkdtemp(resolve(tmpdir(), "pi-workspace-toggle-workspace-"));
  const projectDirectory = workspaceDirectory;
  const agentDirectory = await mkdtemp(resolve(tmpdir(), "pi-workspace-toggle-agent-"));
  temporaryDirectories.push(workspaceDirectory, agentDirectory);

  await mkdir(resolve(projectDirectory, ".pi"), { recursive: true });
  await writeFile(
    resolve(workspaceDirectory, "package.json"),
    JSON.stringify({
      name: "offline-workspace-source",
      pi: { extensions: extensionDescriptors.map(({ extensionPath }) => extensionPath) },
      private: true,
      type: "module",
      version: "1.0.0",
    }),
  );
  await writeFile(
    resolve(projectDirectory, ".pi/settings.json"),
    JSON.stringify({
      packages: [
        { autoload: false, extensions: workspaceOverrides, source: ".." },
        ...extensionDescriptors.map(({ packageName }) => ({
          autoload: false,
          extensions: ["-src/index.ts"],
          source: `npm:${packageName}`,
        })),
      ],
    }),
  );
  await writeFile(
    resolve(agentDirectory, "settings.json"),
    JSON.stringify({
      packages: extensionDescriptors.map(({ packageName }) => `npm:${packageName}`),
    }),
  );

  for (const { extensionPath, packageName } of extensionDescriptors) {
    const workspaceEntrypoint = resolve(workspaceDirectory, extensionPath);
    await mkdir(dirname(workspaceEntrypoint), { recursive: true });
    await writeFile(workspaceEntrypoint, "export default () => {};\n");

    const installedPackageDirectory = resolve(
      agentDirectory,
      "npm/node_modules",
      ...packageName.split("/"),
    );
    await mkdir(resolve(installedPackageDirectory, "src"), { recursive: true });
    await writeFile(
      resolve(installedPackageDirectory, "package.json"),
      JSON.stringify({
        name: packageName,
        pi: { extensions: ["./src/index.ts"] },
        type: "module",
        version: "1.0.0",
      }),
    );
    await writeFile(
      resolve(installedPackageDirectory, "src/index.ts"),
      "export default () => {};\n",
    );
  }

  return { agentDirectory, projectDirectory, workspaceDirectory };
}

async function resolveOfflineProjectExtensions(
  fixture: OfflineProjectFixture,
): Promise<Awaited<ReturnType<DefaultPackageManager["resolve"]>>> {
  const settingsManager = SettingsManager.create(fixture.projectDirectory, fixture.agentDirectory, {
    projectTrusted: true,
  });
  const packageManager = new DefaultPackageManager({
    agentDir: fixture.agentDirectory,
    cwd: fixture.projectDirectory,
    settingsManager,
  });
  return packageManager.resolve(async () => "error");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("project extension overrides", () => {
  test("keeps the tracked two-source settings contract coherent", async () => {
    const extensionDescriptors = await readAuthoritativeExtensionDescriptors();
    expect(extensionDescriptors).toHaveLength(9);
    const projectSettings = await readJsonDocument(
      resolve(repositoryRoot, ".pi/settings.json"),
      piSettingsDocumentSchema,
    );
    const entries = projectSettings.packages ?? [];
    const workspaceEntry = requireExactlyOne(
      entries.filter((entry) => entry.source === ".."),
      "workspace settings source",
    );
    const gitEntry = requireExactlyOne(
      entries.filter((entry) => entry.source === "git:github.com/ian-pascoe/pi-extensions"),
      "Git settings source",
    );

    expect(entries).toHaveLength(2);
    expect(workspaceEntry).toMatchObject({ autoload: false });
    expect(gitEntry).toMatchObject({ autoload: false });

    const extensionPaths = extensionDescriptors.map(({ extensionPath }) => extensionPath);
    const workspaceSelections = assertSignedSourceOverrides(
      requireConfiguredExtensions(workspaceEntry),
      extensionPaths,
    );
    const gitSelections = assertSignedSourceOverrides(
      requireConfiguredExtensions(gitEntry),
      extensionPaths,
    );

    expect([...workspaceSelections].filter((path) => gitSelections.has(path))).toEqual([]);
  });

  test("honors workspace toggles while disabling inherited npm entrypoints", async () => {
    const extensionDescriptors = await readAuthoritativeExtensionDescriptors();
    const projectSettings = await readJsonDocument(
      resolve(repositoryRoot, ".pi/settings.json"),
      piSettingsDocumentSchema,
    );
    const entries = projectSettings.packages ?? [];
    const workspaceEntry = requireExactlyOne(
      entries.filter((entry) => entry.source === ".."),
      "workspace settings source",
    );
    const workspaceOverrides = requireConfiguredExtensions(workspaceEntry);
    const fixture = await createOfflineProjectFixture(extensionDescriptors, workspaceOverrides);
    const resolvedExtensions = await resolveOfflineProjectExtensions(fixture);
    const expectedEnabledWorkspacePaths = workspaceOverrides
      .filter((override) => override.startsWith("+"))
      .map((override) => resolve(fixture.workspaceDirectory, override.slice(1)));
    const workspaceExtensions = resolvedExtensions.extensions.filter(
      (extension) => extension.metadata.source === "..",
    );
    expect(
      workspaceExtensions
        .filter((extension) => extension.enabled)
        .map((extension) => extension.path),
    ).toEqual(expectedEnabledWorkspacePaths);
    expect(
      new Set(
        workspaceExtensions
          .filter((extension) => !extension.enabled)
          .map((extension) => extension.path),
      ),
    ).toEqual(
      new Set(
        extensionDescriptors
          .map(({ extensionPath }) => resolve(fixture.workspaceDirectory, extensionPath))
          .filter((extensionPath) => !expectedEnabledWorkspacePaths.includes(extensionPath)),
      ),
    );

    for (const { packageName } of extensionDescriptors) {
      expect(resolvedExtensions.extensions).toContainEqual(
        expect.objectContaining({
          enabled: false,
          path: resolve(
            fixture.agentDirectory,
            "npm/node_modules",
            ...packageName.split("/"),
            "src/index.ts",
          ),
        }),
      );
    }
  });
});
