import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const cli = fileURLToPath(
  new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
);
const advisor = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/cli-extension.ts", import.meta.url));
const codemode = fileURLToPath(new URL("../../pi-codemode/src/index.ts", import.meta.url));

it.each([false, true])(
  "enables Advisor through the bundled CLI before and after reload (CodeMode: %s)",
  async (withCodeMode) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-advisor-cli-"));
    const agentDir = join(dir, "agent");
    try {
      await mkdir(agentDir);
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ codemode: { tools: [{ pattern: "read", exposure: "codemode-only" }] } }),
      );
      const completed = execute(
        process.execPath,
        [
          cli,
          "--offline",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "-e",
          fixture,
          ...(withCodeMode ? ["-e", codemode] : []),
          "-e",
          advisor,
          "--provider",
          "advisor-cli-fixture",
          "--model",
          "model",
          "--no-session",
          "--print",
          "/advisor on",
          "/advisor-cli-probe",
          "/advisor-cli-reload",
          "/advisor status",
          "/advisor-cli-probe",
        ],
        {
          cwd: dir,
          env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
          timeout: 20000,
        },
      );
      completed.child.stdin?.end();
      const { stdout, stderr } = await completed;
      const output = stdout + stderr;
      const probes = [...output.matchAll(/^ADVISOR_CLI_PROBE=(.+)$/gm)].map((match) =>
        JSON.parse(match[1] ?? "null"),
      );
      expect(probes).toHaveLength(2);
      for (const probe of probes) {
        expect(probe).toMatchObject({
          status: { state: "armed", error: null, settings: { enabled: true } },
          activeTools: withCodeMode
            ? expect.arrayContaining(["codemode_execute"])
            : expect.arrayContaining(["read"]),
        });
        if (withCodeMode)
          expect(probe).toMatchObject({ activeTools: expect.not.arrayContaining(["read"]) });
      }
      expect(output).not.toContain("Pi CodeMode disabled");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);
