import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piGitCheckpointsExtension from "./pi-git-checkpoints-extension.js";

/**
 * `PI_DISABLED_EXTENSIONS` lists package names, separated by commas or spaces, that a launcher
 * turns off for one process: a host such as T3 Code that checkpoints turns itself.
 */
export default function (pi: ExtensionAPI) {
  const disabled = (process.env.PI_DISABLED_EXTENSIONS ?? "").split(/[\s,]+/);
  if (
    disabled.includes("pi-git-checkpoints") ||
    disabled.includes("@ian-pascoe/pi-git-checkpoints")
  )
    return;
  piGitCheckpointsExtension(pi);
}
