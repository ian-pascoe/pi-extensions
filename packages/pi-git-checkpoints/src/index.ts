import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piGitCheckpointsExtension from "./pi-git-checkpoints-extension.js";

/**
 * Skips loading when `PI_DISABLED_EXTENSIONS`, a comma- or space-separated list of package
 * names, names this package. Pi's `--no-extensions` and settings filters cannot turn off one
 * package for a single process, so a launcher sets this variable instead.
 */
export default function loadGitCheckpointsUnlessDisabled(pi: ExtensionAPI) {
  const disabled = (process.env.PI_DISABLED_EXTENSIONS ?? "").split(/[\s,]+/);
  if (
    disabled.includes("pi-git-checkpoints") ||
    disabled.includes("@ian-pascoe/pi-git-checkpoints")
  )
    return;
  piGitCheckpointsExtension(pi);
}
