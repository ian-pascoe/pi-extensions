/** Console methods captured from a CodeMode Cell in call order. */
export const CODEMODE_CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

/** One supported CodeMode Cell Console method. */
export type CodeModeConsoleMethod = (typeof CODEMODE_CONSOLE_METHODS)[number];

/** One captured CodeMode Cell Console call without a synthetic trailing newline. */
export type CodeModeConsoleEntry = {
  readonly method: CodeModeConsoleMethod;
  readonly text: string;
};
