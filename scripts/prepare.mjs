import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const omittedDependencyKinds = new Set(
  (process.env.npm_config_omit ?? "").split(/\s+/).filter(Boolean),
);
// ponytail: npm>=7 expresses production installs through npm_config_omit.
const productionInstall =
  process.env.NODE_ENV === "production" || omittedDependencyKinds.has("dev");

if (!productionInstall && !process.env.CI && existsSync(".git")) {
  execFileSync("bash", ["scripts/sync-reference-repos.sh"], { stdio: "inherit" });

  // Pi DAP's Supported Adapter tests need vscode-js-debug, which no package manager can install.
  // The test run fetches it again and fails there, so a flaky download never fails an install.
  try {
    const { ensureVscodeJsDebug } = await import("./fetch-vscode-js-debug.mjs");
    const { status, version } = await ensureVscodeJsDebug();
    console.log(`vscode-js-debug ${version} ${status}`);
  } catch (error) {
    console.warn(
      `Skipping the vscode-js-debug fixture: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const { default: installHuskyHooks } = await import("husky");
    const message = installHuskyHooks();
    if (message) console.warn(message);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
      console.warn("Husky is unavailable; skipping Git hook installation.");
    } else {
      throw error;
    }
  }
}
