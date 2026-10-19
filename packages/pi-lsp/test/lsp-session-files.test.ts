import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { expect, test } from "vitest";
import { createLspSessionFiles } from "../src/lsp-session-files.js";

test.each(["persisted", "in-memory"])(
  "writes private Result Spills and cleans up for %s Pi sessions",
  async (mode) => {
    const sessionDirectory =
      mode === "persisted" ? await mkdtemp(join(tmpdir(), "pi-lsp-session-")) : "";
    const files = await createLspSessionFiles(sessionDirectory);
    try {
      const spillPath = await files.writeResultSpill("full output\nwith every line");

      expect(dirname(files.directoryPath)).toBe(sessionDirectory || tmpdir());
      expect(await readFile(spillPath, "utf8")).toBe("full output\nwith every line");
      expect((await stat(files.directoryPath)).mode & 0o777).toBe(0o700);
      expect((await stat(spillPath)).mode & 0o777).toBe(0o600);

      await files.close();
      await expect(stat(files.directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await files.close();
      if (sessionDirectory !== "") {
        await rm(sessionDirectory, { force: true, recursive: true });
      }
    }
  },
);

test("rejects writes after removing session files on shutdown", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "pi-lsp-session-"));
  const files = await createLspSessionFiles(sessionDirectory);
  try {
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
