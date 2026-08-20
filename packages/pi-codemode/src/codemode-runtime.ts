import { randomUUID } from "node:crypto";

/** Timer handle returned by the parent Node runtime. */
export type CodeModeTimerHandle = ReturnType<typeof setTimeout>;

/** Parent-runtime capabilities consumed by CodeMode resource owners. */
export type CodeModeRuntime = {
  /** Produces a candidate identifier for a new CodeMode Session. */
  readonly createSessionId: () => string;
  /** Reads parent wall-clock time in milliseconds since the Unix epoch. */
  readonly now: () => number;
  /** Schedules one parent-side watchdog or process lifecycle deadline. */
  readonly setTimeout: (callback: () => void, delayMs: number) => CodeModeTimerHandle;
  /** Cancels one parent-side deadline. */
  readonly clearTimeout: (handle: CodeModeTimerHandle) => void;
};

/** Production Node clock and UUID capabilities for the Pi extension composition root. */
export const CODEMODE_SYSTEM_RUNTIME: CodeModeRuntime = {
  createSessionId: randomUUID,
  now: Date.now,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};
