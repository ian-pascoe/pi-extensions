import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ExitNotice } from "./termctrl-registry.js";
import type { TerminalExit } from "./terminal-driver.js";

/** `customType` of Exit notification messages. */
export const EXIT_NOTIFICATION_TYPE = "pi-termctrl.exit";

const ExitNotificationDetailsSchema = Type.Object({
  exits: Type.Array(
    Type.Object({
      id: Type.String(),
      kind: Type.Union([Type.Literal("terminal"), Type.Literal("background_job")]),
      command: Type.String(),
      exit_code: Type.Union([Type.Number(), Type.Null()]),
      signal: Type.Union([Type.String(), Type.Null()]),
      duration_ms: Type.Number(),
      log_path: Type.Optional(Type.String()),
    }),
  ),
});
/** Structured details carried by an Exit notification message. */
export type ExitNotificationDetails = Static<typeof ExitNotificationDetailsSchema>;

/** Describe how a process ended in words the agent and user both read. */
export function describeExitStatus(exit: TerminalExit): string {
  if (exit.signal !== null && exit.code !== null)
    return `exited with code ${exit.code} (${exit.signal})`;
  if (exit.signal !== null) return `ended by ${exit.signal}`;
  return `exited with code ${exit.code ?? "unknown"}`;
}

/** Format a duration as `850ms`, `12s`, `3m 4s` or `2h 5m`. */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The last `count` lines of `output`, without trailing blank lines. */
export function lastLines(output: string, count: number): string {
  if (count === 0) return "";
  const lines = output.replace(/\n+$/u, "").split("\n");
  return lines.slice(-count).join("\n");
}

function headline(notice: ExitNotice): string {
  const label = notice.kind === "terminal" ? "Terminal" : "Background job";
  return `${label} ${notice.id} ${describeExitStatus(notice.exit)} after ${formatDuration(notice.durationMs)}: ${notice.command}`;
}

/** Where the agent finds the rest of an exited entry's output. */
function pointer(notice: ExitNotice): string {
  if (notice.logPath !== undefined) return `Log: ${notice.logPath}`;
  return `terminal_send {"id": "${notice.id}"} returns its final screen.`;
}

/**
 * Describe one exit: what ended and how, where its full output is, and its last `tailLines` lines.
 * Exit notifications and `terminal_wait` results share this text.
 */
export function formatExitNotice(notice: ExitNotice, tailLines: number): string {
  const head = `${headline(notice)}\n${pointer(notice)}`;
  const tail = lastLines(notice.output, tailLines);
  if (tail === "") return head;
  const source = notice.kind === "terminal" ? "final screen" : "output";
  return `${head}\nLast lines of ${source}:\n${tail}`;
}

/** The text and details of one Exit notification message. */
export interface ExitNotificationMessage {
  readonly content: string;
  readonly details: ExitNotificationDetails;
}

/** Build the message text and details for one batch of Exit notifications. */
export function formatExitNotification(
  notices: readonly ExitNotice[],
  tailLines: number,
): ExitNotificationMessage {
  return {
    content: notices.map((notice) => formatExitNotice(notice, tailLines)).join("\n\n"),
    details: {
      exits: notices.map((notice) => {
        const exit: ExitNotificationDetails["exits"][number] = {
          id: notice.id,
          kind: notice.kind === "job" ? "background_job" : "terminal",
          command: notice.command,
          exit_code: notice.exit.code,
          signal: notice.exit.signal,
          duration_ms: notice.durationMs,
        };
        if (notice.logPath !== undefined) exit.log_path = notice.logPath;
        return exit;
      }),
    },
  };
}

type ExitNotificationRenderer = MessageRenderer<ExitNotificationDetails>;
type RenderedMessage = Parameters<ExitNotificationRenderer>[0];

function messageText(content: RenderedMessage["content"]): string {
  if (Value.Check(Type.String(), content)) return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Compact renderer: one line per exit, with the full text when expanded. */
export const renderExitNotification: ExitNotificationRenderer = (
  message,
  options,
  theme,
): Component => {
  if (options.expanded || !Value.Check(ExitNotificationDetailsSchema, message.details)) {
    return new Text(theme.fg("muted", messageText(message.content)), options.outputPad, 0);
  }
  const lines = message.details.exits.map((exit) => {
    const failed = exit.exit_code !== 0 || exit.signal !== null;
    const status = describeExitStatus({ code: exit.exit_code, signal: exit.signal });
    return `${theme.fg(failed ? "warning" : "success", "■")} ${theme.bold(exit.id)} ${status} · ${formatDuration(exit.duration_ms)} · ${theme.fg("muted", exit.command)}`;
  });
  return new Text(lines.join("\n"), options.outputPad, 0);
};
