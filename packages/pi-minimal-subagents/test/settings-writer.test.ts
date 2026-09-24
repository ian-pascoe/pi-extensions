import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type MinimalSubagentsSettingsScope,
  writeMinimalSubagentsEnabled,
} from "../src/minimal-subagents-settings-writer.js";

const temporaryDirectories: string[] = [];

async function createWriterHarness(projectTrusted = true) {
  const root = await mkdtemp(join(tmpdir(), "minimal-subagents-settings-"));
  temporaryDirectories.push(root);
  const agentDirectory = join(root, "agent");
  const cwd = join(root, "project");
  const context = {
    cwd,
    isProjectTrusted: () => projectTrusted,
  };
  return {
    agentDirectory,
    cwd,
    globalPath: join(agentDirectory, "settings.json"),
    projectPath: join(cwd, ".pi", "settings.json"),
    write: (scope: MinimalSubagentsSettingsScope, enabled: boolean | undefined) =>
      writeMinimalSubagentsEnabled(context, agentDirectory, scope, enabled),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("minimal subagents settings writer", () => {
  it("creates global and trusted-project settings with private permissions", async () => {
    const harness = await createWriterHarness();

    await expect(harness.write("global", true)).resolves.toBeDefined();
    await expect(harness.write("project", false)).resolves.toBeDefined();

    await expect(readFile(harness.globalPath, "utf8")).resolves.toBe(
      '{\n  "minimalSubagents": {\n    "enabled": true\n  }\n}\n',
    );
    await expect(readFile(harness.projectPath, "utf8")).resolves.toBe(
      '{\n  "minimalSubagents": {\n    "enabled": false\n  }\n}\n',
    );
    expect((await stat(harness.globalPath)).mode & 0o777).toBe(0o600);
    expect((await stat(harness.projectPath)).mode & 0o777).toBe(0o600);
  });

  it("changes only enabled, preserves the existing mode, and removes an empty section on reset", async () => {
    const harness = await createWriterHarness();
    await mkdir(harness.agentDirectory, { recursive: true });
    await writeFile(
      harness.globalPath,
      JSON.stringify({ theme: "dark", minimalSubagents: { enabled: false, maxSubagentDepth: 3 } }),
      { mode: 0o640 },
    );

    await expect(harness.write("global", true)).resolves.toBeDefined();
    expect(JSON.parse(await readFile(harness.globalPath, "utf8"))).toEqual({
      theme: "dark",
      minimalSubagents: { enabled: true, maxSubagentDepth: 3 },
    });
    expect((await stat(harness.globalPath)).mode & 0o777).toBe(0o640);

    await expect(harness.write("global", undefined)).resolves.toBeDefined();
    expect(JSON.parse(await readFile(harness.globalPath, "utf8"))).toEqual({
      theme: "dark",
      minimalSubagents: { maxSubagentDepth: 3 },
    });

    await writeFile(harness.globalPath, JSON.stringify({ minimalSubagents: { enabled: true } }));
    await expect(harness.write("global", undefined)).resolves.toBeDefined();
    expect(JSON.parse(await readFile(harness.globalPath, "utf8"))).toEqual({});
  });

  it.each([
    ["malformed JSON", "{ broken", "JSON is malformed"],
    ["array root", "[]", "must have an object root"],
    ["null minimalSubagents", '{"minimalSubagents":null}', "must have an object minimalSubagents"],
    ["array minimalSubagents", '{"minimalSubagents":[]}', "must have an object minimalSubagents"],
  ] as const)(
    "rejects %s without changing the original bytes",
    async (_label, original, message) => {
      const harness = await createWriterHarness();
      await mkdir(harness.agentDirectory, { recursive: true });
      await writeFile(harness.globalPath, original);

      await expect(harness.write("global", true)).rejects.toThrow(message);
      await expect(readFile(harness.globalPath, "utf8")).resolves.toBe(original);
      expect(
        (await readdir(harness.agentDirectory)).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
    },
  );

  it("strips a UTF-8 BOM before parsing", async () => {
    const harness = await createWriterHarness();
    await mkdir(harness.agentDirectory, { recursive: true });
    await writeFile(harness.globalPath, '\uFEFF{"theme":"dark"}');

    await expect(harness.write("global", false)).resolves.toBeDefined();

    expect(JSON.parse(await readFile(harness.globalPath, "utf8"))).toEqual({
      theme: "dark",
      minimalSubagents: { enabled: false },
    });
  });

  it("refuses an untrusted project before creating its settings directory", async () => {
    const harness = await createWriterHarness(false);

    await expect(harness.write("project", true)).rejects.toThrow(
      `project is not trusted: ${harness.projectPath}`,
    );
    await expect(stat(join(harness.cwd, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent writes", async () => {
    const harness = await createWriterHarness();
    const completed: boolean[] = [];
    const write = async (enabled: boolean) => {
      await harness.write("global", enabled);
      completed.push(enabled);
    };

    await Promise.all([write(true), write(false)]);

    expect(JSON.parse(await readFile(harness.globalPath, "utf8"))).toEqual({
      minimalSubagents: { enabled: completed.at(-1) },
    });
  });

  it("leaves no temporary file when the destination directory is not writable", async () => {
    const harness = await createWriterHarness();
    await mkdir(harness.agentDirectory, { recursive: true });
    await writeFile(harness.globalPath, "{}", { mode: 0o600 });
    await chmod(harness.agentDirectory, 0o500);

    try {
      await expect(harness.write("global", true)).rejects.toThrow();
      expect(
        (await readdir(harness.agentDirectory)).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
      await expect(readFile(harness.globalPath, "utf8")).resolves.toBe("{}");
    } finally {
      await chmod(harness.agentDirectory, 0o700);
    }
  });
});
