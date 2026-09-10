import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { ToolInstaller } from "@ian-pascoe/pi-tool-installer";
import crossSpawn from "cross-spawn";
import { fileURLToPath } from "node:url";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, resolve } from "node:path";
import {
  createWriteTool,
  DefaultResourceLoader,
  ExtensionRunner,
  initTheme,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type KeybindingsManager,
  type SessionStartEvent,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  ProcessTerminal,
  TuiMainScreen,
  type Component,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Replace only the external installer executable; package middleware and installer stay real.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});
import { createPiFormatterExtension } from "../src/pi-formatter-extension.js";
import type { FormatterSettingsDocumentInput } from "../src/pi-formatter-settings.js";

// Native formatter processes are external boundaries; managed JS launchers run unchanged.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock("cross-spawn", async (importOriginal) => {
  const original = await importOriginal<{ default: typeof crossSpawn }>();
  return { ...original, default: vi.fn(original.default) };
});

const temporaryDirectories: string[] = [];

interface FormatterHarness {
  readonly cwd: string;
  readonly agentDirectory: string;
  readonly statuses: (string | undefined)[];
  readonly notifications: string[];
  readonly runner: ExtensionRunner;
}

interface FormatterTestToolResult {
  readonly details: ToolResultEvent["details"];
  readonly input: ToolResultEvent["input"];
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFormatterHarness(
  globalSettings: FormatterSettingsDocumentInput,
  signal?: AbortSignal,
  cwd?: string,
): Promise<FormatterHarness> {
  cwd ??= await makeTemporaryDirectory("pi-formatter-extension-cwd-");
  const agentDirectory = await makeTemporaryDirectory("pi-formatter-extension-agent-");
  const sessionDirectory = await makeTemporaryDirectory("pi-formatter-extension-session-");
  await writeFile(resolve(agentDirectory, "settings.json"), JSON.stringify(globalSettings));
  await mkdir(resolve(cwd, ".pi"));
  await writeFile(resolve(cwd, ".pi/settings.json"), "{}");

  const sessionManager = SessionManager.create(cwd, sessionDirectory);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: agentDirectory,
    extensionFactories: [
      {
        name: "pi-formatter-lifecycle-test",
        factory: createPiFormatterExtension(() => agentDirectory),
      },
    ],
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  const extensions = resourceLoader.getExtensions();
  expect(extensions.errors).toEqual([]);

  const modelRuntime = await ModelRuntime.create({
    authPath: resolve(agentDirectory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const runner = new ExtensionRunner(
    extensions.extensions,
    extensions.runtime,
    cwd,
    sessionManager,
    new ModelRegistry(modelRuntime),
  );
  runner.bindCore(
    {
      sendMessage: () => undefined,
      sendUserMessage: () => undefined,
      appendEntry: () => undefined,
      setSessionName: () => undefined,
      getSessionName: () => undefined,
      setLabel: () => undefined,
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => undefined,
      refreshTools: () => undefined,
      getCommands: () => [],
      setModel: async () => true,
      getThinkingLevel: () => "medium",
      setThinkingLevel: () => undefined,
    },
    {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => signal,
      abort: () => undefined,
      hasPendingMessages: () => false,
      shutdown: () => undefined,
      getContextUsage: () => undefined,
      compact: () => undefined,
      getSystemPrompt: () => "Pi Formatter lifecycle test",
    },
  );
  const notifications: string[] = [];
  const statuses: (string | undefined)[] = [];
  runner.setUIContext(
    {
      ...runner.getUIContext(),
      notify: (message) => notifications.push(message),
      setStatus: (_key, message) => statuses.push(message),
    },
    "rpc",
  );
  await runner.emit({ type: "session_start", reason: "startup" } satisfies SessionStartEvent);
  return { cwd, agentDirectory, notifications, statuses, runner };
}

function formatterDefinition(args: readonly string[]) {
  return {
    command: process.execPath,
    args,
    files: { extensions: [".txt"] },
  };
}

function toolResultEvent(toolName: string, result: FormatterTestToolResult): ToolResultEvent {
  return {
    type: "tool_result",
    toolName,
    toolCallId: "call-1",
    input: result.input,
    content: [{ type: "text", text: "changed" }],
    details: result.details,
    isError: false,
  };
}

beforeEach(async () => {
  vi.stubGlobal("fetch", () =>
    Promise.reject(new Error("Unexpected network in offline formatter test")),
  );
  const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const native = await vi.importActual<{ default: typeof crossSpawn }>("cross-spawn");
  vi.mocked(crossSpawn).mockImplementation((command, args, options) => {
    if (existsSync(`${command}.cjs`))
      return native.default(process.execPath, [`${command}.cjs`, ...(args ?? [])], options ?? {});
    return native.default(command, args ?? [], options ?? {});
  });
  vi.mocked(spawn).mockImplementation((command, args, options) => {
    if (basename(String(command)) === "mise" || basename(String(command)) === "mise.exe") {
      return original.spawn(
        process.execPath,
        [fileURLToPath(new URL("./fixtures/mise.cjs", import.meta.url)), ...(args ?? []).slice(2)],
        options ?? {},
      );
    }
    return original.spawn(command, args ?? [], options ?? {});
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Pi Formatter extension lifecycle", { timeout: 20_000 }, () => {
  test("selects the nearest declared formatter and rereads marker changes on the next mutation", async () => {
    const harness = await createFormatterHarness({ formatter: { autoInstall: false } });
    const nested = resolve(harness.cwd, "packages/nested");
    await mkdir(nested, { recursive: true });
    for (const [name, entry, label] of [
      ["prettier", "bin/prettier.cjs", "prettier"],
      ["@biomejs/biome", "bin/biome", "biome"],
    ]) {
      const script = resolve(harness.cwd, `node_modules/${name}/${entry}`);
      await mkdir(resolve(script, ".."), { recursive: true });
      await writeFile(
        script,
        `require('node:fs').appendFileSync(process.argv.at(-1), ':${label}')`,
      );
    }
    await writeFile(
      resolve(harness.cwd, "package.json"),
      JSON.stringify({ devDependencies: { prettier: "*" } }),
    );
    await writeFile(resolve(nested, "biome.json"), "{}");
    const path = resolve(nested, "example.ts");
    await writeFile(path, "original");
    const mutate = () =>
      harness.runner.emitToolResult(
        toolResultEvent("write", { input: { path }, details: undefined }),
      );
    expect(await mutate()).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("original:biome");
    await rm(resolve(nested, "biome.json"));
    expect(await mutate()).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("original:biome:prettier");
  });
  test("the first managed mutation waits for acquisition, formats, and clears progress", async () => {
    vi.stubEnv("PATH", "");
    const harness = await createFormatterHarness({});
    const store = resolve(harness.agentDirectory, "managed-tools");
    await mkdir(store);
    await writeFile(resolve(store, process.platform === "win32" ? "mise.exe" : "mise"), "fixture");
    await writeFile(resolve(harness.cwd, ".prettierrc"), "{}");
    const path = resolve(harness.cwd, "example.ts");
    await writeFile(path, "original");
    await writeFile(resolve(store, "fixture.json"), JSON.stringify({ wait: true }));
    let settled = false;
    const pending = harness.runner
      .emitToolResult(toolResultEvent("write", { input: { path }, details: undefined }))
      .finally(() => {
        settled = true;
      });
    await expect.poll(() => harness.statuses.join("\n"), { timeout: 5000 }).toContain("Installing");
    expect(settled).toBe(false);
    expect(await readFile(path, "utf8")).toBe("original");
    await writeFile(resolve(store, "release"), "");
    expect(await pending).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("original:managed");
    expect(harness.statuses.some((status) => status?.includes("Installing"))).toBe(true);
    expect(harness.statuses.at(-1)).toBeUndefined();
    expect(
      JSON.parse(await readFile(resolve(store, "selections/formatter-prettier.json"), "utf8")),
    ).toMatchObject({ id: "formatter-prettier" });
  });

  test("managed formatting acquires only missing runtimes and retains acquired components", async () => {
    vi.stubEnv("PATH", "");
    const harness = await createFormatterHarness({});
    const store = resolve(harness.agentDirectory, "managed-tools");
    await mkdir(store);
    await writeFile(resolve(store, process.platform === "win32" ? "mise.exe" : "mise"), "fixture");
    const bin = resolve(harness.cwd, "bin");
    await mkdir(bin);
    const node = resolve(bin, process.platform === "win32" ? "node.exe" : "node");
    await copyFile(process.execPath, node);
    await chmod(node, 0o755);
    await writeFile(resolve(harness.cwd, ".prettierrc"), "{}");
    const path = resolve(harness.cwd, "example.ts");
    await writeFile(path, "original");
    const mutate = () =>
      harness.runner.emitToolResult(
        toolResultEvent("write", { input: { path }, details: undefined }),
      );
    expect(await mutate()).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("original:managed");
    const installer = new ToolInstaller(store);
    const previous = await installer.installed("formatter-prettier");
    expect(Object.keys(previous?.components ?? {})).toEqual(["formatter"]);

    await rm(node);
    const script = resolve(harness.cwd, "node_modules/prettier/bin/prettier.cjs");
    await mkdir(dirname(script), { recursive: true });
    await writeFile(script, "require('node:fs').appendFileSync(process.argv.at(-1), ':external')");
    expect(await mutate()).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("original:managed:external");
    const current = await installer.installed("formatter-prettier");
    expect(current?.components.node).toBeDefined();
    expect(current?.components.formatter).toEqual(previous?.components.formatter);
  });

  test.each([
    ["biome", ".ts", "biome.json", "{}"],
    ["black", ".py", "pyproject.toml", "[tool.black]"],
    ["ruff", ".py", "ruff.toml", ""],
    ["gofmt", ".go", "go.mod", "module example.com/fixture"],
    ["rustfmt", ".rs", "Cargo.toml", '[package]\nname="fixture"'],
  ])(
    "first-use %s launches the proven managed entrypoint with native argv",
    async (id, extension, marker, content) => {
      vi.stubEnv("PATH", "");
      const harness = await createFormatterHarness({});
      const store = resolve(harness.agentDirectory, "managed-tools");
      await mkdir(store);
      await writeFile(
        resolve(store, process.platform === "win32" ? "mise.exe" : "mise"),
        "fixture",
      );
      await writeFile(resolve(harness.cwd, marker), content);
      const path = resolve(harness.cwd, `example${extension}`);
      await writeFile(path, "original");
      const result = await harness.runner.emitToolResult(
        toolResultEvent("write", { input: { path }, details: undefined }),
      );
      expect(result).toBeUndefined();
      expect(await readFile(path, "utf8")).toBe("original:managed");
      expect(
        JSON.parse(await readFile(resolve(store, `selections/formatter-${id}.json`), "utf8")),
      ).toMatchObject({ id: `formatter-${id}` });
    },
  );

  test("project tool/runtime precede PATH and managed copies, while installed-only reuses tools without a helper", async () => {
    vi.stubEnv("PATH", "");
    const harness = await createFormatterHarness({});
    const store = resolve(harness.agentDirectory, "managed-tools");
    await mkdir(store);
    const helper = resolve(store, process.platform === "win32" ? "mise.exe" : "mise");
    await writeFile(helper, "fixture");
    await writeFile(resolve(harness.cwd, ".prettierrc"), "{}");
    const nestedRoot = resolve(harness.cwd, "packages/nested");
    await mkdir(resolve(nestedRoot, "src"), { recursive: true });
    const path = resolve(nestedRoot, "src/example.ts");
    await writeFile(path, "original");
    const mutate = () =>
      harness.runner.emitToolResult(
        toolResultEvent("write", { input: { path }, details: undefined }),
      );
    expect(await mutate()).toBeUndefined();
    await rm(helper);
    await writeFile(
      resolve(harness.agentDirectory, "settings.json"),
      JSON.stringify({ formatter: { autoInstall: false } }),
    );
    await harness.runner.emit({ type: "session_start", reason: "reload" });
    expect(await mutate()).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("original:managed:managed");
    const bin = resolve(harness.cwd, "external tools 空間");
    await mkdir(bin);
    const pathScript = resolve(bin, "formatter.cjs");
    await writeFile(pathScript, "require('node:fs').appendFileSync(process.argv.at(-1),':PATH')");
    const shim = resolve(bin, process.platform === "win32" ? "prettier.cmd" : "prettier");
    await writeFile(
      shim,
      process.platform === "win32"
        ? `@"${process.execPath}" "%~dp0formatter.cjs" %*\r\n`
        : `#!${process.execPath}\nrequire(${JSON.stringify(pathScript)})`,
    );
    await chmod(shim, 0o755);
    const externalPath = [bin, dirname(process.execPath)].join(delimiter);
    vi.stubEnv("PATH", externalPath);
    expect(await mutate()).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("original:managed:managed:PATH");
    const projectScript = resolve(nestedRoot, "node_modules/prettier/bin/prettier.cjs");
    const node = resolve(
      nestedRoot,
      "node_modules/.bin",
      process.platform === "win32" ? "node.exe" : "node",
    );
    await mkdir(dirname(projectScript), { recursive: true });
    await mkdir(dirname(node), { recursive: true });
    await copyFile(process.execPath, node);
    await writeFile(
      projectScript,
      "require('node:fs').appendFileSync(process.argv.at(-1),':project:'+process.execPath)",
    );
    expect(await mutate()).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(`original:managed:managed:PATH:project:${node}`);
    expect(process.env.PATH).toBe(externalPath);
    await rm(projectScript);
    await writeFile(pathScript, "throw new Error('external failure')");
    const result = await mutate();
    expect(result?.content?.at(-1)).toMatchObject({
      text: expect.stringContaining("external failure"),
    });
    expect(await readFile(path, "utf8")).toBe(`original:managed:managed:PATH:project:${node}`);
  });

  test.each(["native", "npm-script", "npm-shim"])(
    "Biome %s acquires Node only when its executable requires it",
    async (kind) => {
      vi.stubEnv("PATH", "");
      const harness = await createFormatterHarness({ formatter: { autoInstall: false } });
      const store = resolve(harness.agentDirectory, "managed-tools");
      await mkdir(store);
      await writeFile(
        resolve(store, process.platform === "win32" ? "mise.exe" : "mise"),
        "fixture",
      );
      await writeFile(resolve(harness.cwd, "biome.json"), "{}");
      const script = "require('node:fs').appendFileSync(process.argv.at(-1), ':biome')";
      const bin = resolve(harness.cwd, "bin");
      await mkdir(bin);
      if (kind === "native") {
        const command = resolve(bin, process.platform === "win32" ? "biome.exe" : "biome");
        await copyFile(process.execPath, command);
        await chmod(command, 0o755);
        await writeFile(`${command}.cjs`, script);
      } else if (kind === "npm-script") {
        const command = resolve(harness.cwd, "node_modules/@biomejs/biome/bin/biome");
        await mkdir(dirname(command), { recursive: true });
        await writeFile(command, script);
      } else {
        const command = resolve(bin, process.platform === "win32" ? "biome.cmd" : "biome");
        const entry = resolve(harness.cwd, "formatter.cjs");
        await writeFile(entry, script);
        await writeFile(
          command,
          process.platform === "win32"
            ? '@node "%~dp0..\\formatter.cjs" %*\r\n'
            : `#!/usr/bin/env node\nrequire(${JSON.stringify(entry)})`,
        );
        await chmod(command, 0o755);
      }
      const path = resolve(harness.cwd, "example.ts");
      await writeFile(path, "original");
      const mutate = () =>
        harness.runner.emitToolResult(
          toolResultEvent("write", { input: { path }, details: undefined }),
        );
      const result = await mutate();
      const installer = new ToolInstaller(store);
      expect(await installer.installed("formatter-biome")).toBeUndefined();
      if (kind === "native") expect(result).toBeUndefined();
      else {
        expect(result?.content?.at(-1)).toMatchObject({
          text: expect.stringContaining("assistance unavailable"),
        });
        expect(await readFile(path, "utf8")).toBe("original");
        await writeFile(resolve(harness.agentDirectory, "settings.json"), "{}");
        await harness.runner.emit({ type: "session_start", reason: "reload" });
        expect(await mutate()).toBeUndefined();
        expect(
          Object.keys((await installer.installed("formatter-biome"))?.components ?? {}),
        ).toEqual(["node"]);
      }
      expect(await readFile(path, "utf8")).toBe("original:biome");
    },
  );

  test.each(["rustfmt", "prettier"])(
    "%s uses ancestor executables only inside the project boundary or through PATH",
    async (id) => {
      vi.stubEnv("PATH", "");
      const outer = await makeTemporaryDirectory("pi-formatter-boundary-");
      const cwd = resolve(outer, "project");
      const bin = resolve(outer, "bin");
      await mkdir(cwd);
      await mkdir(bin);
      const node = resolve(bin, process.platform === "win32" ? "node.exe" : "node");
      await copyFile(process.execPath, node);
      await chmod(node, 0o755);
      const script = "require('node:fs').appendFileSync(process.argv.at(-1), ':formatted')";
      const formatter = resolve(bin, process.platform === "win32" ? "rustfmt.exe" : "rustfmt");
      await copyFile(process.execPath, formatter);
      await chmod(formatter, 0o755);
      await writeFile(`${formatter}.cjs`, script);
      const prettier = resolve(cwd, "node_modules/prettier/bin/prettier.cjs");
      await mkdir(dirname(prettier), { recursive: true });
      await writeFile(prettier, script);
      await writeFile(resolve(cwd, ".prettierrc"), "{}");
      const harness = await createFormatterHarness(
        { formatter: { autoInstall: false } },
        undefined,
        cwd,
      );
      const path = resolve(cwd, id === "rustfmt" ? "example.rs" : "example.ts");
      await writeFile(path, "original");
      const mutate = () =>
        harness.runner.emitToolResult(
          toolResultEvent("write", { input: { path }, details: undefined }),
        );
      expect((await mutate())?.content?.at(-1)).toMatchObject({
        text: expect.stringContaining("assistance unavailable"),
      });
      expect(await readFile(path, "utf8")).toBe("original");
      vi.stubEnv("PATH", bin);
      expect(await mutate()).toBeUndefined();
      expect(await readFile(path, "utf8")).toBe("original:formatted");
      vi.stubEnv("PATH", "");
      await writeFile(resolve(outer, ".git"), "gitdir: fixture-worktree");
      expect(await mutate()).toBeUndefined();
      expect(await readFile(path, "utf8")).toBe("original:formatted:formatted");
    },
  );

  test("uses a declared non-Git package above the session working directory", async () => {
    vi.stubEnv("PATH", "");
    const root = await makeTemporaryDirectory("pi-formatter-nongit-package-");
    const cwd = resolve(root, "packages/nested");
    await mkdir(cwd, { recursive: true });
    await writeFile(
      resolve(root, "package.json"),
      JSON.stringify({ devDependencies: { prettier: "*" } }),
    );
    const script = resolve(root, "node_modules/prettier/bin/prettier.cjs");
    const node = resolve(
      root,
      "node_modules/.bin",
      process.platform === "win32" ? "node.exe" : "node",
    );
    await mkdir(dirname(script), { recursive: true });
    await mkdir(dirname(node), { recursive: true });
    await copyFile(process.execPath, node);
    await chmod(node, 0o755);
    await writeFile(script, "require('node:fs').appendFileSync(process.argv.at(-1), ':package')");
    const harness = await createFormatterHarness(
      { formatter: { autoInstall: false } },
      undefined,
      cwd,
    );
    const path = resolve(cwd, "example.ts");
    await writeFile(path, "original");
    expect(
      await harness.runner.emitToolResult(
        toolResultEvent("write", { input: { path }, details: undefined }),
      ),
    ).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("original:package");
  });

  test("update advances only installed owned presets and reports old/new, no-change, and failures", async () => {
    const harness = await createFormatterHarness({});
    const store = resolve(harness.agentDirectory, "managed-tools");
    await mkdir(store);
    await writeFile(resolve(store, process.platform === "win32" ? "mise.exe" : "mise"), "fixture");
    await writeFile(resolve(harness.cwd, ".prettierrc"), "{}");
    const path = resolve(harness.cwd, "example.ts");
    await writeFile(path, "original");
    await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path }, details: undefined }),
    );
    const command = harness.runner.getCommand("formatter");
    expect(command).toBeDefined();
    if (!command) throw new Error("Missing /formatter command");
    await writeFile(
      resolve(harness.agentDirectory, "settings.json"),
      JSON.stringify({ formatter: { autoInstall: false } }),
    );
    await harness.runner.emit({ type: "session_start", reason: "reload" });
    await writeFile(resolve(store, "fixture.json"), JSON.stringify({ version: "2.0.0" }));
    await command.handler("update", harness.runner.createCommandContext());
    expect(harness.notifications.at(-1)).toContain("1.0.0 ->");
    expect(harness.notifications.at(-1)).toContain("2.0.0");
    await expect(readFile(resolve(store, "selections/formatter-biome.json"))).rejects.toThrow();
    await command.handler("update prettier", harness.runner.createCommandContext());
    expect(harness.notifications.at(-1)).toContain("no change");
    await writeFile(
      resolve(store, "fixture.json"),
      JSON.stringify({ version: "3.0.0", fail: true }),
    );
    await command.handler("update prettier", harness.runner.createCommandContext());
    expect(harness.notifications.at(-1)).toContain("failed");
    expect(
      JSON.parse(await readFile(resolve(store, "selections/formatter-prettier.json"), "utf8"))
        .components.formatter.version,
    ).toBe("2.0.0");
    expect(harness.statuses.at(-1)).toBeUndefined();
  });

  test("headless update reports unused presets without acquiring tools or opening terminal UI", async () => {
    const harness = await createFormatterHarness({ formatter: { autoInstall: false } });
    harness.runner.setUIContext(undefined, "print");
    const command = harness.runner.getCommand("formatter");
    if (!command) throw new Error("Missing /formatter");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await command.handler("update", harness.runner.createCommandContext());
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("No installed managed formatters"),
      );
      await expect(
        readFile(
          resolve(harness.agentDirectory, "managed-tools/selections/formatter-prettier.json"),
        ),
      ).rejects.toThrow();
    } finally {
      stderr.mockRestore();
    }
  });

  test.each(["rpc", "tui", "shutdown"])(
    "an idle %s update can be cancelled while retaining the working installation",
    async (mode) => {
      vi.stubEnv("PATH", "");
      const harness = await createFormatterHarness({});
      const store = resolve(harness.agentDirectory, "managed-tools");
      await mkdir(store);
      await writeFile(
        resolve(store, process.platform === "win32" ? "mise.exe" : "mise"),
        "fixture",
      );
      await writeFile(resolve(harness.cwd, ".prettierrc"), "{}");
      const path = resolve(harness.cwd, "example.ts");
      await writeFile(path, "original");
      await harness.runner.emitToolResult(
        toolResultEvent("write", { input: { path }, details: undefined }),
      );
      const command = harness.runner.getCommand("formatter");
      if (!command) throw new Error("Missing /formatter");
      await writeFile(
        resolve(store, "fixture.json"),
        JSON.stringify({ version: "2.0.0", wait: true }),
      );
      const opened = Promise.withResolvers<Component>();
      if (mode === "tui") {
        initTheme("dark", false);
        const tui = new TuiMainScreen(new ProcessTerminal());
        vi.spyOn(tui, "requestRender").mockImplementation(() => undefined);
        const ui = harness.runner.getUIContext();
        harness.runner.setUIContext(
          {
            ...ui,
            custom: async <T>(factory: Parameters<typeof ui.custom<T>>[0]) => {
              const result = Promise.withResolvers<T>();
              // SAFETY: This command does not read SDK-only keybinding persistence methods.
              const component = await factory(
                tui,
                ui.theme,
                getKeybindings() as KeybindingsManager,
                result.resolve,
              );
              opened.resolve(component);
              return result.promise;
            },
          },
          "tui",
        );
      }
      harness.statuses.length = 0;
      const pending = command.handler("update prettier", harness.runner.createCommandContext());
      await expect
        .poll(() => harness.statuses.join("\n"), { timeout: 5000 })
        .toContain("Installing");
      if (mode === "tui") (await opened.promise).handleInput?.("\x1b");
      else if (mode === "shutdown")
        await harness.runner.emit({ type: "session_shutdown", reason: "reload" });
      else await command.handler("update cancel", harness.runner.createCommandContext());
      await pending;
      expect(harness.notifications.at(-1)).toContain("cancelled");
      expect(
        JSON.parse(await readFile(resolve(store, "selections/formatter-prettier.json"), "utf8"))
          .components.formatter.version,
      ).toBe("1.0.0");
      expect(harness.statuses.at(-1)).toBeUndefined();
    },
  );

  test.each([
    [".ts", "package.json", '{"description":"prettier @biomejs/biome"}', undefined],
    [".py", "pyproject.toml", '[project]\nname="ruff-black"\ndescription="[tool.ruff]"', undefined],
    [".py", "pyproject.toml", "[tool.black]\nline-length=88", "black"],
    [".py", "pyproject.toml", '[project]\nname="example"\ndependencies=["ruff>=0.9"]', "ruff"],
    [".py", "ruff.toml", "line-length=88", "ruff"],
    [".go", "go.mod", "module example.com/test", "gofmt"],
    [".rs", "Cargo.toml", '[package]\nname="test"', "rustfmt"],
  ])(
    "recognizes only real declarations for %s with %s",
    async (extension, marker, content, expected) => {
      vi.stubEnv("PATH", "");
      const harness = await createFormatterHarness({ formatter: { autoInstall: false } });
      await writeFile(resolve(harness.cwd, marker), content);
      const path = resolve(harness.cwd, `example${extension}`);
      await writeFile(path, "original");
      const result = await harness.runner.emitToolResult(
        toolResultEvent("write", { input: { path }, details: undefined }),
      );
      if (expected)
        expect(result?.content?.at(-1)).toMatchObject({ text: expect.stringContaining(expected) });
      else expect(result).toBeUndefined();
    },
  );

  test.each([null, { command: "broken" }])(
    "same-ID null and invalid settings suppress built-ins (%j)",
    async (definition) => {
      const harness = await createFormatterHarness({
        formatter: { formatters: { prettier: definition } },
      });
      await writeFile(resolve(harness.cwd, ".prettierrc"), "{}");
      const path = resolve(harness.cwd, "example.ts");
      await writeFile(path, "original");
      expect(
        await harness.runner.emitToolResult(
          toolResultEvent("write", { input: { path }, details: undefined }),
        ),
      ).toBeUndefined();
      expect(await readFile(path, "utf8")).toBe("original");
    },
  );

  test.each([false, true])(
    "an explicit different-ID definition owns matching files even when its gate skips or command fails (%s)",
    async (requireRootMarker) => {
      const harness = await createFormatterHarness({
        formatter: {
          formatters: {
            custom: {
              command: process.execPath,
              args: ["-e", "process.exit(9)", "$FILE"],
              files: { extensions: [".ts"] },
              requireRootMarker,
              rootMarkers: ["missing-marker"],
            },
          },
        },
      });
      await writeFile(resolve(harness.cwd, ".prettierrc"), "{}");
      const path = resolve(harness.cwd, "example.ts");
      await writeFile(path, "original");
      const result = await harness.runner.emitToolResult(
        toolResultEvent("write", { input: { path }, details: undefined }),
      );
      if (requireRootMarker) expect(result).toBeUndefined();
      else
        expect(result?.content?.at(-1)).toMatchObject({
          text: expect.stringContaining("custom failed"),
        });
      expect(harness.statuses.filter(Boolean)).toEqual([]);
      expect(await readFile(path, "utf8")).toBe("original");
    },
  );

  test.each(["failure", "cancel", "shutdown", "installed-only"])(
    "first acquisition %s preserves mutation success and clears status",
    async (mode) => {
      vi.stubEnv("PATH", "");
      const controller = new AbortController();
      const harness = await createFormatterHarness(
        { formatter: { autoInstall: mode !== "installed-only" } },
        controller.signal,
      );
      const started = Promise.withResolvers<void>();
      vi.stubGlobal("fetch", (_url: string, options: RequestInit) => {
        started.resolve();
        if (mode === "failure") return Promise.reject(new Error("Fixture download failed"));
        return new Promise((_resolve, reject) =>
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          }),
        );
      });
      await writeFile(resolve(harness.cwd, ".prettierrc"), "{}");
      const path = resolve(harness.cwd, "example.ts");
      await writeFile(path, "successful mutation");
      const pending = harness.runner.emitToolResult(
        toolResultEvent("write", { input: { path }, details: undefined }),
      );
      if (mode === "cancel" || mode === "shutdown") {
        await started.promise;
        if (mode === "cancel") controller.abort();
        else await harness.runner.emit({ type: "session_shutdown", reason: "reload" });
      }
      const result = await pending;
      expect(result?.isError).toBe(false);
      expect(result?.content?.[0]).toEqual({ type: "text", text: "changed" });
      expect(result?.content?.at(-1)).toMatchObject({
        text: expect.stringContaining("assistance unavailable"),
      });
      expect(await readFile(path, "utf8")).toBe("successful mutation");
      expect(harness.statuses.at(-1)).toBeUndefined();
      await expect(
        readFile(
          resolve(
            harness.agentDirectory,
            "managed-tools",
            process.platform === "win32" ? "mise.exe" : "mise",
          ),
        ),
      ).rejects.toThrow();
    },
  );

  test.each(["2021", "workspace", "config"])(
    "Rust formatting respects %s edition for modern syntax",
    async (edition) => {
      const harness = await createFormatterHarness({ formatter: { autoInstall: false } });
      const root = resolve(harness.cwd, "crates/example");
      await mkdir(resolve(root, "src"), { recursive: true });
      await writeFile(
        resolve(harness.cwd, "Cargo.toml"),
        '[workspace]\nmembers=["crates/example"]\n[workspace.package]\nedition="2024"',
      );
      await writeFile(
        resolve(root, "Cargo.toml"),
        `[package]\nname="example"\nversion="0.1.0"\n${edition === "workspace" ? "edition.workspace=true" : 'edition="2021"'}`,
      );
      if (edition === "config") await writeFile(resolve(root, "rustfmt.toml"), 'edition="2024"');
      const script = resolve(harness.cwd, "rustfmt.cjs");
      await writeFile(
        script,
        `const fs=require('node:fs');const args=process.argv.slice(2);if(!args.includes('skip_children=true'))process.exit(8);if(${edition === "config" ? 'args.includes("--edition")' : `args[0]!=="--edition" || args[1]!=="${edition === "workspace" ? "2024" : "2021"}"`})process.exit(7);fs.writeFileSync(args.at(-1),'async fn main() {}\\n');`,
      );
      const bin = resolve(root, "bin");
      await mkdir(bin);
      const executable = resolve(bin, process.platform === "win32" ? "rustfmt.cmd" : "rustfmt");
      await writeFile(
        executable,
        process.platform === "win32"
          ? `@"${process.execPath}" "${script}" %*\r\n`
          : `#!${process.execPath}\nrequire(${JSON.stringify(script)})`,
      );
      await chmod(executable, 0o755);
      const path = resolve(root, "src/main.rs");
      await writeFile(path, "async fn main(){ }");
      expect(
        await harness.runner.emitToolResult(
          toolResultEvent("write", { input: { path }, details: undefined }),
        ),
      ).toBeUndefined();
      expect(await readFile(path, "utf8")).toBe("async fn main() {}\n");
    },
  );

  test("warns on same-root conflicts instead of choosing catalog order", async () => {
    const harness = await createFormatterHarness({ formatter: { autoInstall: false } });
    await writeFile(resolve(harness.cwd, "pyproject.toml"), "[tool.black]\n[tool.ruff]");
    const path = resolve(harness.cwd, "example.py");
    await writeFile(path, "original");
    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path }, details: undefined }),
    );
    expect(result?.content?.at(-1)).toMatchObject({
      text: expect.stringContaining("Conflicting Formatter Markers"),
    });
    expect(await readFile(path, "utf8")).toBe("original");
  });

  test("formats every apply_patch destination and runs a workspace formatter once", async () => {
    const perFileScript =
      "const fs=require('node:fs');const p=process.argv[1];fs.appendFileSync(p,':'+process.env.PI_FORMATTER_TEST)";
    const workspaceScript =
      "const fs=require('node:fs');const p='workspace-runs';const n=fs.existsSync(p)?+fs.readFileSync(p,'utf8'):0;fs.writeFileSync(p,String(n+1))";
    const harness = await createFormatterHarness({
      formatter: {
        formatters: {
          perFile: {
            ...formatterDefinition(["-e", perFileScript, "$FILE"]),
            environment: { PI_FORMATTER_TEST: "formatted" },
          },
          workspace: formatterDefinition(["-e", workspaceScript]),
        },
      },
    });
    const first = resolve(harness.cwd, "first.txt");
    const second = resolve(harness.cwd, "second.txt");
    await Promise.all([writeFile(first, "one"), writeFile(second, "two")]);

    const result = await harness.runner.emitToolResult(
      toolResultEvent("apply_patch", {
        input: {},
        details: {
          status: "success",
          result: {
            changedFiles: [first],
            createdFiles: [second],
            deletedFiles: [],
            movedFiles: [],
          },
        },
      }),
    );

    expect(result).toBeUndefined();
    expect(await readFile(first, "utf8")).toBe("one:formatted");
    expect(await readFile(second, "utf8")).toBe("two:formatted");
    expect(await readFile(resolve(harness.cwd, "workspace-runs"), "utf8")).toBe("1");
  });

  test("runs formatters from each changed file's nearest root marker", async () => {
    const script =
      "const fs=require('node:fs');const p=process.argv[1];fs.appendFileSync(p,':'+process.cwd())";
    const workspaceScript =
      "const fs=require('node:fs');fs.writeFileSync('workspace-root',process.cwd())";
    const harness = await createFormatterHarness({
      formatter: {
        formatters: {
          rooted: {
            ...formatterDefinition(["-e", script, "$FILE"]),
            rootMarkers: ["package.json"],
          },
          rootedWorkspace: {
            ...formatterDefinition(["-e", workspaceScript]),
            rootMarkers: ["package.json"],
          },
        },
      },
    });
    const packageRoot = resolve(harness.cwd, "packages/example");
    const filePath = resolve(packageRoot, "src/rooted.txt");
    await mkdir(resolve(packageRoot, "src"), { recursive: true });
    await Promise.all([
      writeFile(resolve(packageRoot, "package.json"), "{}"),
      writeFile(filePath, "root"),
    ]);

    await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(await readFile(filePath, "utf8")).toBe(`root:${packageRoot}`);
    expect(await readFile(resolve(packageRoot, "workspace-root"), "utf8")).toBe(packageRoot);
  });

  test("activates file and workspace formatters only while a required root marker exists", async () => {
    const fileScript =
      "const fs=require('node:fs');const p=process.argv[1];fs.appendFileSync(p,':formatted')";
    const workspaceScript =
      "const fs=require('node:fs');fs.writeFileSync('workspace-formatted','yes')";
    const harness = await createFormatterHarness({
      formatter: {
        formatters: {
          gatedFile: {
            ...formatterDefinition(["-e", fileScript, "$FILE"]),
            requireRootMarker: true,
            rootMarkers: ["formatter.config.json"],
          },
          gatedWorkspace: {
            ...formatterDefinition(["-e", workspaceScript]),
            requireRootMarker: true,
            rootMarkers: ["formatter.config.json"],
          },
        },
      },
    });
    const filePath = resolve(harness.cwd, "src/gated.txt");
    await mkdir(resolve(harness.cwd, "src"));
    await writeFile(filePath, "original");

    await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(await readFile(filePath, "utf8")).toBe("original");
    await expect(readFile(resolve(harness.cwd, "workspace-formatted"))).rejects.toThrow();

    await writeFile(resolve(harness.cwd, "formatter.config.json"), "{}");
    await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(await readFile(filePath, "utf8")).toBe("original:formatted");
    expect(await readFile(resolve(harness.cwd, "workspace-formatted"), "utf8")).toBe("yes");
  });

  test.each([
    ["edit", (path: string) => ({ input: { path }, details: undefined })],
    ["write", (path: string) => ({ input: { path }, details: undefined })],
    [
      "lsp apply",
      (path: string) => ({
        input: {
          operation: "apply",
          mutation_manifest: [{ operation: "modify", path }],
        },
        details: { kind: "workspace_edit_apply", state: "applied", changed_paths: [path] },
      }),
    ],
  ])("formats successful %s mutations", async (name, eventForPath) => {
    const script =
      "const fs=require('node:fs');const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,'utf8').toUpperCase())";
    const harness = await createFormatterHarness({
      formatter: { formatters: { uppercase: formatterDefinition(["-e", script, "$FILE"]) } },
    });
    const filePath = resolve(harness.cwd, `${basename(name)}.txt`);
    await writeFile(filePath, "format me");
    const event = eventForPath(filePath);

    await harness.runner.emitToolResult(
      toolResultEvent(name === "lsp apply" ? "lsp" : name, event),
    );

    expect(await readFile(filePath, "utf8")).toBe("FORMAT ME");
  });

  test("warns without changing mutation success and continues after a formatter fails", async () => {
    const successScript =
      "const fs=require('node:fs');const p=process.argv[1];fs.appendFileSync(p,':continued')";
    const harness = await createFormatterHarness({
      formatter: {
        formatters: {
          invalidSpawn: { ...formatterDefinition(["$FILE"]), command: "\0" },
          broken: formatterDefinition([
            "-e",
            "console.error('expected stderr');process.exit(7)",
            "$FILE",
          ]),
          later: formatterDefinition(["-e", successScript, "$FILE"]),
        },
      },
    });
    const filePath = resolve(harness.cwd, "failure.txt");
    await writeFile(filePath, "original");

    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(result).toMatchObject({ isError: false });
    expect(result?.content?.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringMatching(
        /Pi Formatter: invalidSpawn failed .*failure\.txt \(spawn error\)/,
      ),
    });
    expect(result?.content?.at(-1)).toMatchObject({
      text: expect.stringMatching(
        /Pi Formatter: broken failed .*failure\.txt \(exit code 7\): expected stderr/,
      ),
    });
    expect(await readFile(filePath, "utf8")).toBe("original:continued");
  });

  test.each(["explicit", "built-in"])(
    "%s file formatting shares the native write queue for its entire read-modify-write window",
    async (mode) => {
      const script = `const fs=require('node:fs'),p=process.argv.at(-1),text=fs.readFileSync(p,'utf8');const finish=()=>fs.writeFileSync(p,text+':formatted');if(text==='A'){fs.writeFileSync(p+'.ready','');const timer=setInterval(()=>{if(fs.existsSync(p+'.release')){clearInterval(timer);finish()}},10)}else finish();`;
      const settings: FormatterSettingsDocumentInput =
        mode === "explicit"
          ? {
              formatter: {
                autoInstall: false,
                formatters: { queued: formatterDefinition(["-e", script, "$FILE"]) },
              },
            }
          : { formatter: { autoInstall: false } };
      const harness = await createFormatterHarness(settings);
      if (mode === "built-in") {
        const entry = resolve(harness.cwd, "node_modules/prettier/bin/prettier.cjs");
        const node = resolve(
          harness.cwd,
          "bin",
          process.platform === "win32" ? "node.exe" : "node",
        );
        await mkdir(dirname(entry), { recursive: true });
        await mkdir(dirname(node), { recursive: true });
        await writeFile(entry, script);
        await copyFile(process.execPath, node);
        await chmod(node, 0o755);
        await writeFile(resolve(harness.cwd, ".prettierrc"), "{}");
      }
      const path = resolve(harness.cwd, mode === "explicit" ? "example.txt" : "example.ts");
      const writer = createWriteTool(harness.cwd);
      const mutate = async (id: string, content: string) => {
        const input = { path, content };
        const result = await writer.execute(id, input);
        return harness.runner.emitToolResult({
          type: "tool_result",
          toolName: "write",
          toolCallId: id,
          input,
          ...result,
          isError: false,
        });
      };
      const first = mutate("first", "A");
      await expect.poll(() => existsSync(`${path}.ready`), { timeout: 5000 }).toBe(true);
      const second = mutate("second", "B");
      try {
        await new Promise((done) => setTimeout(done, 100));
        expect(await readFile(path, "utf8")).toBe("A");
      } finally {
        await writeFile(`${path}.release`, "");
        await Promise.all([first, second]);
      }
      expect(await readFile(path, "utf8")).toBe("B:formatted");
    },
  );

  test("cancels an active formatter without leaving it able to write after middleware returns", async () => {
    const controller = new AbortController();
    const script =
      "const fs=require('node:fs'),p=process.argv[1];process.on('SIGTERM',()=>fs.appendFileSync(p,':late'));fs.appendFileSync(p,':ready');setInterval(()=>{},1000)";
    const harness = await createFormatterHarness(
      { formatter: { formatters: { hanging: formatterDefinition(["-e", script, "$FILE"]) } } },
      controller.signal,
    );
    const path = resolve(harness.cwd, "example.txt");
    await writeFile(path, "original");
    const pending = harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path }, details: undefined }),
    );
    await expect.poll(() => readFile(path, "utf8"), { timeout: 5000 }).toBe("original:ready");
    controller.abort();
    expect((await pending)?.isError).toBe(false);
    expect(await readFile(path, "utf8")).toBe("original:ready");
  });

  test("bounds a hanging formatter with the configured timeout", async () => {
    const harness = await createFormatterHarness({
      formatter: {
        timeoutMs: 25,
        formatters: {
          hanging: formatterDefinition(["-e", "setInterval(() => {}, 1000)", "$FILE"]),
        },
      },
    });
    const filePath = resolve(harness.cwd, "timeout.txt");
    await writeFile(filePath, "original");

    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: filePath }, details: undefined }),
    );

    expect(result?.content?.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringMatching(
        /Pi Formatter: hanging failed .*timeout\.txt \(timeout after 25ms\)/,
      ),
    });
  });

  test("reports quarantined settings and skips vanished files", async () => {
    const harness = await createFormatterHarness({
      formatter: {
        unknownField: true,
        formatters: { valid: formatterDefinition(["-e", "process.exit(9)", "$FILE"]) },
      },
    });
    const vanished = resolve(harness.cwd, "vanished.txt");

    const result = await harness.runner.emitToolResult(
      toolResultEvent("write", { input: { path: vanished }, details: undefined }),
    );

    expect(result).toBeUndefined();
    expect(harness.notifications).toEqual([
      expect.stringContaining("global formatter.unknownField"),
    ]);
  });
});
