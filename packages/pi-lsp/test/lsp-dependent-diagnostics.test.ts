import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
  capDependentFiles,
  errorKey,
  groupErrorKeys,
  MAX_DEPENDENT_FILES,
  MAX_TOUCHED_DECLARATIONS,
  newDependentErrors,
  referencedFilePaths,
  touchedDeclarationPositions,
  touchedLinesOfEdit,
  type DependentBaseline,
} from "../src/lsp-dependent-diagnostics.js";
import {
  appendPostEditDiagnostics,
  formatDependentDiagnostics,
  type PostEditDiagnosticOutcome,
} from "../src/lsp-post-edit-diagnostics.js";

const range = (startLine: number, endLine: number, character = 0) => ({
  start: { line: startLine, character },
  end: { line: endLine, character: character + 1 },
});
const symbol = (
  kind: number,
  startLine: number,
  endLine: number,
  children: readonly unknown[] = [],
) => ({
  name: "s",
  kind,
  range: range(startLine, endLine),
  selectionRange: range(startLine, startLine, 7),
  children,
});
const FUNCTION = 12;
const CLASS = 5;
const METHOD = 6;

test("locates a native edit's lines in the file, and falls back to every line", () => {
  const text = "a\nb\nc\nd\n";
  expect(touchedLinesOfEdit(text, { path: "f", edits: [{ oldText: "b\nc" }] })).toEqual([
    { start: 1, end: 2 },
  ]);
  expect(
    touchedLinesOfEdit(text, { path: "f", edits: [{ oldText: "d" }, { oldText: "a" }] }),
  ).toEqual([
    { start: 3, end: 3 },
    { start: 0, end: 0 },
  ]);
  expect(touchedLinesOfEdit(text, { path: "f", edits: [{ oldText: "missing" }] })).toBe("all");
  expect(touchedLinesOfEdit(text, { path: "f" })).toBe("all");
  expect(touchedLinesOfEdit(text, { path: "f", edits: [] })).toBe("all");
});

test("selects only the declarations an edit reaches, never locals", () => {
  const symbols = [
    symbol(FUNCTION, 0, 4, [symbol(13, 1, 2)]),
    symbol(CLASS, 6, 20, [symbol(METHOD, 7, 10), symbol(METHOD, 11, 15)]),
    symbol(FUNCTION, 22, 25),
  ];
  const lines = (...ranges: Array<[number, number]>) =>
    ranges.map(([start, end]) => ({ start, end }));

  // A function body edit selects the function, not its local.
  expect(touchedDeclarationPositions(symbols, lines([1, 1]))).toEqual([{ line: 0, character: 7 }]);
  // A method edit selects the method alone, not the class around it.
  expect(touchedDeclarationPositions(symbols, lines([12, 12]))).toEqual([
    { line: 11, character: 7 },
  ]);
  // The class header selects the class and no member.
  expect(touchedDeclarationPositions(symbols, lines([6, 6]))).toEqual([{ line: 6, character: 7 }]);
  expect(touchedDeclarationPositions(symbols, lines([30, 31]))).toEqual([]);
  expect(touchedDeclarationPositions(symbols, "all")).toHaveLength(5);
  expect(touchedDeclarationPositions(symbols, "all", 2)).toHaveLength(2);
  expect(touchedDeclarationPositions(null, "all")).toEqual([]);
  expect(touchedDeclarationPositions([{ name: "flat" }], "all")).toEqual([]);
  expect(MAX_TOUCHED_DECLARATIONS).toBe(10);
});

test("reads referencing files from locations, dropping the edited file and node_modules", () => {
  const location = (path: string) => ({ uri: pathToFileURL(path).href, range: range(0, 0) });
  expect(
    referencedFilePaths(
      [
        location("/w/src/a.ts"),
        location("/w/src/a.ts"),
        location("/w/src/edited.ts"),
        location("/w/node_modules/x/index.d.ts"),
        { uri: "untitled:Untitled-1", range: range(0, 0) },
        { nope: true },
      ],
      new Set(["/w/src/edited.ts"]),
    ),
  ).toEqual(["/w/src/a.ts"]);
  expect(referencedFilePaths(null, new Set())).toEqual([]);
});

