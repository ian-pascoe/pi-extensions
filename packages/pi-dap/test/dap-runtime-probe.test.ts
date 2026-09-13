import * as childProcess from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ToolInstaller } from "@ian-pascoe/pi-tool-installer";
import { expect, test, vi } from "vitest";
import { DapSession } from "../src/dap-session.js";
import { createDapSessionFiles } from "../src/dap-session-files.js";

// oxlint-disable-next-line anti-slop/no-module-mocking -- SAFETY: Windows substitutes only the external runtime executable with a real process fixture.
vi.mock("node:child_process", { spy: true });

function assembly(): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(0x14c, 68);
  bytes.writeUInt16LE(1, 70);
  bytes.writeUInt16LE(224, 84);
  bytes.writeUInt16LE(0x10b, 88);
  bytes.writeUInt32LE(0x2000, 88 + 96 + 14 * 8);
  bytes.writeUInt32LE(0x2000, 312 + 12);
  bytes.writeUInt32LE(64, 312 + 16);
  bytes.writeUInt32LE(400, 312 + 20);
  bytes.writeUInt32LE(1, 416);
  return bytes;
}

async function isRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    // A killed orphan can remain a zombie until the host's init reaps it.
    if (process.platform === "linux")
      return !/\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"));
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ESRCH", "ENOENT"].includes(String(error.code))
    )
      return false;
    throw error;
  }
}

