import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import spawn from "cross-spawn";
import type { FormatterDefinition } from "./pi-formatter-settings.js";

const MAX_FORMATTER_OUTPUT_CHARACTERS = 50_000;

type FormatterCommandFailure =
  | { readonly kind: "spawn_error"; readonly message: string }
  | { readonly kind: "timeout"; readonly timeoutMs: number }
  | {
      readonly kind: "exit_error";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stderr: string;
    };

function formatterProcessEnvironment(configured: FormatterDefinition["environment"]) {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(configured)) {
    if (value === null) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

export function runFormatterCommand(
  definition: FormatterDefinition,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  path: string | undefined,
  onStdout?: (stdout: string) => void,
): Promise<FormatterCommandFailure | undefined> {
  const run = () =>
    new Promise<FormatterCommandFailure | undefined>((complete) => {
      let stdout = "";
      let stderr = "";
      let failure: FormatterCommandFailure | undefined;
      try {
        signal?.throwIfAborted();
        const child = spawn(definition.command, args, {
          cwd,
          env: formatterProcessEnvironment(definition.environment),
          shell: false,
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: ["ignore", onStdout ? "pipe" : "ignore", "pipe"],
        });
        const kill = () => {
          if (!child.pid) return;
          if (process.platform === "win32") {
            const killer = spawn(
              join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
              ["/pid", String(child.pid), "/T", "/F"],
              { stdio: "ignore", windowsHide: true },
            );
            killer.on("error", () => child.kill("SIGKILL"));
            killer.on("close", (code) => {
              if (code !== 0) child.kill("SIGKILL");
            });
          } else {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };
        const cancel = () => {
          failure = { kind: "spawn_error", message: "Formatting cancelled" };
          kill();
        };
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        const timer = setTimeout(() => {
          failure = { kind: "timeout", timeoutMs };
          kill();
        }, timeoutMs);
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout = (stdout + chunk).slice(-MAX_FORMATTER_OUTPUT_CHARACTERS);
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-MAX_FORMATTER_OUTPUT_CHARACTERS);
        });
        child.on("error", (cause: Error) => {
          failure = { kind: "spawn_error", message: cause.message };
        });
        child.on("close", (exitCode, signalName) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          onStdout?.(stdout);
          complete(
            failure ??
              (exitCode === 0
                ? undefined
                : {
                    kind: "exit_error",
                    exitCode,
                    signal: signalName,
                    stderr: stderr.trim(),
                  }),
          );
        });
      } catch (cause) {
        complete({
          kind: "spawn_error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    });
  return (path === undefined ? run() : withFileMutationQueue(path, run)).catch((cause) => ({
    kind: "spawn_error",
    message: cause instanceof Error ? cause.message : String(cause),
  }));
}

export function formatFormatterFailure(
  definition: FormatterDefinition,
  target: string,
  failure: FormatterCommandFailure,
): string {
  if (failure.kind === "spawn_error")
    return `Pi Formatter: ${definition.id} failed for ${target} (spawn error): ${failure.message}`;
  if (failure.kind === "timeout")
    return `Pi Formatter: ${definition.id} failed for ${target} (timeout after ${failure.timeoutMs}ms)`;
  const status =
    failure.exitCode === null
      ? `signal ${failure.signal ?? "unknown"}`
      : `exit code ${failure.exitCode}`;
  return `Pi Formatter: ${definition.id} failed for ${target} (${status})${failure.stderr === "" ? "" : `: ${failure.stderr}`}`;
}
