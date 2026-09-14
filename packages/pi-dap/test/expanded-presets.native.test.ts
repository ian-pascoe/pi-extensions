import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ToolInstaller } from "@ian-pascoe/pi-tool-installer";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, test, vi } from "vitest";
import { resolveDapPreset } from "../src/dap-managed-tools.js";
import type { ResolvedDapSettings } from "../src/pi-dap-settings.js";
import { DapSession } from "../src/dap-session.js";
import { createDapSessionFiles } from "../src/dap-session-files.js";

const execute = promisify(execFile);
const native = process.env.PI_DAP_EXPANSION_NATIVE === "1" ? test : test.skip;

async function printNativeFailure(directory: string, installer: ToolInstaller): Promise<void> {
  for (const name of await readdir(directory)) {
    if (name.startsWith("adapter-stderr-"))
      console.error(name, (await readFile(join(directory, name), "utf8")).slice(-16_000));
  }
  for (const installation of await installer.list()) {
    if (installation.id.startsWith("dap-"))
      console.info(
        "DAP native versions",
        installation.id,
        Object.fromEntries(
          Object.entries(installation.components).map(([name, value]) => [name, value.version]),
        ),
      );
  }
}

async function expectDebuggeeExit(output: string): Promise<void> {
  const pid = Number(/PI_DAP_PID=(\d+)/.exec(output)?.[1]);
  expect(pid, output).toBeGreaterThan(0);
  await vi.waitFor(
    async () => {
      await expect(Promise.resolve().then(() => process.kill(pid, 0))).rejects.toMatchObject({
        code: "ESRCH",
      });
    },
    { timeout: 10_000, interval: 50 },
  );
}

