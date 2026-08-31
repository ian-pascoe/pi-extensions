import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import {
  MinimalSubagentsSettingsWriter,
  type MinimalSubagentsSettingsWriteResult,
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
    writer: new MinimalSubagentsSettingsWriter(context, () => agentDirectory),
  };
}

function expectWriteSucceeded(result: MinimalSubagentsSettingsWriteResult): void {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("minimal subagents settings writer", () => {
  it("creates global and trusted-project settings with private permissions", async () => {
    const harness = await createWriterHarness();

    expectWriteSucceeded(await harness.writer.writeMinimalSubagentsEnabled("global", true));
    expectWriteSucceeded(await harness.writer.writeMinimalSubagentsEnabled("project", false));

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

    expectWriteSucceeded(await harness.writer.writeMinimalSubagentsEnabled("global", true));
    expect(JSON.parse(await readFile(harness.globalPath, "utf8"))).toEqual({
      theme: "dark",
      minimalSubagents: { enabled: true, maxSubagentDepth: 3 },
    });
    expect((await stat(harness.globalPath)).mode & 0o777).toBe(0o640);

    expectWriteSucceeded(await harness.writer.writeMinimalSubagentsEnabled("global", undefined));
    expect(JSON.parse(await readFile(harness.globalPath, "utf8"))).toEqual({
      theme: "dark",
      minimalSubagents: { maxSubagentDepth: 3 },
    });

    await writeFile(harness.globalPath, JSON.stringify({ minimalSubagents: { enabled: true } }));
    expectWriteSucceeded(await harness.writer.writeMinimalSubagentsEnabled("global", undefined));
    expect(JSON.parse(await readFile(harness.globalPath, "utf8"))).toEqual({});
  });

  it.each([
    ["malformed JSON", "{ broken", "malformed-json"],
    ["array root", "[]", "incompatible-shape"],
    ["null minimalSubagents", '{"minimalSubagents":null}', "incompatible-shape"],
    ["array minimalSubagents", '{"minimalSubagents":[]}', "incompatible-shape"],
  ] as const)(
    "rejects %s without changing the original bytes",
    async (_label, original, reason) => {
      const harness = await createWriterHarness();
      await mkdir(harness.agentDirectory, { recursive: true });
      await writeFile(harness.globalPath, original);

      const result = await harness.writer.writeMinimalSubagentsEnabled("global", true);

      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "MinimalSubagentsSettingsWriteError",
          scope: "global",
          path: harness.globalPath,
          reason,
        },
      });
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

    expectWriteSucceeded(await harness.writer.writeMinimalSubagentsEnabled("global", false));

    expect(JSON.parse(await readFile(harness.globalPath, "utf8"))).toEqual({
      theme: "dark",
      minimalSubagents: { enabled: false },
    });
  });

  it("refuses an untrusted project before creating its settings directory", async () => {
    const harness = await createWriterHarness(false);

    const result = await harness.writer.writeMinimalSubagentsEnabled("project", true);

    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "MinimalSubagentsSettingsWriteError",
        scope: "project",
        path: harness.projectPath,
        reason: "project-untrusted",
      },
    });
    await expect(stat(join(harness.cwd, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent writes from separate writer instances", async () => {
    const harness = await createWriterHarness();
    const secondWriter = new MinimalSubagentsSettingsWriter(
      { cwd: harness.cwd, isProjectTrusted: () => true },
      () => harness.agentDirectory,
    );

    const [first, second] = await Promise.all([
      harness.writer.writeMinimalSubagentsEnabled("global", true),
      secondWriter.writeMinimalSubagentsEnabled("global", false),
    ]);

    expectWriteSucceeded(first);
    expectWriteSucceeded(second);
    expect(JSON.parse(await readFile(harness.globalPath, "utf8"))).toEqual({
      minimalSubagents: { enabled: false },
    });
  });

  it("waits for a proper-lockfile holder and re-reads unrelated edits under the lock", async () => {
    const harness = await createWriterHarness();
    await mkdir(harness.agentDirectory, { recursive: true });
    await writeFile(harness.globalPath, JSON.stringify({ theme: "light" }));
    const release = await lockfile.lock(harness.globalPath, { realpath: false });

    const pendingWrite = harness.writer.writeMinimalSubagentsEnabled("global", true);
    await writeFile(harness.globalPath, JSON.stringify({ theme: "dark", editorPaddingX: 1 }));
    await release();
    const result = await pendingWrite;

    expectWriteSucceeded(result);
    expect(JSON.parse(await readFile(harness.globalPath, "utf8"))).toEqual({
      theme: "dark",
      editorPaddingX: 1,
      minimalSubagents: { enabled: true },
    });
  });

  it("leaves no temporary file when the destination directory is not writable", async () => {
    const harness = await createWriterHarness();
    await mkdir(harness.agentDirectory, { recursive: true });
    await writeFile(harness.globalPath, "{}", { mode: 0o600 });
    await chmod(harness.agentDirectory, 0o500);

    try {
      const result = await harness.writer.writeMinimalSubagentsEnabled("global", true);
      expect(result).toMatchObject({ ok: false });
      expect(
        (await readdir(harness.agentDirectory)).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
      await expect(readFile(harness.globalPath, "utf8")).resolves.toBe("{}");
    } finally {
      await chmod(harness.agentDirectory, 0o700);
    }
  });
});
