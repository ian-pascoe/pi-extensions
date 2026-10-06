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
    rootMarkers: ["package.json", ".git"],
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
      requireRootMarker: false,
      rootMarkers: ["package.json", ".git"],
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

  test("parses root marker activation and quarantines an activation gate without markers", async () => {
    const settings = resolveFormatterSettings(
      await createSettingsReader(
        {
          formatter: {
            formatters: {
              gated: { ...markdownFormatter("gated"), requireRootMarker: true },
              impossible: {
                ...markdownFormatter("impossible"),
                requireRootMarker: true,
                rootMarkers: [],
              },
            },
          },
        },
        {},
      ),
    );

    expect(settings.formatters.get("gated")?.requireRootMarker).toBe(true);
    expect(settings.formatters.has("impossible")).toBe(false);
    expect(settings.warnings).toEqual([
      expect.stringContaining("global formatter.formatters.impossible.rootMarkers"),
    ]);
  });

  test("compiles a File Formatter's syntax-error pattern and leaves it unset by default", async () => {
    const settings = resolveFormatterSettings(
      await createSettingsReader(
        {
          formatter: {
            formatters: {
              declared: { ...markdownFormatter("declared"), syntaxErrorPattern: "^error: Failed" },
              fallback: markdownFormatter("fallback"),
            },
          },
        },
        {},
      ),
    );

    expect(settings.warnings).toEqual([]);
    expect(settings.formatters.get("declared")?.syntaxErrorPattern).toEqual(/^error: Failed/);
    expect(settings.formatters.get("fallback")?.syntaxErrorPattern).toBeUndefined();
  });

  test.each([
    { name: "an invalid regex", syntaxErrorPattern: "(unclosed", reason: "Unterminated group" },
    { name: "an empty pattern", syntaxErrorPattern: "", reason: "fewer than 1 characters" },
    { name: "a non-string pattern", syntaxErrorPattern: 2, reason: "string" },
  ])(
    "quarantines a definition with $name and shadows the global one",
    async ({ syntaxErrorPattern, reason }) => {
      const settings = resolveFormatterSettings(
        await createSettingsReader(
          { formatter: { formatters: { shadowed: markdownFormatter("global") } } },
          {
            formatter: {
              formatters: {
                shadowed: { ...markdownFormatter("project"), syntaxErrorPattern },
                healthy: markdownFormatter("healthy"),
              },
            },
          },
        ),
      );

      expect([...settings.formatters.keys()]).toEqual(["healthy"]);
      expect(settings.warnings).toEqual([
        expect.stringMatching(
          new RegExp(
            `^project formatter\\.formatters\\.shadowed\\.syntaxErrorPattern: .*${reason}`,
          ),
        ),
      ]);
    },
  );

  test("quarantines a syntax-error pattern on a Workspace Formatter", async () => {
    const settings = resolveFormatterSettings(
      await createSettingsReader(
        {
          formatter: {
            formatters: {
              workspace: {
                ...markdownFormatter("workspace"),
                args: ["--write"],
                syntaxErrorPattern: "error",
              },
            },
          },
        },
        {},
      ),
    );

    expect(settings.formatters.size).toBe(0);
    expect(settings.warnings).toEqual([
      expect.stringContaining(
        "global formatter.formatters.workspace.syntaxErrorPattern: requires $FILE in args",
      ),
    ]);
  });
});
