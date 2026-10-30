import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
// Reuse the shared config so `vitest` run directly from this package behaves like `bun run test`,
// and fetch the pinned vscode-js-debug release that the Supported Adapter test runs against.
import sharedConfig from "../../vitest.config.ts";

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      globalSetup: [
        fileURLToPath(new URL("../../scripts/fetch-vscode-js-debug.mjs", import.meta.url)),
      ],
    },
  }),
);
