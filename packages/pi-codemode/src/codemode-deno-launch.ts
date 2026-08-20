import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

/** Fully resolved Deno command for one persistent CodeMode worker process. */
export type CodeModeDenoLaunch = {
  readonly command: string;
  readonly args: readonly string[];
};

const denoPlatformPackages = new Map([
  ["darwin-arm64", "@deno/darwin-arm64"],
  ["darwin-x64", "@deno/darwin-x64"],
  ["linux-arm64", "@deno/linux-arm64-glibc"],
  ["linux-x64", "@deno/linux-x64-glibc"],
  ["win32-arm64", "@deno/win32-arm64"],
  ["win32-x64", "@deno/win32-x64"],
]);

/** Resolves the pinned installed Deno binary and denied-permission worker command. */
export function resolveCodeModeDenoLaunch(
  workerPath: string,
  sessionId: string,
): CodeModeDenoLaunch {
  const packageDirectory = dirname(dirname(workerPath));
  const packageRequire = createRequire(resolve(packageDirectory, "package.json"));
  const denoPackageJson = packageRequire.resolve("deno/package.json");
  const denoRequire = createRequire(denoPackageJson);
  const platformPackage = denoPlatformPackages.get(`${process.platform}-${process.arch}`);
  if (platformPackage === undefined) {
    throw new Error(
      `Pi CodeMode: Deno process does not support ${process.platform}-${process.arch}`,
    );
  }
  const denoPlatformDirectory = dirname(denoRequire.resolve(`${platformPackage}/package.json`));
  return {
    command: resolve(denoPlatformDirectory, process.platform === "win32" ? "deno.exe" : "deno"),
    args: [
      "run",
      "--quiet",
      "--no-prompt",
      "--no-config",
      "--no-lock",
      "--cached-only",
      "--no-npm",
      "--node-modules-dir=none",
      "--v8-flags=--max-old-space-size=128,--stack-size=1024",
      "--deny-read",
      "--deny-write",
      "--deny-net",
      "--deny-env",
      "--deny-sys",
      "--deny-run",
      "--deny-ffi",
      "--deny-import",
      workerPath,
      sessionId,
    ],
  };
}
