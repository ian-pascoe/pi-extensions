import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import {
  resolveFormatterSettings,
  type FormatterSettingsDocumentInput,
} from "../src/pi-formatter-settings.js";

const temporaryDirectories: string[] = [];

async function createSettingsReader(
  globalSettings: FormatterSettingsDocumentInput,
  projectSettings: FormatterSettingsDocumentInput,
  projectTrusted = true,
): Promise<SettingsManager> {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-formatter-settings-project-"));
  const agentDirectory = await mkdtemp(resolve(tmpdir(), "pi-formatter-settings-agent-"));
  temporaryDirectories.push(cwd, agentDirectory);
  await mkdir(resolve(cwd, ".pi"));
  await writeFile(resolve(agentDirectory, "settings.json"), JSON.stringify(globalSettings));
  await writeFile(resolve(cwd, ".pi/settings.json"), JSON.stringify(projectSettings));
  return SettingsManager.create(cwd, agentDirectory, { projectTrusted });
}

function markdownFormatter(command: string) {
  return {
    command,
    args: ["--fix", "$FILE"],
    files: { extensions: [".md"], fileNames: ["README"] },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("resolveFormatterSettings", () => {
  test("uses defaults when formatter settings are absent", async () => {
    const settings = resolveFormatterSettings(await createSettingsReader({}, {}));

    expect(settings).toEqual({ formatters: new Map(), timeoutMs: 30_000, warnings: [] });
  });

  test("merges definitions in declaration order, replaces complete definitions, and removes inherited definitions", async () => {
    const settings = resolveFormatterSettings(
      await createSettingsReader(
        {
          formatter: {
            formatters: {
              first: markdownFormatter("global-first"),
              removed: markdownFormatter("remove-me"),
              enabledLater: null,
            },
          },
        },
        {
          formatter: {
            formatters: {
              first: markdownFormatter("project-first"),
              removed: null,
              last: markdownFormatter("project-last"),
              enabledLater: markdownFormatter("project-enabled"),
            },
          },
        },
      ),
    );

    expect([...settings.formatters.keys()]).toEqual(["first", "last", "enabledLater"]);
    expect(settings.formatters.get("first")).toMatchObject({
      args: ["--fix", "$FILE"],
      command: "project-first",
      extensions: [".md"],
      fileNames: ["README"],
      id: "first",
    });
  });

  test("ignores untrusted project settings", async () => {
    const settings = resolveFormatterSettings(
      await createSettingsReader(
        { formatter: { formatters: { global: markdownFormatter("global") } } },
        { formatter: { formatters: { project: markdownFormatter("project") } } },
        false,
      ),
    );

    expect([...settings.formatters.keys()]).toEqual(["global"]);
  });

  test("quarantines invalid definitions while an invalid project replacement shadows global", async () => {
    const settings = resolveFormatterSettings(
      await createSettingsReader(
        {
          formatter: {
            formatters: {
              healthy: markdownFormatter("healthy"),
              shadowed: markdownFormatter("global-shadowed"),
            },
          },
        },
        {
          formatter: {
            formatters: {
              shadowed: { ...markdownFormatter("broken"), unknownField: true },
              projectHealthy: markdownFormatter("project-healthy"),
            },
          },
        },
      ),
    );

    expect([...settings.formatters.keys()]).toEqual(["healthy", "projectHealthy"]);
    expect(settings.warnings).toEqual([
      expect.stringContaining("project formatter.formatters.shadowed.unknownField"),
    ]);
  });

  test("quarantines invalid shared fields without discarding valid definitions", async () => {
    const settings = resolveFormatterSettings(
      await createSettingsReader(
        {
          formatter: {
            timeoutMs: 1234,
            formatters: { healthy: markdownFormatter("healthy") },
          },
        },
        { formatter: { timeoutMs: "broken" } },
      ),
    );

    expect(settings.timeoutMs).toBe(1234);
    expect([...settings.formatters.keys()]).toEqual(["healthy"]);
    expect(settings.warnings).toEqual([expect.stringContaining("project formatter.timeoutMs")]);
  });

  test("requires a command and at least one extension or exact filename", async () => {
    const settings = resolveFormatterSettings(
      await createSettingsReader(
        {
          formatter: {
            formatters: {
              "": markdownFormatter("empty-id"),
              noCommand: { files: { extensions: [".md"] } },
              noFiles: { command: "prettier", files: {} },
            },
          },
        },
        {},
      ),
    );

    expect(settings.formatters).toEqual(new Map());
    expect(settings.warnings).toHaveLength(3);
  });
});
