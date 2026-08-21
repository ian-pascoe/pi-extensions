import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import {
  createDapSessionFiles,
  MAX_DAP_RETAINED_BYTES,
  RetainedDapOutput,
} from "../src/dap-session-files.js";

test("retains the newest unread Debuggee output and reports discarded bytes", () => {
  const output = new RetainedDapOutput();

  output.append("a".repeat(MAX_DAP_RETAINED_BYTES));
  output.append("tail");

  expect(output.drain()).toEqual({
    discardedBytes: 4,
    text: `${"a".repeat(MAX_DAP_RETAINED_BYTES - 4)}tail`,
  });
  expect(output.drain()).toEqual({ discardedBytes: 0, text: "" });
});

test("writes private Result Spills and adapter stderr paths, then removes the session directory", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "pi-dap-session-"));
  const files = await createDapSessionFiles(sessionDirectory);
  try {
    const spillPath = await files.writeResultSpill("complete output");
    const traversalPath = await files.getAdapterStderrPath();
    const stderrPath = await files.getAdapterStderrPath();

    expect(await readFile(spillPath, "utf8")).toBe("complete output");
    expect(dirname(traversalPath)).toBe(files.directoryPath);
    expect(await readFile(stderrPath)).toEqual(Buffer.alloc(0));
    expect((await stat(files.directoryPath)).mode & 0o777).toBe(0o700);
    expect((await stat(spillPath)).mode & 0o777).toBe(0o600);

    await files.close();
    await expect(stat(files.directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(files.writeResultSpill("late")).rejects.toThrow(
      "Pi DAP: session files are closed",
    );
  } finally {
    await files.close();
    await rm(sessionDirectory, { force: true, recursive: true });
  }
});
