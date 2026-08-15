import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { BrvBridge } from "@byterover/brv-bridge";
import { afterEach, describe, expect, test } from "vitest";
import * as z from "zod/v4";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("byterover-cli package smoke", () => {
  test("runs the pinned CLI and recognizes isolated ByteRover state", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-byterover-cli-"));
    temporaryDirectories.push(temporaryRoot);
    const home = join(temporaryRoot, "home");
    const project = join(temporaryRoot, "project");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(project, { recursive: true }),
      mkdir(join(project, ".brv"), { recursive: true }),
    ]);

    const cliPackagePath = require.resolve("byterover-cli/package.json");
    const cliPackageSchema = z.object({ bin: z.object({ brv: z.string() }) });
    const cliPackage = cliPackageSchema.parse(JSON.parse(await readFile(cliPackagePath, "utf8")));
    const cliBin = cliPackage.bin.brv;
    expect(cliBin).toBeTypeOf("string");

    const cliEntrypoint = resolve(dirname(cliPackagePath), cliBin);
    const isolatedEnvironment = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      NO_UPDATE_NOTIFIER: "1",
    };
    const previousEnvironment = Object.fromEntries(
      Object.keys(isolatedEnvironment).map((key) => [key, process.env[key]]),
    );

    try {
      Object.assign(process.env, isolatedEnvironment);
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [cliEntrypoint, "--version"],
        {
          cwd: project,
          env: { ...process.env },
          timeout: 15_000,
        },
      );

      expect(`${stdout}${stderr}`).toContain("3.16.1");
      await expect(new BrvBridge({ cwd: project }).ready()).resolves.toBe(true);
    } finally {
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 20_000);
});
