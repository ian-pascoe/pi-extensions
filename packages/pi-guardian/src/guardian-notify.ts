import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Show a notice when the session has UI; entries, not notices, are the durable record. */
export function notify(
  ctx: ExtensionContext,
  text: string,
  level: "info" | "warning" | "error",
): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(text, level);
  } catch {
    // A replaced session's UI is stale; nothing remains to show the notice in.
  }
}

/** A thrown value's message. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
