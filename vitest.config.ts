import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Pi and its built-in extensions (MCP, skills, trust, auth) read the developer's global config from
// the agent directory and from paths under the home directory. Point both at an empty temporary
// tree so test results do not depend on the machine they run on.
const home = mkdtempSync(join(tmpdir(), "pi-test-home-"));
const agentDir = join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
process.once("exit", () => rmSync(home, { recursive: true, force: true }));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // `pnpm verify` runs every package's tests alongside typecheck and lint through Turborepo, and
    // on a 4-vCPU CI runner that contention stretches SDK-driven tests that take well under a
    // second alone past Vitest's 5 s default. The timeout only guards against hangs, so give it
    // room rather than raising it test by test.
    testTimeout: 20_000,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PI_CODING_AGENT_DIR: agentDir,
    },
  },
});
