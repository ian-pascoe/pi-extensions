import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import tpsTrackerExtension from "./tps-tracker-core.js";

/**
 * Skips loading when `PI_DISABLED_EXTENSIONS`, a comma- or space-separated list of package
 * names, names this package. Pi's `--no-extensions` and settings filters cannot turn off one
 * package for a single process, so a launcher sets this variable instead.
 */
export default function loadTpsTrackerUnlessDisabled(pi: ExtensionAPI) {
  const disabled = (process.env.PI_DISABLED_EXTENSIONS ?? "").split(/[\s,]+/);
  if (disabled.includes("pi-tps-tracker") || disabled.includes("@ian-pascoe/pi-tps-tracker"))
    return;
  tpsTrackerExtension(pi);
}