test("caps dependent files by path and counts the rest", () => {
  const paths = Array.from(
    { length: 25 },
    (_, index) => `/w/${String(24 - index).padStart(2, "0")}.ts`,
  );
  const capped = capDependentFiles(paths);
  expect(capped.files).toHaveLength(MAX_DEPENDENT_FILES);
  expect(capped.files[0]).toBe("/w/00.ts");
  expect(capped.omittedFiles).toBe(5);
  expect(capDependentFiles(["/w/a.ts"])).toEqual({ files: ["/w/a.ts"], omittedFiles: 0 });
});

function dependentDiagnostic(
  path: string,
  line: number,
  message: string,
): PostEditDiagnosticOutcome {
  return {
    kind: "diagnostic",
    diagnostic: {
      serverId: "typescript",
      path,
      line,
      character: 1,
      severity: 1,
      message,
      dependent: true,
    },
  };
}

function diagnostic(
  path: string,
  line: number,
  message: string,
  severity = 1,
): PostEditDiagnosticOutcome {
  return {
    kind: "diagnostic",
    diagnostic: { serverId: "typescript", path, line, character: 1, severity, message },
  };
}

const noTexts = new Map<string, string>();

test("keeps only errors the baseline lacked and counts unchecked files", () => {
  const texts = new Map([["/w/a.ts", "l1\nl2\nbroken line\nl4\nnew line\nl6\n"]]);
  const preExisting = diagnostic("/w/a.ts", 3, "already broken");
  const baseline: DependentBaseline = {
    files: ["/w/a.ts", "/w/b.ts", "/w/c.ts"],
    omittedFiles: 2,
    errorKeys: new Map([
      ["/w/a.ts", new Set(["typescript\u0000already broken\u0000broken line"])],
      ["/w/b.ts", new Set()],
      ["/w/c.ts", new Set()],
    ]),
    scanTimedOut: false,
  };
  const report = newDependentErrors(
    baseline,
    baseline.files,
    [
      preExisting,
      diagnostic("/w/a.ts", 5, "new in a"),
      diagnostic("/w/a.ts", 6, "a warning", 2),
      { kind: "no_diagnostics", path: "/w/b.ts" },
      { kind: "timeout", path: "/w/c.ts", serverId: "typescript" },
    ],
    texts,
  );
  expect(report.outcomes).toEqual([dependentDiagnostic("/w/a.ts", 5, "new in a")]);
  // Two past the cap or without a baseline, plus one whose pull timed out.
  expect(report.omittedFiles).toBe(3);
  expect(report.scanTimedOut).toBe(false);
});

test("does not invent an error when a sibling edit shifts a dependent's existing error", () => {
  // Baseline taken before the batch: the error is on line 1. A sibling edit then added a line
  // above it, so the result pull finds the same error on line 2.
  const before = new Map([["/w/y.ts", "const x: string = 1;\n"]]);
  const after = new Map([["/w/y.ts", "import './z';\nconst x: string = 1;\n"]]);
  const first = diagnostic("/w/y.ts", 1, "Type 'number' is not assignable");
  const baselinePull = groupErrorKeys(["/w/y.ts"], [first], before);
  const baseline: DependentBaseline = {
    files: ["/w/y.ts"],
    omittedFiles: 0,
    errorKeys: baselinePull.keys,
    scanTimedOut: false,
  };
  const shifted = diagnostic("/w/y.ts", 2, "Type 'number' is not assignable");
  expect(newDependentErrors(baseline, ["/w/y.ts"], [shifted], after).outcomes).toEqual([]);
  // The same message on a different line of code is a different error.
  const other = new Map([["/w/y.ts", "const x: string = 1;\nconst y: string = 2;\n"]]);
  expect(
    newDependentErrors(
      baseline,
      ["/w/y.ts"],
      [diagnostic("/w/y.ts", 2, "Type 'number' is not assignable")],
      other,
    ).outcomes,
  ).toHaveLength(1);
});

