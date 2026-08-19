/* oxlint-disable anti-slop/no-unknown-returns -- Cell results are intentionally unknown until the worker applies bounded JSON serialization. */
import { describe, expect, test } from "vitest";
import {
  CODEMODE_NOTEBOOK_BOOTSTRAP_SOURCE,
  transformCodeModeCell,
  type TransformedCodeModeCell,
} from "../src/codemode-cell-transform.js";

type CodeModeNotebookRunner = (source: string, internalIdentifier: string) => Promise<unknown>;

function createCodeModeNotebookRunner(): CodeModeNotebookRunner {
  // SAFETY: The bootstrap source is a package-owned constant with a two-string async callable contract, not caller-provided code.
  // oxlint-disable-next-line typescript/no-implied-eval -- The public seam is package-owned guest bootstrap source that must be evaluated like QuickJS evaluates it.
  const createRunner = Function(
    `return (${CODEMODE_NOTEBOOK_BOOTSTRAP_SOURCE});`,
  ) as () => CodeModeNotebookRunner;
  return createRunner();
}

function transformCellOrThrow(script: string): TransformedCodeModeCell {
  const result = transformCodeModeCell(script);
  if (!result.ok) {
    throw new Error(`CodeMode Cell transform test: ${result.error.message}`);
  }
  return result.cell;
}

async function runCell(runner: CodeModeNotebookRunner, script: string): Promise<unknown> {
  const cell = transformCellOrThrow(script);
  return runner(cell.source, cell.internalIdentifierPlaceholder);
}

