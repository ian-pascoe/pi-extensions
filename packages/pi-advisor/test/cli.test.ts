import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "settles Advisor reviews through the bundled CLI before and after reload (CodeMode: %s, OAuth: %s)",
  async (withCodeMode, withOAuth) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-advisor-cli-"));
    const agentDir = join(dir, "agent");
    try {
      await mkdir(agentDir);
      await writeFile(
        join(agentDir, "auth.json"),
        JSON.stringify({
          [withOAuth ? "advisor-cli-fixture" : "unused-offline-oauth"]: {
            type: "oauth",
            access: "offline-access",
            refresh: "offline-refresh",
            expires: withOAuth ? 0 : 4102444800000,
          },
        }),
      );
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          advisor: {
            allowedTools: [
              "read",
              "grep",
              "find",
              "ls",
              ...(withCodeMode ? ["codemode_execute"] : []),
            ],
          },
          codemode: { tools: [{ pattern: "read", exposure: "codemode-only" }] },
        }),
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
          "Complete the first offline task",
          "/advisor status",
          "/advisor-cli-probe",
          "/advisor-cli-reload",
          "Complete the second offline task",
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
          status: { state: "armed", error: null, backlog: 0, settings: { enabled: true } },
          activeTools: withCodeMode
            ? expect.arrayContaining(["codemode_execute"])
            : expect.arrayContaining(["read"]),
        });
        if (withCodeMode)
          expect(probe).toMatchObject({ activeTools: expect.not.arrayContaining(["read"]) });
      }
      const resources = [...output.matchAll(/^ADVISOR_CLI_RESOURCES=(.+)$/gm)].map((match) =>
        JSON.parse(match[1] ?? "null"),
      );
      const observed = resources.filter((resource) => !resource.privateRole);
      const reviews = resources.filter((resource) => resource.privateRole);
      expect(observed).toHaveLength(2);
      expect(reviews).toHaveLength(2);
      for (const [index, review] of reviews.entries()) {
        expect(review.extensions.slice(0, -1)).toEqual(observed[index].extensions);
        expect(review.extensions.at(-1)).toMatchObject({
          resolvedPath: "<inline:advisor-control>",
        });
        expect(review.extensions).toContainEqual(
          expect.objectContaining({ resolvedPath: "<inline:llama.cpp>", hidden: true }),
        );
      }
      expect(output.match(/^ADVISOR_CLI_INFERENCE=review$/gm)).toHaveLength(2);
      expect(output.match(/^ADVISOR_CLI_INFERENCE=observed$/gm)).toHaveLength(2);
      expect(
        output.match(new RegExp(`^ADVISOR_CLI_AUTH=${withOAuth ? "oauth" : "api-key"}$`, "gm")),
      ).toHaveLength(4);
      expect(output.match(/^ADVISOR_CLI_REFRESH$/gm) ?? []).toHaveLength(withOAuth ? 1 : 0);
      if (withOAuth) {
        const auth = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"));
        expect(auth["advisor-cli-fixture"]).toMatchObject({
          type: "oauth",
          access: "refreshed-offline-access",
          refresh: "offline-refresh",
          expires: 4102444800000,
        });
      }
      expect(output).not.toContain("Pi CodeMode disabled");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);
