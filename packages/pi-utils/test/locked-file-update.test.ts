import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, test } from "vitest";
import { updateFileLocked } from "../src/locked-file-update.js";

const temporaryDirectories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-utils-locked-file-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("locked file update", () => {
  test("creates a private file and its parent directory", async () => {
    const path = join(await createDirectory(), "nested", "settings.json");

    await expect(updateFileLocked(path, (current) => `${current ?? "new"}\n`)).resolves.toBe(true);

    await expect(readFile(path, "utf8")).resolves.toBe("new\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("preserves the existing mode unless one is forced", async () => {
    const path = join(await createDirectory(), "settings.json");
    await writeFile(path, "a", { mode: 0o640 });

    await updateFileLocked(path, (current) => `${current}b`);
    expect((await stat(path)).mode & 0o777).toBe(0o640);

    await updateFileLocked(path, (current) => `${current}c`, { mode: 0o600 });
    await expect(readFile(path, "utf8")).resolves.toBe("abc");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("leaves the file untouched when the update declines or throws", async () => {
    const directory = await createDirectory();
    const path = join(directory, "settings.json");
    await writeFile(path, "original");

    await expect(updateFileLocked(path, () => undefined)).resolves.toBe(false);
    await expect(
      updateFileLocked(path, () => {
        throw new Error("invalid");
      }),
    ).rejects.toThrow("invalid");

    await expect(readFile(path, "utf8")).resolves.toBe("original");
    expect(await readdir(directory)).toEqual(["settings.json"]);
  });

  test("replaces a symlink target instead of the link", async () => {
    const directory = await createDirectory();
    const target = join(directory, "real.json");
    const path = join(directory, "settings.json");
    await writeFile(target, "old");
    await symlink(target, path);

    await updateFileLocked(path, () => "new");

    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe("new");
  });

  test("waits for Pi's settings lock and re-reads under it", async () => {
    const directory = await createDirectory();
    await mkdir(directory, { recursive: true });
    const path = join(directory, "settings.json");
    await writeFile(path, "stale");
    const release = await lockfile.lock(path, { realpath: false });

    const pending = updateFileLocked(path, (current) => `${current}+update`);
    await writeFile(path, "fresh");
    await release();
    await pending;

    await expect(readFile(path, "utf8")).resolves.toBe("fresh+update");
  });
});