function killFixture(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

test.each([
  ["dotnet", "abort"],
  ["dotnet", "deadline"],
  ["dotnet", "overflow"],
  ["dotnet", "parent-exit"],
  ["python", "abort"],
  ["python", "deadline"],
  ["python", "overflow"],
  ["python", "parent-exit"],
] as const)(
  "public %s launch cleans stubborn preflight tree on %s before settling",
  async (profile, mode) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dap-probe-"));
    const windows = process.platform === "win32";
    const probe = join(
      directory,
      profile === "dotnet"
        ? `.dotnet/dotnet${windows ? ".exe" : ""}`
        : windows
          ? ".venv/Scripts/python.exe"
          : ".venv/bin/python",
    );
    const fixture = join(import.meta.dirname, "fixtures/stubborn-runtime-probe.mjs");
    const pidFile = join(directory, "pids.json");
    await mkdir(dirname(probe), { recursive: true });
    if (windows) {
      await writeFile(probe, "external runtime fixture", { mode: 0o700 });
      const native = await vi.importActual<typeof childProcess>("node:child_process");
      vi.mocked(childProcess.spawn).mockImplementation((command, args, options) =>
        // Substitute only the external runtime behind the real native owner.
        native.spawn(
          command,
          args?.[0] === probe ? [process.execPath, fixture] : (args ?? []),
          options ?? {},
        ),
      );
    } else {
      await writeFile(
        probe,
        `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`,
        { mode: 0o700 },
      );
    }
    const program = join(directory, profile === "dotnet" ? "app.dll" : "app.py");
    await writeFile(program, profile === "dotnet" ? assembly() : "pass\n");
    await writeFile(
      join(directory, "app.runtimeconfig.json"),
      JSON.stringify({
        runtimeOptions: { framework: { name: "Microsoft.NETCore.App", version: "8.0.0" } },
      }),
    );
    // Ensure unsupported managed-adapter platforms still reach the external runtime probe.
    await mkdir(join(directory, "bin"));
    await writeFile(
      join(directory, "bin", `netcoredbg${windows ? ".exe" : ""}`),
      "unused adapter fixture",
      { mode: 0o700 },
    );
    const files = await createDapSessionFiles(join(directory, "sessions"));
    const installer = new ToolInstaller(join(directory, "tools"));
    const session = new DapSession({
      cwd: directory,
      installer,
      sessionFiles: files,
      settings: {
        autoInstall: false,
        adapters: new Map(),
        profiles: new Map(),
        warnings: [],
        timeouts: { startupMs: 1000, requestMs: 1000, executionMs: 1000, shutdownMs: 1000 },
      },
    });
    const controller = new AbortController();
    let pids: number[] = [];
    let pending: Promise<unknown> | undefined;
    try {
      vi.stubEnv("PATH", "");
      vi.stubEnv("PI_DAP_PROBE_PIDS", pidFile);
      vi.stubEnv("PI_DAP_PROBE_MODE", mode);
      let settled = false;
      pending = session
        .launch({ profile, program }, controller.signal)
        .catch((error: Error) => error)
        .finally(() => {
          settled = true;
        });
      await vi.waitFor(
        async () => {
          pids = JSON.parse(await readFile(pidFile, "utf8"));
        },
        { timeout: 2000 },
      );
      expect(pids).toHaveLength(2);
      if (mode === "parent-exit") {
        await vi.waitFor(() => expect(isRunning(pids[0]!)).resolves.toBe(false));
        controller.abort();
      } else if (mode === "abort") controller.abort();
      await vi.waitFor(() => expect(settled).toBe(true), {
        timeout: mode === "deadline" ? 7000 : 2000,
        interval: 25,
      });
      expect(await pending).toBeInstanceOf(Error);
      expect(await Promise.all(pids.map(isRunning))).toEqual([false, false]);
      expect(await installer.list()).toEqual([]);
    } finally {
      controller.abort();
      pids.forEach(killFixture);
      await pending;
      await session.shutdown();
      await files.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

const windowsHelper = join(
  import.meta.dirname,
  `../src/native/win32-${process.arch}/dap-runtime-probe.exe`,
);

test.skipIf(process.platform !== "win32").each(["absolute", "relative", "PATH", "quoted-PATH"])(
  "bundled Windows owner preserves %s command, Unicode argv, cwd, environment, stdio and exit code",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dap-owner ü-"));
    const binaryName = mode === "quoted-PATH" ? "bin ü;one" : "bin ü";
    const binaryDirectory = join(directory, binaryName);
    const executable = join(binaryDirectory, "runtime ü.exe");
    const args = [
      "",
      "a b",
      "tab\there",
      'a"b',
      "\\",
      "ends with \\",
      '\\"quoted\\"',
      "日本語😀",
      "&|<>%!",
    ];
    try {
      await mkdir(binaryDirectory);
      await copyFile(process.execPath, executable);
      if (mode === "quoted-PATH") {
        // A PATH-list API would split the quoted directory and run this valid
        // but wrong executable. Assert the actual image path, not just success.
        const distractor = join(directory, "bin ü");
        await mkdir(distractor);
        await copyFile(process.execPath, join(distractor, "runtime ü.exe"));
      }
      const child = childProcess.spawn(
        windowsHelper,
        [
          mode === "PATH" || mode === "quoted-PATH"
            ? "runtime ü"
            : mode === "relative"
              ? "bin ü\\runtime ü.exe"
              : executable,
          "-e",
          'process.stdout.write(JSON.stringify({args:process.argv.slice(1),executable:process.execPath,cwd:process.cwd(),env:process.env.PROBE_UNICODE,stdin:require("node:fs").readFileSync(0,"utf8")}));process.stderr.write("stderr preserved");process.exitCode=37;',
          "--",
          ...args,
        ],
        {
          cwd: directory,
          env: { ...process.env, PATH: `"${binaryName}"`, PROBE_UNICODE: "value ü 日本語😀" },
          windowsHide: true,
          timeout: 3000,
          killSignal: "SIGKILL",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code).toBe(37);
      expect(JSON.parse(stdout)).toEqual({
        args,
        executable,
        cwd: directory,
        env: "value ü 日本語😀",
        stdin: "",
      });
      expect(stderr).toBe("stderr preserved");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test
  .skipIf(process.platform !== "win32")
  .each(["parent-exit", "parent-exit-closed-stdio", "helper-death"])(
  "bundled Windows owner cleans the tree on %s",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dap-owner-"));
    const pidFile = join(directory, "pids.json");
    const child = childProcess.spawn(
      windowsHelper,
      [process.execPath, join(import.meta.dirname, "fixtures/stubborn-runtime-probe.mjs")],
      {
        env: { ...process.env, PI_DAP_PROBE_PIDS: pidFile, PI_DAP_PROBE_MODE: mode },
        windowsHide: true,
        timeout: 3000,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    // Observe a missing/broken payload immediately without an unhandled rejection.
    let spawnError: Error | undefined;
    void closed.catch((error: Error) => {
      spawnError = error;
    });
    child.stdout.resume();
    child.stderr.resume();
    let pids: number[] = [];
    try {
      await vi.waitFor(
        async () => {
          if (spawnError) throw spawnError;
          pids = JSON.parse(await readFile(pidFile, "utf8"));
        },
        { timeout: 2000 },
      );
      expect(pids).toHaveLength(2);
      if (mode === "helper-death") {
        expect(await Promise.all(pids.map(isRunning))).toEqual([true, true]);
        child.kill("SIGKILL");
      }
      expect(await closed).toBe(mode === "helper-death" ? null : 0);
      await vi.waitFor(
        async () => {
          expect(await Promise.all(pids.map(isRunning))).toEqual([false, false]);
        },
        { timeout: 1000 },
      );
    } finally {
      child.kill("SIGKILL");
      pids.forEach(killFixture);
      await closed.catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "win32").each(["missing", "invalid"])(
  "bundled Windows owner fails closed for a %s runtime",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dap-owner-"));
    const executable = join(directory, "runtime.exe");
    try {
      if (mode === "invalid") await writeFile(executable, "not an executable");
      const child = childProcess.spawn(windowsHelper, [executable], {
        windowsHide: true,
        timeout: 3000,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stdout.resume();
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code).not.toBe(0);
      expect(stderr).toContain(
        `${mode === "missing" ? "executable lookup" : "CreateProcessW"} failed`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
