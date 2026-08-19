import { randomUUID } from "node:crypto";

/** Timer handle returned by the parent Node runtime. */
export type CodeModeTimerHandle = ReturnType<typeof setTimeout>;

/** Parent-runtime capabilities consumed by CodeMode resource owners. */
export type CodeModeRuntime = {
  /** Produces a candidate identifier for a new CodeMode Session. */
  readonly createSessionId: () => string;
  /** Schedules one parent-side watchdog or process lifecycle deadline. */
  readonly setTimeout: (callback: () => void, delayMs: number) => CodeModeTimerHandle;
  /** Cancels one parent-side deadline. */
  readonly clearTimeout: (handle: CodeModeTimerHandle) => void;
};

/** Production Node clock and UUID capabilities for the Pi extension composition root. */
export const CODEMODE_SYSTEM_RUNTIME: CodeModeRuntime = {
  createSessionId: randomUUID,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};
