import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { expect, test } from "vitest";
import { createLspSessionFiles } from "../src/lsp-session-files.js";

test("writes complete Result Spill output to a private session directory", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "pi-lsp-session-"));
  const files = await createLspSessionFiles(sessionDirectory);
  try {
    const spillPath = await files.writeResultSpill("full output\nwith every line");

    expect(await readFile(spillPath, "utf8")).toBe("full output\nwith every line");
    expect((await stat(files.directoryPath)).mode & 0o777).toBe(0o700);
    expect((await stat(spillPath)).mode & 0o777).toBe(0o600);
  } finally {
    await files.close();
    await rm(sessionDirectory, { force: true, recursive: true });
  }
});

test("reserves empty mode-safe stderr paths and removes session files on shutdown", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "pi-lsp-session-"));
  const files = await createLspSessionFiles(sessionDirectory);
  try {
    const emptyStderrPath = await files.getServerStderrPath("empty-server");
    const traversalStderrPath = await files.getServerStderrPath("../../outside-session-files");

    expect(await readFile(emptyStderrPath)).toEqual(Buffer.alloc(0));
    expect(dirname(traversalStderrPath)).toBe(files.directoryPath);
    expect((await stat(emptyStderrPath)).mode & 0o777).toBe(0o600);

    await files.close();
    await expect(stat(files.directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(files.writeResultSpill("late output")).rejects.toThrow(
      "Pi LSP: session files are closed",
    );
  } finally {
    await files.close();
    await rm(sessionDirectory, { force: true, recursive: true });
  }
}, 15_000);
