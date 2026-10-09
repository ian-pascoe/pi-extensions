import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { closeExtensionSessions, startExtensionSession } from "./extension-session.js";

const fakeServerPath = fileURLToPath(new URL("fixtures/fake-lsp-server.mjs", import.meta.url));

afterEach(closeExtensionSessions);

/** A pull-only fake server reporting one finding per `diag:<severity>:<code>:<message>` marker. */
function contentServer(environment: Record<string, string> = {}) {
  return {
    command: process.execPath,
    args: [fakeServerPath],
    environment: { FAKE_DIAGNOSTICS: "content", FAKE_PUSH: "none", ...environment },
    languages: [{ extensions: [".ts"], languageId: "typescript" }],
  };
}

function startContentSession(
  files: Readonly<Record<string, string>>,
  options: {
    readonly servers?: Readonly<Record<string, ReturnType<typeof contentServer>>>;
    readonly budgetMs?: number;
  } = {},
) {
  return startExtensionSession({
    files,
    lspSettings: {
      timeouts: { diagnosticsMs: 2_000, initializeMs: 5_000, requestMs: 10_000 },
      servers: options.servers ?? { fake: contentServer() },
    },
    effects: options.budgetMs === undefined ? {} : { dependentScanBudgetMs: options.budgetMs },
  });
}

/** The one-based `line:col-end` range of a marker in `text`, as the fake server reports it. */
function markerRange(text: string, marker: string): string {
  const lines = text.split("\n");
  const line = lines.findIndex((lineText) => lineText.includes(marker));
  const start = (lines[line] ?? "").indexOf(marker);
  return `${line + 1}:${start + 1}-${start + marker.length + 1}`;
}

const warnings = [
  "const a = 1; // diag:warning:w1:old warning one",
  "const b = 2; // diag:warning:w2:old warning two",
  "const c = 3;",
  "",
].join("\n");

