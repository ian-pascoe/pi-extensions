import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  assertDapNativePayloads,
  dapNativePayloadPath,
  dapNativeTargets,
  dapPackageDirectory,
} from "./dap-native-payloads.mjs";

// Build-time tools only. Normal installs and verification never compile payloads.
assert(
  process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--write"),
  "Usage: node scripts/build-dap-native.mjs [--write]",
);
assert.equal(execFileSync("zig", ["version"], { encoding: "utf8" }).trim(), "0.16.0");
const directory = await mkdtemp(resolve(tmpdir(), "dap-native-build-"));
try {
  for (const { arch, target } of dapNativeTargets) {
    const output = resolve(directory, `${arch}.exe`);
    execFileSync(
      "zig",
      [
        "cc",
        "-target",
        target,
        "-municode",
        "-Os",
        "-s",
        "-Wall",
        "-Wextra",
        "-Werror",
        "native/windows-runtime-probe.c",
        "-o",
        output,
      ],
      { cwd: dapPackageDirectory, stdio: "inherit" },
    );
    const imports = execFileSync("llvm-readobj", ["--coff-imports", output], { encoding: "utf8" });
    const names = [...imports.matchAll(/^\s+Name: (.+)$/gm)].map((match) => match[1]);
    assert(names.length > 0, `${arch}: expected native import descriptors`);
    // Windows 10+ supplies UCRT API sets; no VC redistributable/MinGW DLLs.
    for (const name of names) {
      assert(
        /^(?:KERNEL32\.dll|api-ms-win-crt-(?:environment|heap|private|runtime|stdio|string|math)-l1-1-0\.dll)$/i.test(
          name,
        ),
        `${arch}: unexpected runtime prerequisite ${name}`,
      );
    }
    const bytes = await readFile(output);
    const destination = dapNativePayloadPath(dapPackageDirectory, arch);
    if (process.argv[2] === "--write") {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    } else {
      assert.deepEqual(
        bytes,
        await readFile(destination),
        `${arch}: rebuild differs; review and regenerate with --write`,
      );
    }
    console.log(
      `${arch} sha256=${createHash("sha256").update(bytes).digest("hex")} imports=${names.join(",")}`,
    );
  }
  await assertDapNativePayloads(dapPackageDirectory);
} finally {
  await rm(directory, { recursive: true, force: true });
}
