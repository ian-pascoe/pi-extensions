import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, test } from "vitest";

const executeFile = promisify(execFile);

describe("shipped CodeMode Deno process", () => {
  test("executes a native TypeScript Cell and exits cleanly", async () => {
    await executeFile(
      process.execPath,
      [
        resolve(import.meta.dirname, "../../../scripts/codemode-worker-smoke.mjs"),
        resolve(import.meta.dirname, "../src/codemode-worker.ts"),
        "workspace native TypeScript",
      ],
      { timeout: 30_000 },
    );
  });
});
