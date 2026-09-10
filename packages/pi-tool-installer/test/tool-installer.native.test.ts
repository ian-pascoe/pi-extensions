import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { ToolInstaller } from "../src/index.js";

const execute = promisify(execFile);

test.runIf(process.env.PI_TOOL_INSTALLER_NATIVE === "1")(
  "acquires and launches a private native runtime, then reuses its concrete installation offline",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi native tools 空間 "));
    try {
      const installer = new ToolInstaller(directory);
      const request = { id: "node-probe", requirements: { node: "core:node" } };
      const [installation, concurrent] = await Promise.all([
        installer.ensure(request, { allowDownload: true }),
        new ToolInstaller(directory).ensure(request, { allowDownload: true }),
      ]);
      expect(concurrent).toEqual(installation);
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
      await rm(directory, { recursive: true, force: true });
    }
  },
  180_000,
);
