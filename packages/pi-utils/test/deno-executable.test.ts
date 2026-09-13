import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { resolveDenoExecutable } from "../src/index.js";

const directories: string[] = [];
const hostPlatform = process.platform;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-utils-deno-"));
  directories.push(root);
  const bin = join(root, "node_modules/.bin");
  const entry = join(root, "node_modules/deno/bin.cjs");
  await mkdir(bin, { recursive: true });
  await mkdir(dirname(entry));
  await writeFile(entry, "throw new Error('npm repair wrapper must never execute');\n", {
    mode: 0o700,
  });
  await writeFile(
    join(dirname(entry), "package.json"),
    '{"name":"deno","version":"2.9.6","bin":"bin.cjs"}',
  );
  return { root, bin, entry };
}

async function payload(directory: string, name: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, "existing native payload", { mode: 0o700 });
  return path;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test.each([
  ["linux", "x64"],
  ["linux", "arm64"],
  ["darwin", "x64"],
  ["darwin", "arm64"],
  ["win32", "x64"],
  ["win32", "arm64"],
] as const)(
  "%s/%s npm wrapper uses the matching existing payload without repair",
  async (platform, arch) => {
    const { root, bin, entry } = await fixture();
    vi.stubGlobal(
      "process",
      Object.create(process, { platform: { value: platform }, arch: { value: arch } }),
    );
    const name = platform === "win32" ? "deno.exe" : "deno";
    const candidate = join(bin, platform === "win32" ? "deno.cmd" : "deno");
    // npm's Windows wrapper and pnpm's ordinary POSIX shell-shim target lines.
    const wrapper =
      platform === "win32"
        ? '@ECHO off\r\n"%_prog%"  "%dp0%\\..\\deno\\bin.cjs" %*\r\n'
        : '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/../deno/bin.cjs" "$@"\n';
    await writeFile(candidate, wrapper, { mode: 0o700 });
    const target = `${platform}-${arch}${platform === "linux" ? "-glibc" : ""}`;
    const dependency = join(root, "node_modules/@deno", target);
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({ name: `@deno/${target}`, version: "2.9.6" }),
    );
    expect(await resolveDenoExecutable(candidate)).toBeUndefined();
    const optional = await payload(dependency, name);
    expect(await resolveDenoExecutable(candidate)).toBe(optional);
    expect((await readdir(dirname(entry))).sort()).toEqual(["bin.cjs", "package.json"]);
    expect(await readFile(candidate, "utf8")).toBe(wrapper);
    expect(await readFile(entry, "utf8")).toContain("npm repair wrapper must never execute");
    const local = await payload(dirname(entry), name);
    expect(await resolveDenoExecutable(candidate)).toBe(local);
    expect(await readFile(optional, "utf8")).toBe("existing native payload");
  },
);

test.skipIf(hostPlatform === "win32")(
  "npm's POSIX symlink resolves a nested optional payload without modifying node_modules",
  async () => {
    const { bin, entry } = await fixture();
    const candidate = join(bin, "deno");
    await symlink("../deno/bin.cjs", candidate);
    const target = `${process.platform}-${process.arch}${process.platform === "linux" ? "-glibc" : ""}`;
    const dependency = join(dirname(entry), "node_modules/@deno", target);
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({ name: `@deno/${target}`, version: "2.9.6" }),
    );
    const optional = await payload(dependency, "deno");
    expect(await resolveDenoExecutable(candidate)).toBe(optional);
    expect((await readdir(dirname(entry))).sort()).toEqual([
      "bin.cjs",
      "node_modules",
      "package.json",
    ]);
  },
);

test("recognizes Deno's native Windows postinstall shim without executing cmd", async () => {
  const { bin, entry } = await fixture();
  vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
  const candidate = join(bin, "deno.cmd");
  await writeFile(candidate, '@"%~dp0..\\deno\\deno.exe" %*\r\n');
  expect(await resolveDenoExecutable(candidate)).toBeUndefined();
  const native = await payload(dirname(entry), "deno.exe");
  expect(await resolveDenoExecutable(candidate)).toBe(native);
});

test("does not adopt a native optional package for another architecture", async () => {
  const { bin, entry } = await fixture();
  vi.stubGlobal(
    "process",
    Object.create(process, { platform: { value: "linux" }, arch: { value: "arm64" } }),
  );
  const candidate = join(bin, "deno");
  await writeFile(candidate, '#!/bin/sh\nexec node "$basedir/../deno/bin.cjs" "$@"\n', {
    mode: 0o700,
  });
  const dependency = join(dirname(entry), "node_modules/@deno/linux-x64-glibc");
  await payload(dependency, "deno");
  await writeFile(
    join(dependency, "package.json"),
    '{"name":"@deno/linux-x64-glibc","version":"2.9.6"}',
  );
  expect(await resolveDenoExecutable(candidate)).toBeUndefined();
});