native(
  "Deno selects its project runtime, debugs TypeScript, and leaves dependencies untouched",
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-dap-deno-native-")));
    const project = join(directory, "project");
    await mkdir(project);
    const program = join(project, "main.ts");
    await writeFile(
      program,
      'import { base } from "./dep.ts";\nconsole.log(`PI_DAP_PID=${Deno.pid}`);\nconst answer: number = base + 1;\nconsole.log(answer);\n',
    );
    await writeFile(join(project, "deno.json"), '{"nodeModulesDir":"auto","vendor":true}');
    await writeFile(join(project, "package.json"), "{}");
    await writeFile(join(project, "dep.ts"), "export const base: number = 41;\n");
    const lock = '{"version":"5","specifiers":{},"jsr":{},"npm":{},"remote":{}}\n';
    await writeFile(join(project, "deno.lock"), lock);
    const store = process.env.PI_DAP_NATIVE_STORE ?? join(directory, "tools");
    await mkdir(store, { recursive: true });
    if (process.env.PI_DAP_NATIVE_MISE)
      await copyFile(
        process.env.PI_DAP_NATIVE_MISE,
        join(store, process.platform === "win32" ? "mise.exe" : "mise"),
      );
    const files = await createDapSessionFiles(join(directory, "sessions"));
    const installer = new ToolInstaller(store);
    const settings: ResolvedDapSettings = {
      adapters: new Map(),
      profiles: new Map(),
      warnings: [],
      timeouts: { startupMs: 30_000, requestMs: 15_000, executionMs: 15_000, shutdownMs: 5_000 },
    };
    const session = new DapSession({
      cwd: project,
      installer,
      sessionFiles: files,
      settings,
    });
    let requests = 0;
    const remote = createServer((_request, response) => {
      requests++;
      response.setHeader("Content-Type", "application/typescript");
      response.end("export const base: number = 41;\n");
    });
    try {
      vi.stubEnv("PATH", "");
      await session.setBreakpoints({ filePath: program, breakpoints: [{ line: 4 }] });
      const launched = await session.launch({ program });
      expect(launched.snapshot, JSON.stringify(launched)).toMatchObject({
        state: "stopped",
        profileId: "deno",
      });
      let firstOutput = launched.output;
      if (launched.snapshot.state === "stopped" && launched.snapshot.stopReason !== "breakpoint") {
        const continued = await session.continue();
        firstOutput += continued.output;
        expect(continued.snapshot, JSON.stringify({ launched, continued })).toMatchObject({
          state: "stopped",
        });
      }
      const evaluation = await session.evaluate({ expression: "answer" });
      firstOutput += evaluation.output;
      expect(evaluation.evaluation?.result).toBe("42");
      const stack = await session.stack();
      firstOutput += stack.output;
      const stoppedSource = stack.stackFrames?.[0]?.source?.path;
      if (!stoppedSource) throw new Error("The stopped frame has no source path");
      expect(await realpath(stoppedSource)).toBe(await realpath(program));
      const variables = await session.variables({ frameId: stack.stackFrames![0]!.id });
      firstOutput += variables.output;
      expect(variables.variableGroups?.flatMap((group) => group.variables)).toContainEqual(
        expect.objectContaining({ name: "answer", value: "42" }),
      );
      const finished = await session.continue();
      expect(finished.snapshot.state).toBe("terminated");
      await expectDebuggeeExit(firstOutput + finished.output);
      for (const installation of await installer.list()) {
        if (installation.id.startsWith("dap-"))
          console.info(
            "DAP native versions",
            installation.id,
            Object.fromEntries(
              Object.entries(installation.components).map(([name, value]) => [name, value.version]),
            ),
          );
      }
      expect((await readdir(project)).sort()).toEqual([
        "deno.json",
        "deno.lock",
        "dep.ts",
        "main.ts",
        "package.json",
      ]);
      expect(await readFile(join(project, "deno.lock"), "utf8")).toBe(lock);
      const paused = await session.launch({ program });
      let pausedOutput = paused.output;
      if (paused.snapshot.state === "stopped" && paused.snapshot.stopReason !== "breakpoint")
        pausedOutput += (await session.continue()).output;
      const stopped = await session.stop();
      expect(stopped.snapshot.state).toBe("terminated");
      await expectDebuggeeExit(pausedOutput + stopped.output);
      await session.setBreakpoints({ filePath: program, breakpoints: [] });
      await writeFile(
        program,
        "console.log(`PI_DAP_PID=${Deno.pid}`);\nsetInterval(() => {}, 1000);\nawait new Promise(() => {});\n",
      );
      expect((await session.launch({ program })).snapshot.state).toBe("stopped");
      const controller = new AbortController();
      const pending = session.continue(controller.signal);
      let cancelledOutput = "";
      await vi.waitFor(
        () => {
          cancelledOutput += session.status().output;
          expect(cancelledOutput).toMatch(/PI_DAP_PID=\d+/);
        },
        { timeout: 10_000, interval: 50 },
      );
      controller.abort(new Error("native execution wait cancelled"));
      const cancellation = await pending;
      expect(cancellation.snapshot.state).toBe("running");
      cancelledOutput += cancellation.output;
      cancelledOutput += (await session.stop()).output;
      await expectDebuggeeExit(cancelledOutput);
      await writeFile(
        program,
        'console.log(`PI_DAP_PID=${Deno.pid}`);\nawait Deno.readTextFile("./package.json");\n',
      );
      const deniedLaunch = await session.launch({ program });
      expect(deniedLaunch.snapshot.state).toBe("stopped");
      const deniedPid = (await session.evaluate({ expression: "Deno.pid" })).evaluation?.result;
      const denied = await session.continue();
      expect(denied.snapshot.state, JSON.stringify(denied)).toBe("terminated");
      expect(denied.output).toMatch(/Requires read access|NotCapable/);
      await expectDebuggeeExit(`PI_DAP_PID=${deniedPid}`);
      await writeFile(program, 'import "https://example.invalid/unprepared.ts";\n');
      const missingLaunch = await session.launch({ program }).catch(() => session.status());
      const missing =
        missingLaunch.snapshot.state === "stopped" ? await session.continue() : missingLaunch;
      expect(missing.snapshot.state, JSON.stringify(missing)).toBe("terminated");
      expect(missing.output).toMatch(/cache|cached-only/i);
      expect((await readdir(project)).sort()).toEqual([
        "deno.json",
        "deno.lock",
        "dep.ts",
        "main.ts",
        "package.json",
      ]);
      expect(await readFile(join(project, "deno.lock"), "utf8")).toBe(lock);

      await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
      const address = remote.address();
      if (!Value.Check(Type.Object({ port: Type.Number() }), address))
        throw new Error("Missing native dependency fixture address");
      const dependency = `http://127.0.0.1:${address.port}/prepared.ts`;
      // Fixture preparation uses the resolved runtime/environment, not private cache layout.
      const preset = await resolveDapPreset({ program }, project, settings, installer);
      const runtime = preset?.profile.arguments;
      if (
        !Value.Check(
          Type.Object({
            runtimeExecutable: Type.String(),
            env: Type.Record(Type.String(), Type.String()),
          }),
          runtime,
        )
      )
        throw new Error("Missing native Deno fixture runtime");
      const environment = { ...process.env, ...runtime.env };
      await execute(runtime.runtimeExecutable, ["cache", "--no-config", "--no-lock", dependency], {
        cwd: project,
        env: environment,
        timeout: 30_000,
      });
      expect(requests).toBeGreaterThan(0);
      const preparedRequests = requests;
      await writeFile(
        program,
        `import { base } from ${JSON.stringify(dependency)};\nconsole.log(\`PI_DAP_PID=\${Deno.pid}\`);\nconsole.log(\`REMOTE_RESULT=\${base + 1}\`);\n`,
      );
      const frozenLaunch = await session.launch({ program }).catch(() => session.status());
      const frozen =
        frozenLaunch.snapshot.state === "stopped" ? await session.continue() : frozenLaunch;
      expect(frozen.snapshot.state, JSON.stringify(frozen)).toBe("terminated");
      expect(frozen.output).toMatch(/lockfile.*out of date|frozen|lock.*changed/i);
      expect(frozen.output).not.toContain("REMOTE_RESULT=42");
      expect(await readFile(join(project, "deno.lock"), "utf8")).toBe(lock);
      expect(await readFile(join(project, "package.json"), "utf8")).toBe("{}");
      expect(await readFile(join(project, "deno.json"), "utf8")).toBe(
        '{"nodeModulesDir":"auto","vendor":true}',
      );
      expect(requests).toBe(preparedRequests);

      // Positive control: without frozen mode the same cached graph changes the lock.
      const control = await execute(
        runtime.runtimeExecutable,
        [
          "run",
          "--cached-only",
          "--node-modules-dir=manual",
          "--vendor=false",
          "--no-prompt",
          program,
        ],
        { cwd: project, env: environment, timeout: 30_000 },
      );
      expect(control.stdout).toContain("REMOTE_RESULT=42");
      await expectDebuggeeExit(control.stdout);
      const preparedLock = await readFile(join(project, "deno.lock"), "utf8");
      expect(preparedLock).not.toBe(lock);
      expect(preparedLock).toContain(dependency);
      expect(requests).toBe(preparedRequests);
      expect((await session.launch({ program })).snapshot.state).toBe("stopped");
      const preparedPid = (await session.evaluate({ expression: "Deno.pid" })).evaluation?.result;
      const prepared = await session.continue();
      expect(prepared.snapshot.state).toBe("terminated");
      expect(prepared.output).toContain("REMOTE_RESULT=42");
      await expectDebuggeeExit(`PI_DAP_PID=${preparedPid}`);
      expect(await readFile(join(project, "deno.lock"), "utf8")).toBe(preparedLock);
      expect(await readFile(join(project, "package.json"), "utf8")).toBe("{}");
      expect(await readFile(join(project, "deno.json"), "utf8")).toBe(
        '{"nodeModulesDir":"auto","vendor":true}',
      );
      expect(requests).toBe(preparedRequests);
      expect((await readdir(project)).sort()).toEqual([
        "deno.json",
        "deno.lock",
        "dep.ts",
        "main.ts",
        "package.json",
      ]);
    } catch (error) {
      console.error("DAP native failure", session.status().snapshot);
      await printNativeFailure(files.directoryPath, installer).catch((cause) =>
        console.error(cause),
      );
      throw error;
    } finally {
      await session.shutdown();
      if (remote.listening) {
        remote.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          remote.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await files.close();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  180_000,
);

native.each([
  {
    profile: "go",
    source: "main.go",
    compiler: "go",
    text: 'package main\nimport ("fmt"; "os")\nfunc main() {\n fmt.Printf("PI_DAP_PID=%d\\n", os.Getpid())\n answer := 42\n fmt.Println(answer)\n}\n',
    line: 6,
  },
  {
    profile: "codelldb",
    source: "main.cpp",
    compiler: "g++",
    text: '#include <iostream>\n#ifdef _WIN32\n#include <process.h>\n#define native_pid _getpid\n#else\n#include <unistd.h>\n#define native_pid getpid\n#endif\nint main() {\n std::cout << "PI_DAP_PID=" << native_pid() << std::endl;\n int answer = 42;\n std::cout << answer << std::endl;\n return 0;\n}\n',
    line: 13,
  },
  {
    profile: "codelldb",
    source: "main.rs",
    compiler: "rustc",
    text: 'fn main() {\n println!("PI_DAP_PID={}", std::process::id());\n let answer: i32 = 42;\n println!("{}", answer);\n}\n',
    line: 4,
  },
])(
  "$profile/$source verifies native launch or declared managed unavailability",
  async ({ profile, source, compiler, text, line }) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-dap-compiled-native-")));
    const program = join(directory, process.platform === "win32" ? "program.exe" : "program");
    const sourcePath = join(directory, source);
    await writeFile(sourcePath, text);
    const store = process.env.PI_DAP_NATIVE_STORE ?? join(directory, "tools");
    await mkdir(store, { recursive: true });
    if (process.env.PI_DAP_NATIVE_MISE)
      await copyFile(
        process.env.PI_DAP_NATIVE_MISE,
        join(store, process.platform === "win32" ? "mise.exe" : "mise"),
      );
    const files = await createDapSessionFiles(join(directory, "sessions"));
    const installer = new ToolInstaller(store);
    const session = new DapSession({
      cwd: directory,
      installer,
      sessionFiles: files,
      settings: {
        adapters: new Map(),
        profiles: new Map(),
        warnings: [],
        timeouts: { startupMs: 30_000, requestMs: 15_000, executionMs: 15_000, shutdownMs: 5_000 },
      },
    });
    try {
      if (process.platform === "win32" && process.arch === "arm64") {
        vi.stubEnv("PATH", "");
        const before = await installer.list();
        await expect(session.launch({ profile, program })).rejects.toThrow(
          /unavailable on Windows ARM64/,
        );
        expect(await installer.list()).toEqual(before);
        return;
      }
      const nativeArch = process.arch === "arm64" ? "(?:aarch64|arm64)" : "x86_64";
      if (compiler === "go") {
        const version = await execute(compiler, ["version"], {
          cwd: directory,
          env: { ...process.env, GOTOOLCHAIN: "local" },
        });
        console.info(version.stdout.trim());
        expect(version.stdout).toContain(
          `${process.platform === "win32" ? "windows" : process.platform}/${process.arch === "arm64" ? "arm64" : "amd64"}`,
        );
        await execute(compiler, ["build", "-gcflags=all=-N -l", "-o", program, sourcePath], {
          cwd: directory,
          timeout: 90_000,
          env: {
            ...process.env,
            GOTOOLCHAIN: "local",
            GOCACHE: join(directory, "go-cache"),
            GOPATH: join(directory, "go-path"),
            GOOS: process.platform === "win32" ? "windows" : process.platform,
            GOARCH: process.arch === "arm64" ? "arm64" : "amd64",
            CGO_ENABLED: "0",
          },
        });
      } else {
        const version = await execute(compiler, compiler === "rustc" ? ["-vV"] : ["-dumpmachine"]);
        console.info(`${compiler}: ${version.stdout.trim()}`);
        const target =
          compiler === "rustc"
            ? (/^host: (.+)$/m.exec(version.stdout)?.[1] ?? "")
            : version.stdout.trim();
        expect(target).toMatch(new RegExp(`^${nativeArch}-`));
        expect(target).toMatch(
          process.platform === "win32"
            ? /windows|mingw/
            : process.platform === "darwin"
              ? /apple-darwin/
              : /linux/,
        );
        const args =
          compiler === "rustc"
            ? ["-g", "-C", "opt-level=0", "-o", program, sourcePath]
            : ["-g", "-O0", "-o", program, sourcePath];
        if (process.platform === "win32") {
          if (compiler === "g++") args.unshift("-static", "-static-libgcc", "-static-libstdc++");
          else args.unshift("-C", "target-feature=+crt-static");
        }
        await execute(compiler, args, { cwd: directory, timeout: 90_000 });
      }
      vi.stubEnv("PATH", "");
      await session.setBreakpoints({ filePath: sourcePath, breakpoints: [{ line }] });
      const launched = await session.launch({ profile, program });
      expect(launched.snapshot.state, JSON.stringify(launched)).toBe("stopped");
      console.info("DAP native initial stop", launched.snapshot);
      for (const installation of await installer.list()) {
        if (installation.id.startsWith("dap-"))
          console.info(
            "DAP native versions",
            installation.id,
            Object.fromEntries(
              Object.entries(installation.components).map(([name, value]) => [name, value.version]),
            ),
          );
      }
      // Delve's entry stop precedes goroutine creation; only CodeLLDB needs the initial-frame check.
      let stack = profile === "codelldb" ? await session.stack() : undefined;
      let stopOutput = stack?.output ?? "";
      const initialFrame = stack?.stackFrames?.[0];
      console.info("DAP native initial frame", initialFrame);
      if (
        stack === undefined ||
        initialFrame?.line !== line ||
        !initialFrame.source?.path ||
        (await realpath(initialFrame.source.path)) !== (await realpath(sourcePath))
      ) {
        const continued = await session.continue();
        stopOutput += continued.output;
        console.info("DAP native continued stop", continued.snapshot);
        expect(continued.snapshot.state, JSON.stringify(continued)).toBe("stopped");
        stack = await session.stack();
        stopOutput += stack.output;
      }
      const stoppedFrame = stack.stackFrames?.[0];
      console.info("DAP native breakpoint frame", stoppedFrame);
      if (!stoppedFrame?.source?.path) throw new Error("The stopped frame has no source path");
      expect(await realpath(stoppedFrame.source.path)).toBe(await realpath(sourcePath));
      expect(stoppedFrame.line).toBe(line);
      const evaluation = await session.evaluate({ expression: "answer" });
      expect(evaluation.evaluation?.result).toBe("42");
      const variables = await session.variables({ frameId: stack.stackFrames![0]!.id });
      expect(variables.variableGroups?.flatMap((group) => group.variables)).toContainEqual(
        expect.objectContaining({ name: "answer", value: "42" }),
      );
      let output = launched.output + stopOutput + evaluation.output + variables.output;
      if (profile === "codelldb") {
        await expect(session.evaluate({ expression: "missing_native_symbol" })).rejects.toThrow();
        const status = session.status();
        output += status.output;
        expect(status.snapshot.state).toBe("stopped");
      }
      output += (await session.stop()).output;
      await expectDebuggeeExit(output);
    } catch (error) {
      console.error("DAP native failure", session.status().snapshot);
      await printNativeFailure(files.directoryPath, installer).catch((cause) =>
        console.error(cause),
      );
      throw error;
    } finally {
      await session.shutdown();
      await files.close();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  180_000,
);
