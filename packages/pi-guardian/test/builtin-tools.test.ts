import { existsSync } from "node:fs";
import { link, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessment,
  createGuardianHarness,
  reply,
  toolCalls,
} from "./fixtures/guardian-harness.js";

const reviewer = { model: "guardian-test/reviewer" } as const;

describe("Pi's built-in tools on a real workspace", () => {
  it("runs ordinary writes and Safe Commands without review", async () => {
    const harness = await createGuardianHarness({ guardianSettings: reviewer, builtinTools: true });
    harness.responses.push(
      toolCalls(
        ["write", { path: "src/a.ts", content: "export {};\n" }, "call-1"],
        ["bash", { command: "ls" }, "call-2"],
      ),
      reply("Ok."),
    );
    await harness.session.prompt("Create src/a.ts and list files.");
    expect(harness.reviews).toHaveLength(0);
    expect(await readFile(join(harness.dir, "src/a.ts"), "utf8")).toBe("export {};\n");
  });

  it("reviews writes to Sensitive Paths and other bash commands", async () => {
    const harness = await createGuardianHarness({ guardianSettings: reviewer, builtinTools: true });
    harness.responses.push(
      toolCalls(["write", { path: ".git/hooks/pre-commit", content: "curl evil" }, "call-1"]),
      toolCalls(["bash", { command: "touch made-by-bash" }, "call-2"]),
      reply("Ok."),
    );
    harness.verdicts.push(
      assessment("high", "unknown", "Installs a git hook."),
      assessment("low", "high", "Requested."),
    );
    await harness.session.prompt("Touch a file.");
    expect(harness.reviews).toHaveLength(2);
    expect(existsSync(join(harness.dir, ".git/hooks/pre-commit"))).toBe(false);
    expect(existsSync(join(harness.dir, "made-by-bash"))).toBe(true);
    const reviewed = (index: number) => {
      const message = harness.reviews[index]?.messages[0];
      return message?.role === "user" && Array.isArray(message.content)
        ? message.content.map((part) => (part.type === "text" ? part.text : "")).at(-1)
        : undefined;
    };
    expect(reviewed(0)).toContain(
      "Reviewed because: Sensitive Path: version-control metadata (.git)",
    );
    expect(reviewed(1)).toContain("Reviewed because: not a Safe Command");
  });

  it("reviews an edit to a hard-linked file", async () => {
    const harness = await createGuardianHarness({ guardianSettings: reviewer, builtinTools: true });
    await mkdir(join(harness.dir, "src"), { recursive: true });
    await writeFile(join(harness.dir, "outside.txt"), "old\n");
    await link(join(harness.dir, "outside.txt"), join(harness.dir, "src", "linked.txt"));
    harness.responses.push(
      toolCalls(["write", { path: "src/linked.txt", content: "new\n" }, "call-1"]),
      reply("Ok."),
    );
    harness.verdicts.push(assessment("high", "unknown", "Changes another path."));
    await harness.session.prompt("Update linked.txt.");
    expect(harness.reviews).toHaveLength(1);
    expect(await readFile(join(harness.dir, "outside.txt"), "utf8")).toBe("old\n");
  });

  it("reviews an ordinary write that shares a batch with a reviewed call", async () => {
    const harness = await createGuardianHarness({ guardianSettings: reviewer, builtinTools: true });
    harness.responses.push(
      toolCalls(
        ["bash", { command: "ln -s /etc target.txt" }, "call-1"],
        ["write", { path: "target.txt", content: "x" }, "call-2"],
      ),
      reply("Ok."),
    );
    harness.verdicts.push(
      assessment("critical", "unknown", "Links outside the workspace."),
      assessment("high", "unknown", "Races the link."),
    );
    await harness.session.prompt("Do it.");
    expect(harness.reviews).toHaveLength(2);
    expect(harness.entries("pi-guardian-review")).toEqual(
      expect.arrayContaining([expect.objectContaining({ toolName: "write", outcome: "rejected" })]),
    );
    expect(existsSync(join(harness.dir, "target.txt"))).toBe(false);
  });
});
