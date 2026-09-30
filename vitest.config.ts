import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Built-in extensions such as MCP read the global agent directory; keep the user's out of tests.
    env: { PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), "pi-test-agent-")) },
  },
});