test("counts an error with a missing severity, normalized to error, as an error", () => {
  expect(errorKey(diagnostic("/w/a.ts", 1, "m", 1), noTexts)).toBeTypeOf("string");
  expect(errorKey(diagnostic("/w/a.ts", 1, "m", 2), noTexts)).toBeUndefined();
});

test("renders new dependent errors and the unchecked count under their own heading", () => {
  const report = (
    outcomes: PostEditDiagnosticOutcome[],
    omittedFiles: number,
    scanTimedOut = false,
  ) => ({
    outcomes,
    omittedFiles,
    scanTimedOut,
  });
  expect(formatDependentDiagnostics(report([], 0), "/w")).toBe("");
  expect(
    formatDependentDiagnostics(
      report([diagnostic("/w/src/b.ts", 8, "second"), diagnostic("/w/src/a.ts", 1, "first")], 1),
      "/w",
    ),
  ).toBe(
    [
      "",
      "",
      "LSP diagnostics in dependent files (new errors only)",
      "src/a.ts:1:1 error [typescript]: first",
      "src/b.ts:8:1 error [typescript]: second",
      "1 dependent file not checked",
    ].join("\n"),
  );
  expect(formatDependentDiagnostics(report([], 4), "/w")).toContain(
    "4 dependent files not checked",
  );
  expect(formatDependentDiagnostics(report([], 0, true), "/w")).toBe(
    "\n\nLSP diagnostics in dependent files (new errors only)\ndependent files not checked: the scan ran out of time",
  );
});

function editEvent(): ToolResultEvent {
  // SAFETY: the fixture is a structurally valid edit result; the union's literal branches need stricter details types.
  return {
    type: "tool_result",
    toolCallId: "call-1",
    toolName: "edit",
    input: { path: "/w/src/edited.ts" },
    details: undefined,
    content: [{ type: "text", text: "Edited" }],
    isError: false,
  } as ToolResultEvent;
}

test("appends the dependent section after the edited file's own diagnostics", async () => {
  const dependent = diagnostic("/w/src/user.ts", 2, "broken use");
  const patch = await appendPostEditDiagnostics(
    editEvent(),
    async () => [{ kind: "no_diagnostics", path: "/w/src/edited.ts" }],
    "/w",
    {
      dependentDiagnostics: async () => ({
        outcomes: [dependent],
        omittedFiles: 0,
        scanTimedOut: false,
      }),
    },
  );
  expect(patch?.content.at(-1)).toEqual({
    type: "text",
    text: [
      "",
      "",
      "LSP diagnostics: no diagnostics",
      "",
      "LSP diagnostics in dependent files (new errors only)",
      "src/user.ts:2:1 error [typescript]: broken use",
    ].join("\n"),
  });
  expect(patch?.outcomes).toContainEqual(dependent);
});

test("adds nothing when the dependent check finds nothing", async () => {
  const clean = [{ kind: "no_diagnostics", path: "/w/src/edited.ts" } as const];
  const withoutOption = await appendPostEditDiagnostics(editEvent(), async () => clean, "/w");
  const withEmptyCheck = await appendPostEditDiagnostics(editEvent(), async () => clean, "/w", {
    dependentDiagnostics: async () => ({ outcomes: [], omittedFiles: 0, scanTimedOut: false }),
  });
  expect(withEmptyCheck).toEqual(withoutOption);
  const withNoCheck = await appendPostEditDiagnostics(editEvent(), async () => clean, "/w", {
    dependentDiagnostics: async () => undefined,
  });
  expect(withNoCheck).toEqual(withoutOption);
});
