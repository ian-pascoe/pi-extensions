import { spawn } from "node:child_process";
import { join } from "node:path";

/** Short preflight only: unlike execution waits, cancellation must terminate the owned work. */
export async function probeDapRuntime(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal | undefined },
): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Only the helper holds the noninheritable kill-on-close Job handle. Its
    // CreateProcessW JOB_LIST owns the runtime before any child code can run.
    if (process.platform === "win32" && !["x64", "arm64"].includes(process.arch)) {
      reject(new Error(`DAP runtime probe is unavailable on Windows ${process.arch}`));
      return;
    }
    const child = spawn(
      process.platform === "win32"
        ? join(import.meta.dirname, `native/win32-${process.arch}/dap-runtime-probe.exe`)
        : command,
      process.platform === "win32" ? [command, ...args] : [...args],
      {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let outputBytes = 0;
    let failure: Error | undefined;
    let stopped = Promise.resolve();
    const kill = async () => {
      if (!child.pid) return;
      if (process.platform !== "win32") {
        try {
          // The dedicated group still owns descendants when its leader has exited.
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
        return;
      }
      // Terminating the owner closes its Job, including descendants of a runtime
      // leader that already exited. No PID recovery or auxiliary cleanup process.
      child.kill("SIGKILL");
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      stopped = kill().catch((cause: Error) => {
        failure = cause;
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
      });
    };
    const abort = () =>
      stop(new Error("DAP runtime probe cancelled", { cause: options.signal?.reason }));
    const timer = setTimeout(
      () => stop(new Error(`DAP runtime probe timed out: ${command}`)),
      5000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const output = (chunk: Buffer, retain: boolean) => {
      if (failure) return;
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) stop(new Error("DAP runtime probe output exceeds 1 MiB"));
      else if (retain) stdout += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => output(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => output(chunk, false));
    child.once("error", stop);
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      void stopped.then(() => {
        if (failure) reject(failure);
        else if (code !== 0)
          reject(new Error(`DAP runtime probe failed (${String(code)}): ${command}`));
        else resolve(stdout);
      });
    });
  });
}
