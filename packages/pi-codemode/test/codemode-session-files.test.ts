import { access, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createCodeModeSessionFiles,
  type CodeModeSessionFiles,
} from "../src/codemode-session-files.js";

const sessionFiles = new Set<CodeModeSessionFiles>();

async function createSessionFiles(sessionDirectory: string): Promise<CodeModeSessionFiles> {
  const files = await createCodeModeSessionFiles(sessionDirectory);
  sessionFiles.add(files);
  return files;
}

afterEach(async () => {
  await Promise.all([...sessionFiles].map((files) => files.close()));
  sessionFiles.clear();
});

describe("CodeMode Session Files", () => {
  test("writes complete Result Spill output privately", async () => {
    const files = await createSessionFiles(tmpdir());
    const output = "first line\n".repeat(4_000);

    const spill = files.writeResultSpill(output);
    await spill.completion;

    expect(await readFile(spill.path, "utf8")).toBe(output);
    expect(dirname(spill.path)).toBe(files.directoryPath);
    expect(spill.path).toMatch(/result-spill-0\.txt$/);
    if (process.platform !== "win32") {
      expect((await stat(files.directoryPath)).mode & 0o777).toBe(0o700);
      expect((await stat(spill.path)).mode & 0o777).toBe(0o600);
    }
  });

  test("finishes queued spills before close removes their private directory", async () => {
    const files = await createSessionFiles(tmpdir());
    const spill = files.writeResultSpill("queued output");
    const close = files.close();

    await spill.completion;
    await close;

    await expect(access(spill.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("closes idempotently and rejects subsequent spill writes with a stable error", async () => {
    const files = await createSessionFiles(tmpdir());
    const directoryPath = files.directoryPath;

    await Promise.all([files.close(), files.close()]);

    await expect(access(join(directoryPath, "anything"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(files.writeResultSpill("after close").completion).rejects.toThrow(
      "Pi CodeMode: session files are closed",
    );
  });
});
