import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, test } from "vitest";

const executeFile = promisify(execFile);

describe("shipped CodeMode Deno process", () => {
  test("evaluates the Step 1 tracer in QuickJS and exits", async () => {
    await executeFile(
      process.execPath,
      [
        resolve(import.meta.dirname, "../../../scripts/codemode-worker-smoke.mjs"),
        resolve(import.meta.dirname, "../src/codemode-worker.ts"),
        "workspace",
      ],
      { timeout: 30_000 },
    );
  });

  test("reports debug QuickJS module memory after disposing tracer handles", async () => {
    await executeFile(
      process.execPath,
      [
        resolve(import.meta.dirname, "../../../scripts/codemode-worker-smoke.mjs"),
        resolve(import.meta.dirname, "../src/codemode-worker.ts"),
        "workspace debug memory",
        "debug",
      ],
      { timeout: 30_000 },
    );
  });
});