describe("Post-edit Diagnostics against the changed file's Pre-edit Baseline", () => {
  test("lists only the finding an edit introduced, and counts the existing ones", async () => {
    const session = await startContentSession({ "src/a.ts": warnings });
    const marker = "diag:warning:w3:new warning";
    const text = await session.edit({
      toolCallId: "edit",
      path: "src/a.ts",
      oldText: "const c = 3;",
      newText: `const c = 3; // ${marker}`,
    });

    const after = warnings.replace("const c = 3;", `const c = 3; // ${marker}`);
    expect(text).toBe(
      [
        "Edited src/a.ts",
        "",
        "LSP diagnostics",
        `src/a.ts:${markerRange(after, marker)} warning [fake] fake(w3): new warning`,
        "src/a.ts: 1 new; unchanged: 2 warnings",
      ].join("\n"),
    );
  }, 30_000);

  test("counts an existing error the edit left alone as unchanged instead of listing it", async () => {
    const session = await startContentSession({
      "src/a.ts": "const a = 1; // diag:error:e1:already broken\nconst b = 2;\n",
    });
    const text = await session.edit({
      toolCallId: "edit",
      path: "src/a.ts",
      oldText: "const b = 2;",
      newText: "const b = 3;",
    });

    expect(text).toBe(
      "Edited src/a.ts\n\nLSP diagnostics: no new diagnostics (unchanged: 1 error)",
    );
  }, 30_000);

  test("does not report an existing finding as new when the edit shifts its line", async () => {
    const session = await startContentSession({ "src/a.ts": warnings });
    const text = await session.edit({
      toolCallId: "edit",
      path: "src/a.ts",
      oldText: "const a = 1;",
      newText: "// a new first line\nconst a = 1;",
    });

    expect(text).toBe(
      "Edited src/a.ts\n\nLSP diagnostics: no new diagnostics (unchanged: 2 warnings)",
    );
  }, 30_000);

  test("matches findings as a multiset: two identical findings becoming three is one new", async () => {
    const duplicate = "run(); // diag:warning:dup:duplicate";
    const before = [duplicate, duplicate, "done();", ""].join("\n");
    const session = await startContentSession({ "src/a.ts": before });
    const text = await session.edit({
      toolCallId: "edit",
      path: "src/a.ts",
      oldText: "done();",
      newText: duplicate,
    });

    const listed = text.split("\n").filter((line) => line.includes("duplicate"));
    expect(listed).toHaveLength(1);
    expect(text).toContain("src/a.ts: 1 new; unchanged: 2 warnings");
  }, 30_000);

  test("lists a finding on a line the edit rewrote as new", async () => {
    const session = await startContentSession({ "src/a.ts": warnings });
    const text = await session.edit({
      toolCallId: "edit",
      path: "src/a.ts",
      oldText: "const a = 1;",
      newText: "const a = 2;",
    });

    expect(text).toContain("warning [fake] fake(w1): old warning one");
    expect(text).toContain("src/a.ts: 1 new; unchanged: 1 warning");
  }, 30_000);

  test("lists every finding of a file a write creates, without a no-baseline note", async () => {
    const session = await startContentSession({ "src/a.ts": "" });
    const text = await session.write({
      toolCallId: "write",
      path: "src/new.ts",
      content: warnings,
    });

    expect(text).toBe(
      [
        "Wrote src/new.ts",
        "",
        "LSP diagnostics",
        "src/new.ts:1:17-48 warning [fake] fake(w1): old warning one",
        "src/new.ts:2:17-48 warning [fake] fake(w2): old warning two",
      ].join("\n"),
    );
  }, 30_000);

  test("compares a write over an existing file against its baseline", async () => {
    const session = await startContentSession({ "src/a.ts": warnings });
    const text = await session.write({
      toolCallId: "write",
      path: "src/a.ts",
      content: `${warnings}const d = 4;\n`,
    });

    expect(text).toBe(
      "Wrote src/a.ts\n\nLSP diagnostics: no new diagnostics (unchanged: 2 warnings)",
    );
  }, 30_000);

  test("lists a server's findings in full, with a note, when its baseline pull ran out of time", async () => {
    const session = await startContentSession(
      { "src/a.ts": warnings },
      {
        servers: {
          fake: contentServer(),
          slow: contentServer({ FAKE_DELAY_FIRST_DIAGNOSTICS: "1" }),
        },
        budgetMs: 1_000,
      },
    );
    const text = await session.edit({
      toolCallId: "edit",
      path: "src/a.ts",
      oldText: "const c = 3;",
      newText: "const c = 4;",
    });

    // `fake` answered in time, so its findings are compared; `slow` has no baseline.
    expect(text).toBe(
      [
        "Edited src/a.ts",
        "",
        "LSP diagnostics",
        "src/a.ts:1:17-48 warning [slow] fake(w1): old warning one",
        "src/a.ts:2:17-48 warning [slow] fake(w2): old warning two",
        "src/a.ts: 2 new; unchanged: 2 warnings",
        "src/a.ts: no pre-edit baseline from slow, so all its findings are listed",
      ].join("\n"),
    );
  }, 30_000);

  test.each(["applyPatch", "applyWorkspaceEdit"] as const)(
    "lists every finding after %s, which takes no baseline",
    async (call) => {
      const session = await startContentSession({ "src/a.ts": warnings });
      const text = await session[call]({
        toolCallId: "apply",
        path: "src/a.ts",
        content: warnings.replace("const c = 3;", "const c = 4;"),
      });

      expect(text).toBe(
        [
          "Wrote src/a.ts",
          "",
          "LSP diagnostics",
          "src/a.ts:1:17-48 warning [fake] fake(w1): old warning one",
          "src/a.ts:2:17-48 warning [fake] fake(w2): old warning two",
        ].join("\n"),
      );
    },
    30_000,
  );

  test("drops unchanged hints uncounted and counts only new hints as omitted", async () => {
    const session = await startContentSession({
      "src/a.ts":
        "const a = 1; // diag:warning:w1:old warning\nconst b = 2; // diag:hint:h1:old hint\nconst c = 3;\n",
    });
    const text = await session.edit({
      toolCallId: "edit",
      path: "src/a.ts",
      oldText: "const c = 3;",
      newText: "const c = 3; // diag:hint:h2:new hint",
    });

    expect(text).toBe(
      "Edited src/a.ts\n\nLSP diagnostics: no new diagnostics (unchanged: 1 warning; 1 hint omitted)",
    );
  }, 30_000);
});
