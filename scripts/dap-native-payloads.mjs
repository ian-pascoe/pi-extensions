import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const dapPackageDirectory = fileURLToPath(new URL("../packages/pi-dap/", import.meta.url));
export const dapNativeTargets = [
  { arch: "x64", target: "x86_64-windows-gnu", machine: 0x8664 },
  { arch: "arm64", target: "aarch64-windows-gnu", machine: 0xaa64 },
];

export function dapNativePayloadPath(directory, arch) {
  return resolve(directory, "src", "native", `win32-${arch}`, "dap-runtime-probe.exe");
}

export async function assertDapNativePayloads(directory) {
  const noticePath = "src/native/THIRD-PARTY-NOTICES.txt";
  const notices = await readFile(resolve(directory, noticePath));
  assert.match(notices.toString("utf8"), /Copyright \(c\) Zig contributors/);
  assert.deepEqual(
    notices,
    await readFile(resolve(dapPackageDirectory, noticePath)),
    `${directory}: bundled runtime notices differ from the repository`,
  );
  for (const { arch, machine } of dapNativeTargets) {
    const path = dapNativePayloadPath(directory, arch);
    const bytes = await readFile(path);
    assert.equal(bytes.toString("ascii", 0, 2), "MZ", `${path}: missing DOS header`);
    const pe = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.readUInt32LE(pe), 0x4550, `${path}: missing PE signature`);
    assert.equal(bytes.readUInt16LE(pe + 4), machine, `${path}: wrong architecture`);
    assert.equal(bytes.readUInt16LE(pe + 24), 0x20b, `${path}: expected PE32+`);
    assert.deepEqual(
      bytes,
      await readFile(dapNativePayloadPath(dapPackageDirectory, arch)),
      `${path}: differs from the repository payload`,
    );
  }
}
