import { expect, test } from "vitest";
import type {
  PostEditDiagnosticOutcome,
  PostEditLspDiagnostic,
} from "../src/lsp-post-edit-diagnostics.js";
import {
  compareWithPreEditBaseline,
  findingKey,
  preEditBaselineOf,
} from "../src/lsp-pre-edit-baseline.js";

const path = "/w/a.ts";

function finding(
  line: number,
  message: string,
  overrides: Partial<PostEditLspDiagnostic> = {},
): PostEditDiagnosticOutcome {
  return {
    kind: "diagnostic",
    diagnostic: { serverId: "ts", path, line, character: 1, severity: 2, message, ...overrides },
  };
}

function diagnosticOf(outcome: PostEditDiagnosticOutcome): PostEditLspDiagnostic {
  if (outcome.kind !== "diagnostic") throw new Error("Expected a diagnostic outcome");
  return outcome.diagnostic;
}

test("a finding's identity names its server, severity, code, message, and line text, not its position", () => {
  const texts = new Map([[path, "  let x = 1;  \nlet x = 1;\nlet y = 2;\n"]]);
  const key = (line: number, overrides: Partial<PostEditLspDiagnostic> = {}) =>
    findingKey(diagnosticOf(finding(line, "unused", overrides)), texts);

  // The same trimmed line text at another line and column is the same finding.
  expect(key(2, { character: 5 })).toBe(key(1));
  expect(key(3)).not.toBe(key(1));
  expect(key(1, { serverId: "oxlint" })).not.toBe(key(1));
  expect(key(1, { severity: 1 })).not.toBe(key(1));
  expect(key(1, { code: "no-unused-vars" })).not.toBe(key(1));
  expect(key(1, { message: "other" })).not.toBe(key(1));
});

test("records only the servers that answered, including a clean one", () => {
  const baseline = preEditBaselineOf(
    path,
    [
      finding(1, "unused"),
      { kind: "no_diagnostics", path, serverId: "oxlint" },
      { kind: "timeout", path, serverId: "slow" },
    ],
    "let x = 1;\n",
  );
  expect([...baseline.servers.keys()].toSorted()).toEqual(["oxlint", "ts"]);
  expect(baseline.servers.get("oxlint")?.size).toBe(0);
});

test("compares as a multiset: a third identical finding is the only new one", () => {
  const before = "f();\nf();\ng();\n";
  const after = "f();\nf();\nf();\n";
  const baseline = preEditBaselineOf(path, [finding(1, "dup"), finding(2, "dup")], before);
  const compared = compareWithPreEditBaseline(
    baseline,
    [finding(1, "dup"), finding(2, "dup"), finding(3, "dup")],
    new Map([[path, after]]),
  );
  expect(compared.filter(({ kind }) => kind === "diagnostic")).toHaveLength(1);
  expect(compared.filter(({ kind }) => kind === "unchanged")).toHaveLength(2);
});

test("keeps a server without a baseline listed and notes it once; other files pass through", () => {
  const text = "let x = 1;\n";
  const baseline = preEditBaselineOf(path, [finding(1, "unused")], text);
  const elsewhere = finding(1, "unused", { path: "/w/b.ts" });
  const compared = compareWithPreEditBaseline(
    baseline,
    [
      finding(1, "unused"),
      finding(1, "unused", { serverId: "slow" }),
      finding(1, "again", { serverId: "slow" }),
      elsewhere,
    ],
    new Map([[path, text]]),
  );
  expect(compared).toEqual([
    { kind: "unchanged", path, severity: 2, count: 1 },
    finding(1, "unused", { serverId: "slow" }),
    finding(1, "again", { serverId: "slow" }),
    elsewhere,
    { kind: "no_baseline", path, serverId: "slow" },
  ]);
});
