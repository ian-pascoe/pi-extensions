import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import {
  resolveGitCheckpointsSettings,
  type GitCheckpointsSettingsDocumentInput,
} from "../src/pi-git-checkpoints-settings.js";

const temporaryDirectories: string[] = [];

async function createSettingsManager(
  globalSettings: GitCheckpointsSettingsDocumentInput,
  projectSettings: GitCheckpointsSettingsDocumentInput,
  projectTrusted = true,
): Promise<SettingsManager> {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-git-checkpoints-settings-project-"));
  const agentDirectory = await mkdtemp(resolve(tmpdir(), "pi-git-checkpoints-settings-agent-"));
  temporaryDirectories.push(cwd, agentDirectory);
  await mkdir(resolve(cwd, ".pi"));
  await writeFile(resolve(agentDirectory, "settings.json"), JSON.stringify(globalSettings));
  await writeFile(resolve(cwd, ".pi/settings.json"), JSON.stringify(projectSettings));
  return SettingsManager.create(cwd, agentDirectory, { projectTrusted });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("resolveGitCheckpointsSettings", () => {
  test("uses a trusted project retention period instead of the global value", async () => {
    const settings = resolveGitCheckpointsSettings(
      await createSettingsManager(
        { gitCheckpoints: { retentionDays: 14 } },
        { gitCheckpoints: { retentionDays: 3 } },
      ),
    );

    expect(settings).toEqual({ retentionDays: 3, warnings: [] });
  });

  test("excludes project Git Checkpoints settings when the project is untrusted", async () => {
    const settings = resolveGitCheckpointsSettings(
      await createSettingsManager(
        { gitCheckpoints: { retentionDays: 14 } },
        { gitCheckpoints: { retentionDays: 3 } },
        false,
      ),
    );

    expect(settings).toEqual({ retentionDays: 14, warnings: [] });
  });

  test("falls back to the global retention period for an invalid project value", async () => {
    const settings = resolveGitCheckpointsSettings(
      await createSettingsManager(
        { gitCheckpoints: { retentionDays: 14 } },
        { gitCheckpoints: { retentionDays: 0 } },
      ),
    );

    expect(settings.retentionDays).toBe(14);
    expect(settings.warnings).toEqual([
      "project gitCheckpoints.retentionDays: expected a positive safe integer",
    ]);
  });

  test("warns about unknown Git Checkpoints settings fields", async () => {
    const settings = resolveGitCheckpointsSettings(
      await createSettingsManager(
        { gitCheckpoints: { retentionDays: 14, unknownSetting: true } },
        {},
      ),
    );

    expect(settings.retentionDays).toBe(14);
    expect(settings.warnings).toEqual(["global gitCheckpoints.unknownSetting: unknown field"]);
  });
});
