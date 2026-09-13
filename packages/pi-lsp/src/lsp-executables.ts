import { constants } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import spawn from "cross-spawn";

/** Terminate one owned process group, including wrappers and their server/helper descendants. */
export async function terminateLspProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((done) => {
      const killer = spawn(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore", timeout: 1000 },
      );
      killer.once("error", () => {
        child.kill("SIGKILL");
        done();
      });
      killer.once("close", (code) => {
        if (code !== 0) child.kill("SIGKILL");
        done();
      });
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
        child.kill("SIGKILL");
    }
  }
}

/** Inspect external wrappers with the same bounded process-tree ownership as LSP acquisition probes. */
export async function inspectLspExecutable(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    environment?: Readonly<Record<string, string | undefined>>;
    signal?: AbortSignal | undefined;
    timeoutMs: number;
  },
): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.environment,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failure: Error | undefined;
    let stopped = Promise.resolve();
    let stdout = "";
    let stderr = "";
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      stopped = terminateLspProcessTree(child);
    };
    const abort = () =>
      stop(new Error("LSP executable inspection cancelled", { cause: options.signal?.reason }));
    const timeout = setTimeout(
      () => stop(new Error(`LSP executable inspection timed out: ${command}`)),
      options.timeoutMs,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout?.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
      if (stdout.length > 1_000_000)
        stop(new Error("LSP executable inspection output exceeds 1 MB"));
    });
    child.stderr?.setEncoding("utf8").on("data", (text: string) => {
      stderr = (stderr + text).slice(-16_000);
    });
    child.once("error", stop);
    child.once("close", (code) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      void stopped.then(() => {
        if (failure) reject(failure);
        else if (code !== 0)
          reject(new Error(`LSP executable inspection failed: ${command}: ${stderr.trim()}`));
        else resolveOutput(stdout.trim());
      }, reject);
    });
  });
}

export function lspAncestorPaths(root: string): string[] {
  const result: string[] = [];
  for (let path = resolve(root); ; path = dirname(path)) {
    result.push(path);
    if (dirname(path) === path) return result;
  }
}

async function usable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return (await stat(path)).isFile();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
    )
      return false;
    throw error;
  }
}

export async function findLspExecutable(
  name: string,
  directories: readonly string[],
  accepts?: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  const names =
    process.platform === "win32"
      ? [`${name}.exe`, `${name}.com`, `${name}.cmd`, `${name}.bat`, name]
      : [name];
  for (const directory of directories) {
    for (const file of names) {
      const path = resolve(directory, file);
      if ((await usable(path)) && (accepts === undefined || (await accepts(path)))) return path;
    }
  }
  return undefined;
}

export function lspExecutableDirectories(
  root: string,
  environment: Readonly<Record<string, string>>,
): string[] {
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  return [
    ...lspAncestorPaths(root).map((path) => join(path, "node_modules", ".bin")),
    join(root, ".venv", "bin"),
    join(root, ".venv", "Scripts"),
    join(root, ".cargo", "bin"),
    join(root, ".go", "bin"),
    join(root, "bin"),
    join(root, ".bin"),
    ...(environment[pathKey] ?? "").split(delimiter).filter(Boolean),
  ];
}
