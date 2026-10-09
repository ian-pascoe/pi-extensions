import type { Key } from "@kitlangton/terminal-control";
import type { TerminalViewport } from "./pi-termctrl-settings.js";

/** How a Terminal's process ended, as termctrl reports it. */
export interface TerminalExit {
  readonly code: number | null;
  readonly signal: string | null;
}

/** A zero-based screen position: `x` counts columns from the left, `y` rows from the top. */
export interface ScreenPosition {
  readonly x: number;
  readonly y: number;
}

/** One polled view of a Terminal: the visible screen plus process state. */
export interface TerminalSnapshot {
  readonly screen: string;
  /** The cursor on the screen, or `null` while the program hides it. */
  readonly cursor: ScreenPosition | null;
  readonly state: "running" | "exited";
  readonly exit: TerminalExit | null;
  /** Milliseconds since the Terminal last produced output, when termctrl knows. */
  readonly idleForMs: number | null;
}

/** Launch request for one Terminal. `command` is the full argv, already wrapped in a shell. */
export interface TerminalLaunchRequest {
  readonly id: string;
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
  readonly viewport: TerminalViewport;
}

/** A running or exited Terminal inside one driver. Every call is a short driver request. */
export interface TerminalHandle {
  snapshot(): Promise<TerminalSnapshot>;
  /** Line-oriented output history of the current screen buffer, including the visible screen. */
  logs(): Promise<string>;
  type(text: string): Promise<void>;
  press(keys: readonly Key[]): Promise<void>;
  /** Ask termctrl to stop the Terminal and forget it. */
  stop(): Promise<void>;
  /** Whether the Terminal's process is known to still run. False when its pid is unknown. */
  isAlive(): boolean;
  /** Send SIGKILL to the Terminal's process group when termctrl does not stop it. */
  kill(): void;
}

/** One termctrl driver process hosting many Terminals. */
export interface TerminalDriver {
  launch(request: TerminalLaunchRequest): Promise<TerminalHandle>;
  close(): Promise<void>;
}

/** Recognises the SDK errors that mean the driver child process is gone. */
export function isDriverGone(error: Error): boolean {
  return /termctrl driver (?:exited|is closed)/u.test(error.message);
}
