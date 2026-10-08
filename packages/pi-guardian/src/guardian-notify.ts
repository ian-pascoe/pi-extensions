import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { noticeText } from "@ian-pascoe/pi-utils/ui";

/**
 * Show a notice when the session has UI; entries, not notices, are the durable record. Warnings
 * and errors read `Guardian: <text>`; info notices carry no prefix.
 */
export function notify(
  ctx: ExtensionContext,
  text: string,
  level: "info" | "warning" | "error",
): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(level === "info" ? text : noticeText("Guardian", text), level);
  } catch {
    // A replaced session's UI is stale; nothing remains to show the notice in.
  }
}

/** A thrown value's message. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
