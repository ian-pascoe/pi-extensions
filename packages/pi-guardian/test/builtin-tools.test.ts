import { existsSync } from "node:fs";
import { link, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessment,
  confirmedRejection,
  createGuardianHarness,
  reply,
  toolCalls,
} from "./fixtures/guardian-harness.js";

const reviewer = { model: "guardian-test/reviewer" } as const;

/** The Reviewed Call block of a captured Guardian request. */
function reviewedCall(
  harness: Awaited<ReturnType<typeof createGuardianHarness>>,
  index: number,
): string | undefined {
  const message = harness.reviews[index]?.messages[0];
  return message?.role === "user" && Array.isArray(message.content)
    ? message.content.map((part) => (part.type === "text" ? part.text : "")).at(-1)
    : undefined;
}

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
    harness.guardianReplies.push(
      ...confirmedRejection("high", "unknown", "Installs a git hook."),
      assessment("low", "high", "Requested."),
    );
    await harness.session.prompt("Touch a file.");
    // The Rejection is escalated once before it stands.
    expect(harness.reviews.map((review) => review.escalation)).toEqual([false, true, false]);
    expect(existsSync(join(harness.dir, ".git/hooks/pre-commit"))).toBe(false);
    expect(existsSync(join(harness.dir, "made-by-bash"))).toBe(true);
    const reviewed = (index: number) => reviewedCall(harness, index);
    expect(reviewed(0)).toContain(
      'Reviewed because: Sensitive Path: version-control metadata (".git")',
    );
    expect(reviewed(2)).toContain("Reviewed because: not a Safe Command");
  });

  it("runs cd into the workspace without review unless another call of its batch may write", async () => {
    const harness = await createGuardianHarness({ guardianSettings: reviewer, builtinTools: true });
    await mkdir(join(harness.dir, "src"), { recursive: true });
    const command = "cd src && pwd && ls";
    harness.responses.push(
      toolCalls(["bash", { command }, "call-1"]),
      toolCalls(["read", { path: "README.md" }, "call-2"], ["bash", { command }, "call-3"]),
      // Pi prepares a parallel batch's calls before running any, so a write could change `src`,
      // such as by planting a repository, after the cd was judged.
      toolCalls(
        ["write", { path: "src/notes.txt", content: "x\n" }, "call-4"],
        ["bash", { command }, "call-5"],
      ),
      reply("Ok."),
    );
    harness.guardianReplies.push(assessment("low", "high", "Requested."));
    await harness.session.prompt("Look around src.");
    expect(harness.reviews).toHaveLength(1);
    expect(reviewedCall(harness, 0)).toContain(`Arguments: ${JSON.stringify({ command })}`);
    expect(reviewedCall(harness, 0)).toContain('- "write" with arguments');
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
    harness.guardianReplies.push(...confirmedRejection("high", "unknown", "Changes another path."));
    await harness.session.prompt("Update linked.txt.");
    expect(harness.reviews).toHaveLength(2);
    expect(await readFile(join(harness.dir, "outside.txt"), "utf8")).toBe("old\n");
  });

  it("allows an ordinary write beside a reviewed call, which sees it as batch context", async () => {
    const harness = await createGuardianHarness({ guardianSettings: reviewer, builtinTools: true });
    harness.responses.push(
      toolCalls(
        ["bash", { command: "ln -s /etc target.txt" }, "call-1"],
        ["write", { path: "target.txt", content: "x" }, "call-2"],
      ),
      reply("Ok."),
    );
    harness.guardianReplies.push(
      ...confirmedRejection(
        "critical",
        "unknown",
        "Links a path the batch writes.",
        "sensitive_path",
      ),
    );
    await harness.session.prompt("Do it.");
    expect(harness.reviews).toHaveLength(2);
    expect(reviewedCall(harness, 0)).toContain(
      'Other calls in the same tool batch (context only, each reviewed on its own; Pi may run them before or alongside this call):\n- "write" with arguments {"path":"target.txt","content":"x"}',
    );
    expect(await readFile(join(harness.dir, "target.txt"), "utf8")).toBe("x");
  });

  it("shows other batch calls' path and command in full, shortening only their other arguments", async () => {
    const harness = await createGuardianHarness({ guardianSettings: reviewer, builtinTools: true });
    const command = `echo ${"y".repeat(3_000)}`;
    harness.responses.push(
      toolCalls(
        ["bash", { command: "touch made-by-bash" }, "call-1"],
        ["write", { path: "notes.txt", content: "x".repeat(5_000) }, "call-2"],
        ["bash", { command, timeout: 5 }, "call-3"],
      ),
      reply("Ok."),
    );
    harness.guardianReplies.push(assessment("low", "high", "Requested."));
    await harness.session.prompt("Write notes.");
    const shown = reviewedCall(harness, 0) ?? "";
    expect(shown).toContain(
      '- "write" with arguments {"path":"notes.txt"} in full, and other arguments {"content":"xxx',
    );
    expect(shown).toContain("characters omitted from Guardian evidence");
    expect(shown).toContain(
      `- "bash" with arguments ${JSON.stringify({ command })} in full, and other arguments {"timeout":5}`,
    );
  });

  it("reviews an early-reviewed write afresh when its target changed before it arrived", async () => {
    let dir = "";
    const harness = await createGuardianHarness({
      guardianSettings: reviewer,
      builtinTools: true,
      before: [
        (pi) => {
          // Swap the target for a link into .git between the early review and the preflight.
          pi.on("tool_call", async (event) => {
            if (event.toolCallId !== "call-1") return;
            await rm(join(dir, ".env.local"));
            await symlink(join(dir, ".git", "config"), join(dir, ".env.local"));
          });
        },
      ],
    });
    dir = harness.dir;
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "config"), "[core]\n");
    await writeFile(join(dir, ".env.local"), "A=1\n");
    harness.responses.push(
      toolCalls(["write", { path: ".env.local", content: "A=2\n" }, "call-1"]),
      reply("Ok."),
    );
    harness.guardianReplies.push(
      assessment("low", "high", "The user asked to update .env.local."),
      ...confirmedRejection("critical", "unknown", "Overwrites git config.", "sensitive_path"),
    );
    await harness.session.prompt("Set A=2 in .env.local.");
    expect(harness.reviews).toHaveLength(3);
    expect(reviewedCall(harness, 1)).toContain(
      `resolves to ${JSON.stringify(join(dir, ".git", "config"))}`,
    );
    expect(await readFile(join(dir, ".git", "config"), "utf8")).toBe("[core]\n");
    expect(harness.entries("pi-guardian-review")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ result: "unused" }),
        expect.objectContaining({ result: "rejected" }),
      ]),
    );
  });
});
