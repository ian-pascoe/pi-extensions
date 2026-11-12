import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
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

  releaseHuskyHooksPath();
  // Installs the Vite+ hook dispatcher for the hooks in .vite-hooks, unless this clone ran
  // `vp hooks disable` or VP_GIT_HOOKS=0 is set.
  execFileSync("vp", ["config", "--no-agent", "--hooks-dir", ".vite-hooks"], { stdio: "inherit" });
}

/**
 * Clones set up before Vite+ point core.hooksPath at Husky's generated `.husky/_`, and `vp config`
 * never replaces a hooks path it did not set. Hand the clone over once.
 */
function releaseHuskyHooksPath() {
  let hooksPath = "";
  try {
    hooksPath = execFileSync("git", ["config", "--local", "--get", "core.hooksPath"], {
      encoding: "utf8",
    }).trim();
  } catch {
    // Exit status 1: core.hooksPath is unset.
    return;
  }
  if (hooksPath !== ".husky/_") return;
  execFileSync("git", ["config", "--local", "--unset", "core.hooksPath"]);
  rmSync(".husky/_", { recursive: true, force: true });
  if (existsSync(".husky") && readdirSync(".husky").length === 0) rmdirSync(".husky");
}
