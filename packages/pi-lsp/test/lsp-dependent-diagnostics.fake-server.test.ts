import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { closeExtensionSessions, startExtensionSession } from "./extension-session.js";
import { MAX_TOUCHED_DECLARATIONS } from "../src/lsp-dependent-diagnostics.js";

const fakeServerPath = fileURLToPath(new URL("fixtures/fake-lsp-server.mjs", import.meta.url));
const requestLog = resolve(tmpdir(), `pi-lsp-dependents-requests-${process.pid}.log`);

afterEach(async () => {
  await closeExtensionSessions();
  await rm(requestLog, { force: true });
});

const declarations = Array.from({ length: 15 }, (_, index) => `export function f${index}() {}`);
const source = declarations.join("\n");

function startFakeSession(
  environment: Record<string, string>,
  effects: { readonly dependentScanBudgetMs?: number } = {},
) {
  return startExtensionSession({
    files: { "src/a.ts": `${source}\n`, "src/b.ts": "import './a.js';\n" },
    lspSettings: {
      timeouts: { diagnosticsMs: 2_000, initializeMs: 5_000, requestMs: 10_000 },
      servers: {
        fake: {
          command: process.execPath,
          args: [fakeServerPath],
          environment: {
            FAKE_REQUEST_LOG: requestLog,
            FAKE_SCAN: "1",
            FAKE_SYMBOLS: "15",
            FAKE_REFERENCE_FILE: "src/b.ts",
            ...environment,
          },
          languages: [{ extensions: [".ts"], languageId: "typescript" }],
        },
      },
    },
    effects,
  });
}

async function requestCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const text = await readFile(requestLog, "utf8").catch(() => "");
  for (const method of text.split("\n").filter((line) => line !== "")) {
    counts.set(method, (counts.get(method) ?? 0) + 1);
  }
  return counts;
}

const wholeFileEdit = {
  toolCallId: "edit",
  path: "src/a.ts",
  oldText: source,
  newText: source.replace("f0", "g0"),
};

describe("dependent-file Post-edit Diagnostics against a fake server", () => {
  test("searches at most 10 touched declarations: one documentSymbol and 10 references", async () => {
    await rm(requestLog, { force: true });
    const session = await startFakeSession({ FAKE_DIAGNOSTICS: "one" });
    const pending = await session.beginEdit(wholeFileEdit);
    const scan = await requestCounts();
    await pending.finish();

    expect(MAX_TOUCHED_DECLARATIONS).toBe(10);
    expect(scan.get("textDocument/documentSymbol")).toBe(1);
    expect(scan.get("textDocument/references")).toBe(MAX_TOUCHED_DECLARATIONS);
  }, 30_000);

  test("sends a push-only server no scan request", async () => {
    await rm(requestLog, { force: true });
    const session = await startFakeSession({ FAKE_NO_PULL: "1", FAKE_PUSH: "none" });
    const text = await session.edit(wholeFileEdit);
    const counts = await requestCounts();

    expect(counts.get("textDocument/references")).toBeUndefined();
    expect(counts.get("textDocument/documentSymbol")).toBeUndefined();
    expect(text).not.toContain("dependent files");
  }, 30_000);

  test("adds no output and asks for no references when the edit touches no declaration", async () => {
    await rm(requestLog, { force: true });
    const session = await startFakeSession({ FAKE_SYMBOLS: "0" });
    const text = await session.edit(wholeFileEdit);
    const counts = await requestCounts();

    expect(text).toBe("Edited src/a.ts\n\nLSP diagnostics: no diagnostics");
    expect(counts.get("textDocument/documentSymbol")).toBe(1);
    expect(counts.get("textDocument/references")).toBeUndefined();
  }, 30_000);

  test("gives up at its budget without delaying the edit past it, and says so in the result", async () => {
    const session = await startFakeSession(
      { FAKE_DELAY_REFERENCES: "1" },
      { dependentScanBudgetMs: 400 },
    );
    const started = Date.now();
    // The server never answers `references`; the budget, not the 10 s request timeout, ends the scan.
    const pending = await session.beginEdit(wholeFileEdit);
    expect(Date.now() - started).toBeLessThan(5_000);
    const text = await pending.finish();

    expect(text).toBe(
      [
        "Edited src/a.ts",
        "",
        "LSP diagnostics: no diagnostics",
        "",
        "LSP diagnostics in dependent files (new errors only)",
        "dependent files not checked: the scan ran out of time",
      ].join("\n"),
    );
  }, 30_000);
});