test.each([
  ["linux", "deno-runtime"],
  ["win32", "deno-runtime"],
  ["linux", "@tools/deno-runtime"],
  ["win32", "@tools/deno-runtime"],
] as const)(
  "%s generated shim resolves npm alias %s by package identity",
  async (platform, alias) => {
    const { root, bin, entry } = await fixture();
    vi.stubGlobal(
      "process",
      Object.create(process, { platform: { value: platform }, arch: { value: "x64" } }),
    );
    const packageRoot = join(root, "node_modules", alias);
    await mkdir(dirname(packageRoot), { recursive: true });
    await rename(dirname(entry), packageRoot);
    const candidate = join(bin, platform === "win32" ? "deno.cmd" : "deno");
    const wrapper =
      platform === "win32"
        ? `@ECHO off\r\n"C:\\node.exe" "%~dp0..\\${alias.replaceAll("/", "\\")}\\bin.cjs" %*\r\n`
        : `#!/bin/sh\nexec node "$basedir/../${alias}/bin.cjs" "$@"\n`;
    await writeFile(candidate, wrapper, { mode: 0o700 });
    const target = platform === "win32" ? "win32-x64" : "linux-x64-glibc";
    const dependency = join(root, "node_modules/@deno", target);
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({ name: `@deno/${target}`, version: "2.9.6" }),
    );
    expect(await resolveDenoExecutable(candidate)).toBeUndefined();
    const name = platform === "win32" ? "deno.exe" : "deno";
    const optional = await payload(dependency, name);
    expect(await resolveDenoExecutable(candidate)).toBe(optional);
    expect((await readdir(packageRoot)).sort()).toEqual(["bin.cjs", "package.json"]);
    const native = await payload(packageRoot, name);
    expect(await resolveDenoExecutable(candidate)).toBe(native);
    expect(await readFile(candidate, "utf8")).toBe(wrapper);
    expect(await readFile(join(packageRoot, "bin.cjs"), "utf8")).toContain("must never execute");
    await writeFile(join(packageRoot, "package.json"), '{"name":"unrelated-command"}');
    expect(await resolveDenoExecutable(candidate)).toBe(candidate);
  },
);

test.skipIf(hostPlatform === "win32")(
  "npm alias symlink resolves by package identity without running bin.cjs",
  async () => {
    const { root, bin, entry } = await fixture();
    const packageRoot = join(root, "node_modules/deno-runtime");
    await rename(dirname(entry), packageRoot);
    const candidate = join(bin, "deno");
    await symlink("../deno-runtime/bin.cjs", candidate);
    const target = `${process.platform}-${process.arch}${process.platform === "linux" ? "-glibc" : ""}`;
    const dependency = join(root, "node_modules/@deno", target);
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({ name: `@deno/${target}`, version: "2.9.6" }),
    );
    expect(await resolveDenoExecutable(candidate)).toBeUndefined();
    const optional = await payload(dependency, "deno");
    expect(await resolveDenoExecutable(candidate)).toBe(optional);
    expect((await readdir(packageRoot)).sort()).toEqual(["bin.cjs", "package.json"]);
  },
);

test.skipIf(hostPlatform !== "linux")(
  "an executable inode whose pathname vanished is unavailable",
  async () => {
    const { bin } = await fixture();
    const path = await payload(bin, "deno");
    const file = await open(path, "r");
    try {
      await rm(path);
      const candidate = `/proc/self/fd/${file.fd}`;
      expect((await stat(candidate)).isFile()).toBe(true);
      await expect(access(candidate, constants.X_OK)).resolves.toBeUndefined();
      await expect(resolveDenoExecutable(candidate)).resolves.toBeUndefined();
    } finally {
      await file.close();
    }
  },
);

test("preserves a POSIX opaque command containing a Windows shim example comment", async () => {
  const { bin, entry } = await fixture();
  vi.stubGlobal("process", Object.create(process, { platform: { value: "linux" } }));
  const candidate = join(bin, "deno");
  await payload(dirname(entry), "deno");
  await writeFile(candidate, '#!/bin/sh\n# Example "%dp0%/../deno/bin.cjs" %*\necho custom\n', {
    mode: 0o700,
  });
  expect(await resolveDenoExecutable(candidate)).toBe(candidate);
});

test.skipIf(hostPlatform === "win32" || process.getuid?.() === 0)(
  "preserves an execute-only opaque native executable",
  async () => {
    const { bin } = await fixture();
    const candidate = join(bin, "deno");
    await copyFile("/usr/bin/true", candidate);
    await chmod(candidate, 0o111);
    await expect(readFile(candidate)).rejects.toMatchObject({ code: "EACCES" });
    await expect(resolveDenoExecutable(candidate)).resolves.toBe(candidate);
  },
);

test("preserves unrelated opaque external commands, including large native files", async () => {
  const { bin } = await fixture();
  const candidate = join(bin, "deno");
  await writeFile(
    candidate,
    '#!/bin/sh\n# exec node "$basedir/../deno/bin.cjs" "$@"\necho custom\n',
    { mode: 0o700 },
  );
  expect(await resolveDenoExecutable(candidate)).toBe(candidate);
  await writeFile(candidate, Buffer.alloc(128 * 1024));
  expect(await resolveDenoExecutable(candidate)).toBe(candidate);
  expect(await resolveDenoExecutable(join(bin, "missing"))).toBeUndefined();
});
