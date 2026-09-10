import { execFile } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ToolInstaller, type ManagedInstallation } from "../src/index.js";

const execute = promisify(execFile);
const worker = fileURLToPath(new URL("./fixtures/installer-worker.mjs", import.meta.url));

test.runIf(process.env.PI_TOOL_INSTALLER_NATIVE === "1")(
  "acquires and launches a private native runtime, then reuses its concrete installation offline",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi native tools 空間 "));
    try {
      const installer = new ToolInstaller(directory);
      const request = { id: "node-probe", requirements: { node: "core:node" } };
      const workers = await Promise.all(
        [0, 1].map(() =>
          execute(process.execPath, [worker, directory, "ensure", JSON.stringify(request)], {
            timeout: 170_000,
          }),
        ),
      );
      const installation = await installer.installed(request.id);
      if (!installation) throw new Error("Workers did not select Node");
      for (const result of workers) expect(JSON.parse(result.stdout)).toEqual(installation);
      expect(
        workers.filter((result) =>
          result.stderr.includes("Downloading the private mise installer"),
        ),
      ).toHaveLength(1);
      expect(
        workers.some((result) => result.stderr.includes("Waiting for another Pi process")),
      ).toBe(true);
      const node = installation.components.node;
      expect(node).toBeDefined();
      if (!node) throw new Error("Node component missing");
      const executable = join(
        node.directory,
        process.platform === "win32" ? "node.exe" : "bin/node",
      );
      const result = await execute(executable, ["--version"]);
      expect(result.stdout.trim()).toBe(`v${node.version}`);
      const aborted = new AbortController();
      await expect(
        installer.update(request, {
          signal: aborted.signal,
          onProgress: (message) => {
            if (message.startsWith("Resolving latest ")) {
              queueMicrotask(() => aborted.abort(new Error("Cancel update")));
            }
          },
        }),
      ).rejects.toThrow("Cancel update");
      await expect(installer.installed(request.id)).resolves.toEqual(installation);
      expect((await execute(executable, ["--version"])).stdout.trim()).toBe(`v${node.version}`);
      console.info(`${process.platform}/${process.arch}: private Node ${node.version}`);
      const resumed = new ToolInstaller(directory);
      await expect(resumed.ensure(request, { allowDownload: false })).resolves.toEqual(
        installation,
      );
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  180_000,
);

test.runIf(process.env.PI_TOOL_INSTALLER_NATIVE === "1")(
  "Python updates retain immutable Black environments for the same package version",
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "pi python update 空間 ")));
    const installer = new ToolInstaller(directory);
    const request = (python: string) => ({
      id: "black-update",
      requirements: {
        python: `core:python@${python}`,
        uv: "aqua:astral-sh/uv",
        formatter: "pipx:black@26.5.1",
      },
    });
    const onProgress = (message: string) => console.info(`[python-update] ${message}`);
    const runBlack = async (installation: ManagedInstallation) => {
      const formatter = installation.components.formatter;
      if (!formatter) throw new Error("Missing Black component");
      const python = join(
        formatter.directory,
        process.platform === "win32" ? "black/Scripts/python.exe" : "black/bin/python",
      );
      const runtime = await execute(
        python,
        [
          "-c",
          "import sys,os; print(sys.version.split()[0]); print(os.path.realpath(sys._base_executable))",
        ],
        {
          env: { ...process.env, ...installation.environment, PYTHONDONTWRITEBYTECODE: "1" },
        },
      );
      expect(runtime.stdout.split(/\r?\n/)[0]).toBe(installation.components.python?.version);
      expect(runtime.stdout).toContain(installation.components.python?.directory);
      const formatted = await execute(
        python,
        ["-c", "import black; print(black.format_str('answer= 42\\n', mode=black.Mode()), end='')"],
        {
          env: { ...process.env, ...installation.environment, PYTHONDONTWRITEBYTECODE: "1" },
        },
      );
      expect(formatted.stdout).toBe("answer = 42\n");
      return runtime.stdout;
    };
    try {
      const previous = await installer.ensure(request("3.14.6"), {
        allowDownload: true,
        onProgress,
      });
      const oldOutput = await runBlack(previous);
      const oldPython = previous.components.python;
      const oldFormatter = previous.components.formatter;
      if (!oldPython || !oldFormatter) throw new Error("Missing Python/Black components");
      const config = join(oldFormatter.directory, "black", "pyvenv.cfg");
      const oldConfig = await readFile(config, "utf8");
      const link = join(oldFormatter.directory, "black/bin/python");
      const oldLink = process.platform === "win32" ? undefined : await readlink(link);
      if (oldLink !== undefined) expect(oldLink).toContain(oldPython.directory);
      const runtimeMetadata = async () =>
        Promise.all(
          (await readdir(oldPython.directory, { recursive: true })).sort().map(async (name) => {
            const info = await lstat(join(oldPython.directory, name));
            return [
              name,
              info.size,
              info.mtimeMs,
              info.mode,
              info.isSymbolicLink() ? await readlink(join(oldPython.directory, name)) : null,
            ];
          }),
        );
      const oldMetadata = await runtimeMetadata();
      const updated = await installer.update(request("3.14.7"), { onProgress });
      expect(updated?.previous).toEqual(previous);
      if (!updated) throw new Error("Missing update result");
      expect(updated.current.components.formatter?.version).toBe(oldFormatter.version);
      expect(updated.current.components.formatter?.directory).not.toBe(oldFormatter.directory);
      await runBlack(updated.current);
      expect(await runBlack(previous)).toBe(oldOutput);
      expect(await readFile(config, "utf8")).toBe(oldConfig);
      if (oldLink !== undefined) expect(await readlink(link)).toBe(oldLink);
      expect(await runtimeMetadata()).toEqual(oldMetadata);
      for (const selected of [previous, updated.current]) {
        const formatter = selected.components.formatter;
        if (!formatter) throw new Error("Missing Black environment");
        expect(
          (await readdir(join(formatter.directory, "../.."), { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name),
        ).toEqual(["pipx-black"]);
      }
      await expect(installer.installed("black-update")).resolves.toEqual(updated.current);

      const failing = request("3.14.6");
      failing.requirements.formatter =
        "pipx:black[uvx_args=--definitely-invalid-pi-test-option]@26.5.1";
      await expect(installer.update(failing, { onProgress })).rejects.toThrow(
        "mise install failed",
      );
      await expect(installer.installed("black-update")).resolves.toEqual(updated.current);
      expect(await runBlack(previous)).toBe(oldOutput);
      await runBlack(updated.current);

      const cancelled = request("3.14.6");
      cancelled.requirements.formatter = "pipx:black[uvx_args=--no-cache]@26.5.1";
      const controller = new AbortController();
      let downloading = false;
      await expect(
        installer.update(cancelled, {
          signal: controller.signal,
          onProgress: (message) => {
            onProgress(message);
            if (message.includes("Downloading black")) {
              downloading = true;
              controller.abort(new Error("Cancel during native Black download"));
            }
          },
        }),
      ).rejects.toThrow("Cancel during native Black download");
      expect(downloading).toBe(true);
      await expect(installer.installed("black-update")).resolves.toEqual(updated.current);
      expect(await runBlack(previous)).toBe(oldOutput);
      await runBlack(updated.current);
      const retried = await installer.update(cancelled, { onProgress });
      if (!retried) throw new Error("Missing retried update");
      await runBlack(retried.current);
      expect(await runBlack(previous)).toBe(oldOutput);

      const interrupted = request("3.14.7");
      interrupted.requirements.formatter = "pipx:black[uvx_args=--no-cache]@26.5.1";
      await expect(
        execute(
          process.execPath,
          [worker, directory, "update", JSON.stringify(interrupted), "Downloading black"],
          { timeout: 170_000 },
        ),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("Downloading black") });
      await expect(installer.installed("black-update")).resolves.toEqual(retried.current);
      expect(await runBlack(previous)).toBe(oldOutput);
      await runBlack(retried.current);
      const recovered = await installer.update(interrupted, {
        onProgress,
        signal: AbortSignal.timeout(170_000),
      });
      if (!recovered) throw new Error("Missing recovered update");
      await runBlack(recovered.current);
      expect(await runBlack(previous)).toBe(oldOutput);
      await expect(
        new ToolInstaller(directory).ensure(interrupted, { allowDownload: false }),
      ).resolves.toEqual(recovered.current);
      expect(await runtimeMetadata()).toEqual(oldMetadata);
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  600_000,
);
