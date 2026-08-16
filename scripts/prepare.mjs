import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const omittedDependencyKinds = new Set(
  (process.env.npm_config_omit ?? "").split(/\s+/).filter(Boolean),
);
const productionInstall =
  process.env.NODE_ENV === "production" ||
  process.env.npm_config_production === "true" ||
  omittedDependencyKinds.has("dev");

if (!productionInstall && existsSync(".git")) {
  execFileSync("bash", ["scripts/sync-reference-repos.sh"], { stdio: "inherit" });

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