describe("CodeMode Cell transform", () => {
  test("persists a top-level Notebook Binding for a later Cell", async () => {
    const runner = createCodeModeNotebookRunner();

    await expect(runCell(runner, "let answer = 40;")).resolves.toBeUndefined();
    await expect(runCell(runner, "answer += 2; answer")).resolves.toBe(42);
  });

  test("persists every direct Program declaration form and nested destructuring", async () => {
    const runner = createCodeModeNotebookRunner();

    await runCell(
      runner,
      `
        var hoistedResult = hoisted();
        var first = 1, second = 2;
        const { item: renamed, nested: [third, { value: fourth = 4 }], ...rest } = {
          item: 3,
          nested: [5, {}],
          extra: 6,
        };
        function hoisted() { return 21; }
        function total() { return first + second + renamed + third + fourth + rest.extra; }
        class Box { read() { return total(); } }
      `,
    );

    await expect(runCell(runner, "[hoistedResult, new Box().read()]")).resolves.toEqual([21, 21]);
  });

  test("keeps one live Notebook Binding identity across assignment and redefinition", async () => {
    const runner = createCodeModeNotebookRunner();

    await runCell(runner, "let value = 1; function readValue() { return value; }");
    await runCell(runner, "value = 2;");
    await expect(runCell(runner, "readValue()")).resolves.toBe(2);

    await runCell(runner, "const value = 3;");
    await expect(runCell(runner, "readValue()")).resolves.toBe(3);
    await expect(runCell(runner, "value = 4;")).rejects.toThrow(
      "Assignment to constant Notebook Binding 'value'",
    );

    await runCell(runner, "let value = 5;");
    await expect(runCell(runner, "readValue()")).resolves.toBe(5);
  });

  test("rejects syntax errors, static modules, and dynamic import as transform values", () => {
    expect(transformCodeModeCell("let = ;")).toMatchObject({
      ok: false,
      error: { code: "syntax" },
    });
    expect(transformCodeModeCell('import value from "package";')).toEqual({
      ok: false,
      error: {
        code: "unsupported-syntax",
        message: "CodeMode Cell imports and exports are not supported",
      },
    });
    expect(transformCodeModeCell("export const value = 1;")).toMatchObject({
      ok: false,
      error: { code: "unsupported-syntax" },
    });
    expect(transformCodeModeCell('const load = () => import("package");')).toEqual({
      ok: false,
      error: {
        code: "unsupported-syntax",
        message: "CodeMode Cell dynamic import is not supported",
      },
    });
  });

  test("keeps every bootstrap capability unreachable from guest lexical lookup", async () => {
    const runner = createCodeModeNotebookRunner();

    await expect(
      runCell(
        runner,
        `
          const guessed = "__piCodeModeCell" + "Internal";
          function currentCellFunction() { return currentCellFunction.caller; }
          ({
            guessed: eval(\`typeof \${guessed}\`),
            scope: typeof scope,
            declarationHelper: typeof declarationHelper,
            source: Function.prototype.toString.call(currentCellFunction()),
          })
        `,
      ),
    ).resolves.toEqual({
      guessed: "undefined",
      scope: "undefined",
      declarationHelper: "undefined",
      source: "async function () { [CodeMode Cell] }",
    });

    await expect(
      runCell(
        runner,
        `
          declarationHelper.declare([["injected", "let"]], async () => {
            declarationHelper.init.injected = 1;
          })
        `,
      ),
    ).rejects.toThrow("declarationHelper is not defined");
    await expect(runCell(runner, "injected")).rejects.toThrow("injected is not defined");
  });

  test("keeps dynamic, Annex-B block, and source-with declarations Cell-local", async () => {
    const runner = createCodeModeNotebookRunner();
    await runCell(runner, "let existing = 1;");

    await runCell(
      runner,
      `
        eval("var evalOnly = 1; existing = 2;");
        Function("var functionOnly = 1;")();
        { function annexOnly() { return 1; } }
        with ({}) { var withOnly = 1; }
      `,
    );

    await expect(runCell(runner, "existing")).resolves.toBe(2);
    for (const localName of ["evalOnly", "functionOnly", "annexOnly", "withOnly"]) {
      await expect(runCell(runner, localName)).rejects.toThrow(`${localName} is not defined`);
    }
  });

  test("supports top-level await, return, final expressions, strict directives, and no result", async () => {
    const runner = createCodeModeNotebookRunner();

    await expect(runCell(runner, "await Promise.resolve(6 * 7)")).resolves.toBe(42);
    await expect(runCell(runner, "return 7;")).resolves.toBe(7);
    await expect(runCell(runner, '"use strict"; const strictValue = 8; strictValue')).resolves.toBe(
      8,
    );
    await expect(runCell(runner, "if (true) {}")).resolves.toBeUndefined();
  });

  test("hoists Program-var declarations through control flow except under source with", async () => {
    const runner = createCodeModeNotebookRunner();

    await runCell(runner, "let preserved = 7;");
    await expect(
      runCell(
        runner,
        `
          if (false) { var skippedIf = 1; var preserved = 8; }
          while (false) { var skippedWhile = 2; }
          for (var skippedFor of []) {}
          try {} finally { if (false) var skippedTry = 3; }
          switch (0) { case 1: var skippedSwitch = 4; }
          [skippedIf, skippedWhile, skippedFor, skippedTry, skippedSwitch, preserved]
        `,
      ),
    ).resolves.toEqual([undefined, undefined, undefined, undefined, undefined, 7]);
    await expect(
      runCell(
        runner,
        "[skippedIf, skippedWhile, skippedFor, skippedTry, skippedSwitch, preserved]",
      ),
    ).resolves.toEqual([undefined, undefined, undefined, undefined, undefined, 7]);
    await runCell(runner, "var preserved;");
    await expect(
      runCell(runner, "if (true) var preserved = preserved + 1; preserved"),
    ).resolves.toBe(8);

    await runCell(runner, "const formerlyConst = 1;");
    await runCell(runner, "var formerlyConst;");
    await expect(runCell(runner, "formerlyConst = 2; formerlyConst")).resolves.toBe(2);

    await expect(
      runCell(
        runner,
        `
          if (true) {
            var preserved = (() => { throw new Error("var initializer failed"); })();
          }
        `,
      ),
    ).rejects.toThrow("var initializer failed");
    await expect(runCell(runner, "preserved")).resolves.toBe(8);

    await runCell(
      runner,
      `
        if (true) var conditional = 1;
        { var blocked = 2; }
        for (var index = 0; index < 2; index += 1) {}
        for (var item of [3, 4]) {}
        for (var key in { field: true }) {}
        with ({}) { var hiddenByWith = 5; }
      `,
    );

    await expect(runCell(runner, "[conditional, blocked, index, item, key]")).resolves.toEqual([
      1,
      2,
      2,
      4,
      "field",
    ]);
    await expect(runCell(runner, "hiddenByWith")).rejects.toThrow("hiddenByWith is not defined");
  });

  test("keeps nested lexical declarations local and does not store bindings on globalThis", async () => {
    const runner = createCodeModeNotebookRunner();

    await runCell(
      runner,
      `
        let shared = 1;
        function readLocal(input) {
          let shared = input;
          return shared;
        }
      `,
    );

    await expect(
      runCell(runner, '[readLocal(7), shared, Object.hasOwn(globalThis, "shared")]'),
    ).resolves.toEqual([7, 1, false]);
    await expect(runCell(runner, "const sameCell = 1; sameCell = 2;")).rejects.toThrow(
      "Assignment to constant Notebook Binding 'sameCell'",
    );
  });

  test("retains completed mutations and declarations when a later statement throws", async () => {
    const runner = createCodeModeNotebookRunner();
    await runCell(runner, "let mutated = 1;");

    await expect(
      runCell(runner, 'mutated = 2; let committed = 3; throw new Error("later failure");'),
    ).rejects.toThrow("later failure");
    await expect(runCell(runner, "[mutated, committed]")).resolves.toEqual([2, 3]);
  });

  test("commits each completed declarator but rolls back one failed destructuring initializer", async () => {
    const runner = createCodeModeNotebookRunner();
    await runCell(runner, "let first = 1, second = 2;");

    await expect(
      runCell(runner, 'let first = 3, second = (() => { throw new Error("second failed"); })();'),
    ).rejects.toThrow("second failed");
    await expect(runCell(runner, "[first, second]")).resolves.toEqual([3, 2]);

    await expect(
      runCell(
        runner,
        'let [first, second = (() => { throw new Error("pattern failed"); })()] = [4, undefined];',
      ),
    ).rejects.toThrow("pattern failed");
    await expect(runCell(runner, "[first, second]")).resolves.toEqual([3, 2]);

    await expect(runCell(runner, "let first = first;")).rejects.toThrow(
      "Cannot access 'first' before initialization",
    );
    await expect(runCell(runner, "first")).resolves.toBe(3);
  });
});
