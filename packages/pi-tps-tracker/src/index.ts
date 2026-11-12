import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import tpsTrackerExtension from "./tps-tracker-core.js";

/**
 * `PI_DISABLED_EXTENSIONS` lists package names, separated by commas or spaces, that a launcher
 * turns off for one process: a host such as T3 Code that shows extension statuses and notices as plain text, with the styling escapes visible.
 */
export default function (pi: ExtensionAPI) {
  const disabled = (process.env.PI_DISABLED_EXTENSIONS ?? "").split(/[\s,]+/);
  if (disabled.includes("pi-tps-tracker") || disabled.includes("@ian-pascoe/pi-tps-tracker"))
    return;
  tpsTrackerExtension(pi);
}
