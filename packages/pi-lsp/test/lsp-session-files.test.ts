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

test("keeps only the latest 1 MB of server stderr and removes session files on shutdown", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "pi-lsp-session-"));
  const files = await createLspSessionFiles(sessionDirectory);
  try {
    const firstChunk = Buffer.alloc(800 * 1024, 0x61);
    const secondChunk = Buffer.alloc(800 * 1024, 0x62);
    const emptyStderrPath = await files.getServerStderrPath("empty-server");
    const traversalStderrPath = await files.getServerStderrPath("../../outside-session-files");
    const stderrPath = await files.appendServerStderr("typescript", firstChunk);
    await files.appendServerStderr("typescript", secondChunk);

    expect(await readFile(emptyStderrPath)).toEqual(Buffer.alloc(0));
    expect(dirname(traversalStderrPath)).toBe(files.directoryPath);
    expect(await readFile(stderrPath)).toEqual(
      Buffer.concat([Buffer.alloc(224 * 1024, 0x61), secondChunk]),
    );
    expect((await stat(stderrPath)).mode & 0o777).toBe(0o600);

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
