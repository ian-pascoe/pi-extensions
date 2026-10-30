import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { assertNodeRuntime } from "./scripts/assert-node-runtime.mjs";

// Bun installs dependencies and starts `bun run test`, but the tests run under Node.
assertNodeRuntime();

// The platform's temporary directory can sit behind a symbolic link (macOS's /var is
// /private/var). Code under test resolves real paths, through process.cwd(), realpath, or a child
// process's working directory, so tests that build expected paths from tmpdir() would see two
// spellings of one directory. Resolve it once, here and in the workers.
const temporaryDirectory = realpathSync(tmpdir());
process.env.TMPDIR = temporaryDirectory;

// Pi and its built-in extensions (MCP, skills, trust, auth) read the developer's global config from
// the agent directory and from paths under the home directory. Point both at an empty temporary
// tree so test results do not depend on the machine they run on.
const home = mkdtempSync(join(tmpdir(), "pi-test-home-"));
const agentDir = join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
process.once("exit", () => rmSync(home, { recursive: true, force: true }));

// A Pi session exports its cache retention to commands it runs, which changes provider payloads
// (Anthropic `ttl`, OpenAI `prompt_cache_retention`). Test workers inherit this process's env.
delete process.env.PI_CACHE_RETENTION;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // `bun run verify` runs every package's tests alongside typecheck and lint through Turborepo, and
    // on a 4-vCPU CI runner that contention stretches SDK-driven tests that take well under a
    // second alone past Vitest's 5 s default. The timeout only guards against hangs, so give it
    // room rather than raising it test by test.
    testTimeout: 20_000,
    env: {
      TMPDIR: temporaryDirectory,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PI_CODING_AGENT_DIR: agentDir,
    },
  },
});
