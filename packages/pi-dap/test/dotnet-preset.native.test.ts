import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ToolInstaller } from "@ian-pascoe/pi-tool-installer";
import { expect, test, vi } from "vitest";
import { DapSession } from "../src/dap-session.js";
import { createDapSessionFiles } from "../src/dap-session-files.js";

const execute = promisify(execFile);
const native = process.env.PI_DAP_EXPANSION_NATIVE === "1" ? test : test.skip;
const unavailable =
  (process.platform === "win32" && process.arch === "arm64") ||
  (process.platform === "darwin" && process.arch === "x64");

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

(unavailable ? test.skip : native)(
  "NetCoreDbg uses a compatible private runtime, preserves args, and never builds during launch",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dap-dotnet-native-"));
    const project = join(directory, "project");
    await mkdir(project);
    const source = join(project, "Program.cs");
    await writeFile(
      source,
      'using System;\nclass Program {\n static void Main(string[] args) {\n  Console.WriteLine($"PI_DAP_PID={Environment.ProcessId}");\n  int answer = 41;\n  answer += 1;\n  Console.WriteLine($"answer={answer};arg={args[0]}");\n }\n}\n',
    );
    await writeFile(
      join(project, "probe.csproj"),
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><UseAppHost>false</UseAppHost></PropertyGroup></Project>',
    );
    const store = process.env.PI_DAP_NATIVE_STORE ?? join(directory, "tools");
    await mkdir(store, { recursive: true });
    if (process.env.PI_DAP_NATIVE_MISE)
      await copyFile(
        process.env.PI_DAP_NATIVE_MISE,
        join(store, process.platform === "win32" ? "mise.exe" : "mise"),
      );
    const installer = new ToolInstaller(store);
    // Fixture preparation only: product launch never requests this SDK or builds a project.
    const sdk = await installer.ensure(
      { id: "dap-fixture-dotnet-sdk", requirements: { sdk: "core:dotnet@8.0.414" } },
      { allowDownload: true },
    );
    const sdkExecutable = join(
      sdk.components.sdk!.directory,
      process.platform === "win32" ? "dotnet.exe" : "dotnet",
    );
    const buildEnvironment = {
      ...process.env,
      DOTNET_CLI_HOME: join(directory, "sdk-home"),
      NUGET_PACKAGES: join(directory, "nuget"),
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_GENERATE_ASPNET_CERTIFICATE: "0",
    };
    await execute(
      sdkExecutable,
      ["build", "--nologo", "--ignore-failed-sources", "--disable-build-servers"],
      {
        timeout: 90_000,
        cwd: project,
        env: buildEnvironment,
      },
    );
    const rid = `${process.platform === "win32" ? "win" : process.platform === "darwin" ? "osx" : "linux"}-${process.arch}`;
    const bundle = join(directory, "bundle");
    await execute(
      sdkExecutable,
      [
        "publish",
        "--nologo",
        "--disable-build-servers",
        "-r",
        rid,
        "--self-contained",
        "true",
        "-p:UseAppHost=true",
        "-o",
        bundle,
      ],
      { cwd: project, env: buildEnvironment, timeout: 90_000 },
    );
    const program = join(project, "bin/Debug/net8.0/probe.dll");
    const before = await readFile(
      join(project, "bin/Debug/net8.0/probe.runtimeconfig.json"),
      "utf8",
    );
    const files = await createDapSessionFiles(join(directory, "sessions"));
    const session = new DapSession({
      cwd: project,
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
      vi.stubEnv("PATH", "");
      await session.setBreakpoints({ filePath: source, breakpoints: [{ line: 7 }] });
      const launched = await session.launch({ profile: "dotnet", program, args: ["preserved"] });
      console.info(
        `${process.platform}/${process.arch}: ${JSON.stringify(await installer.list())}`,
      );
      expect(launched.snapshot, JSON.stringify(launched)).toMatchObject({ state: "stopped" });
      let firstOutput = launched.output;
      if (launched.snapshot.state === "stopped" && launched.snapshot.stopReason !== "breakpoint")
        firstOutput += (await session.continue()).output;
      const evaluation = await session.evaluate({ expression: "answer" });
      firstOutput += evaluation.output;
      expect(evaluation.evaluation?.result).toBe("42");
      const stack = await session.stack();
      firstOutput += stack.output;
      expect(stack.stackFrames?.[0]?.source?.path).toBe(source);
      const variables = await session.variables({ frameId: stack.stackFrames![0]!.id });
      firstOutput += variables.output;
      expect(variables.variableGroups?.flatMap((group) => group.variables)).toContainEqual(
        expect.objectContaining({ name: "answer", value: "42" }),
      );
      const ended = await session.continue();
      expect(ended.snapshot.state).toBe("terminated");
      expect(ended.output).toContain("answer=42;arg=preserved");
      await expectDebuggeeExit(firstOutput + ended.output);
      expect(
        await readFile(join(project, "bin/Debug/net8.0/probe.runtimeconfig.json"), "utf8"),
      ).toBe(before);
      expect((await readdir(project)).sort()).toEqual(["Program.cs", "bin", "obj", "probe.csproj"]);
      const paused = await session.launch({ profile: "dotnet", program, args: ["stopped"] });
      let pausedOutput = paused.output;
      if (paused.snapshot.state === "stopped" && paused.snapshot.stopReason !== "breakpoint")
        pausedOutput += (await session.continue()).output;
      pausedOutput += (await session.stop()).output;
      await expectDebuggeeExit(pausedOutput);
      const selections = await installer.list();
      const bundled = await session.launch({
        profile: "dotnet",
        program: join(bundle, process.platform === "win32" ? "probe.exe" : "probe"),
        args: ["self-contained"],
      });
      expect(bundled.snapshot, JSON.stringify(bundled)).toMatchObject({ state: "stopped" });
      let bundledOutput = bundled.output;
      if (bundled.snapshot.state === "stopped" && bundled.snapshot.stopReason !== "breakpoint")
        bundledOutput += (await session.continue()).output;
      bundledOutput += (await session.stop()).output;
      await expectDebuggeeExit(bundledOutput);
      expect(await installer.list()).toEqual(selections);
      const runtimeConfig = join(project, "bin/Debug/net8.0/probe.runtimeconfig.json");
      await writeFile(
        runtimeConfig,
        '{"runtimeOptions":{"frameworks":[{"name":"Microsoft.NETCore.App","version":"8.0.0"},{"name":"Custom.App","version":"8.0.0"}]}}',
      );
      await expect(session.launch({ profile: "dotnet", program })).rejects.toThrow(
        /ambiguous or unsupported/,
      );
      expect(await installer.list()).toEqual(selections);
      await writeFile(runtimeConfig, before);
    } finally {
      await session.shutdown();
      await files.close();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  180_000,
);

(unavailable ? native : test.skip)(
  "declared unsupported NetCoreDbg cells report unavailable without acquiring a runtime or SDK",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dap-dotnet-unavailable-"));
    const store = join(directory, "tools");
    const installer = new ToolInstaller(store);
    const files = await createDapSessionFiles(join(directory, "sessions"));
    const session = new DapSession({
      cwd: directory,
      installer,
      sessionFiles: files,
      settings: {
        adapters: new Map(),
        profiles: new Map(),
        warnings: [],
        timeouts: { startupMs: 1000, requestMs: 1000, executionMs: 1000, shutdownMs: 1000 },
      },
    });
    try {
      vi.stubEnv("PATH", "");
      await expect(session.launch({ profile: "dotnet", program: "app.dll" })).rejects.toThrow(
        /Managed NetCoreDbg is unavailable/,
      );
      expect(await installer.list()).toEqual([]);
      expect(await readdir(directory)).not.toContain("tools");
    } finally {
      await session.shutdown();
      await files.close();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
