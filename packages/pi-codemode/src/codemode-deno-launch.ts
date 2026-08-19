import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

const quickJsVariantPackages = [
  "@jitl/quickjs-wasmfile-debug-asyncify",
  "@jitl/quickjs-wasmfile-debug-sync",
  "@jitl/quickjs-wasmfile-release-asyncify",
  "@jitl/quickjs-wasmfile-release-sync",
] as const;

/** Resolves the pinned installed Deno binary and offline QuickJS import map from the package containing `workerPath`. */
export function resolveCodeModeDenoLaunch(
  workerPath: string,
  variant: "release" | "debug",
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
  const acornPackageJson = packageRequire.resolve("acorn/package.json");
  const quickJsPackageJson = packageRequire.resolve("quickjs-emscripten/package.json");
  const quickJsRequire = createRequire(quickJsPackageJson);
  const quickJsCoreDirectory = dirname(dirname(quickJsRequire.resolve("quickjs-emscripten-core")));
  const quickJsCoreRequire = createRequire(resolve(quickJsCoreDirectory, "package.json"));
  const quickJsFfiDirectory = dirname(
    quickJsCoreRequire.resolve("@jitl/quickjs-ffi-types/package.json"),
  );
  const variantImports = quickJsVariantPackages.flatMap((packageName) => {
    const variantDirectory = dirname(quickJsRequire.resolve(`${packageName}/package.json`));
    return [
      [packageName, pathToFileURL(resolve(variantDirectory, "dist/index.mjs")).href],
      [
        `${packageName}/emscripten-module`,
        pathToFileURL(resolve(variantDirectory, "dist/emscripten-module.mjs")).href,
      ],
    ];
  });
  const imports = Object.fromEntries([
    ["acorn", pathToFileURL(resolve(dirname(acornPackageJson), "dist/acorn.mjs")).href],
    [
      "quickjs-emscripten",
      pathToFileURL(resolve(dirname(quickJsPackageJson), "dist/index.mjs")).href,
    ],
    [
      "quickjs-emscripten-core",
      pathToFileURL(resolve(quickJsCoreDirectory, "dist/index.mjs")).href,
    ],
    ["@jitl/quickjs-ffi-types", pathToFileURL(resolve(quickJsFfiDirectory, "dist/index.mjs")).href],
    ...variantImports,
  ]);
  const wasmPackage =
    variant === "debug"
      ? "@jitl/quickjs-wasmfile-debug-sync"
      : "@jitl/quickjs-wasmfile-release-sync";
  const quickJsWasmDirectory = dirname(quickJsRequire.resolve(`${wasmPackage}/package.json`));
  const importMap = `data:application/json,${encodeURIComponent(JSON.stringify({ imports }))}`;
  return {
    command: resolve(denoPlatformDirectory, process.platform === "win32" ? "deno.exe" : "deno"),
    args: [
      "run",
      "--quiet",
      "--no-prompt",
      "--no-config",
      "--no-lock",
      "--cached-only",
      "--node-modules-dir=none",
      `--import-map=${importMap}`,
      `--allow-read=${quickJsWasmDirectory}`,
      "--deny-write",
      "--deny-net",
      "--deny-env",
      "--deny-sys",
      "--deny-run",
      "--deny-ffi",
      "--deny-import",
      workerPath,
      variant,
      sessionId,
    ],
  };
}
