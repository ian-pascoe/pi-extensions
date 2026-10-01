import { accessSync, constants } from "node:fs";
import { resolveTerminalControlBinary } from "@kitlangton/terminal-control";

/** Whether a usable `termctrl` executable exists for Terminal tools. */
export type TermctrlBinaryResolution =
  | { readonly kind: "available"; readonly path: string }
  | { readonly kind: "missing"; readonly reason: string };

/** Resolve the termctrl binary through the SDK, which honours `TERMCTRL_BINARY`, and verify it runs. */
export function resolveTermctrlBinary(
  resolve: () => string = () => resolveTerminalControlBinary(),
): TermctrlBinaryResolution {
  let path: string;
  try {
    path = resolve();
  } catch (error) {
    return { kind: "missing", reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return { kind: "missing", reason: `termctrl binary ${path} is not executable` };
  }
  return { kind: "available", path };
}
