import { describe, expect, test } from "vitest";
import {
  transformCodeModeCell,
  type TransformedCodeModeCell,
} from "../src/codemode-cell-transform.js";
import type { CodeModeJsonValue } from "../src/codemode-tool-contract.js";

type TestCellResult = CodeModeJsonValue | undefined;
type CodeModeNotebookRunner = (
  source: string,
  internalIdentifier: string,
) => Promise<TestCellResult>;
type TestNotebookBinding = { kind: string; value: unknown };
type TestStagedBinding = TestNotebookBinding & { initialized: boolean };

function createCodeModeNotebookRunner(): CodeModeNotebookRunner {
  const bindings = new Map<string, TestNotebookBinding>();
  let activeStage: Map<string, TestStagedBinding> | undefined;

  function exposeNotebookBinding(name: string): void {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        const staged = activeStage?.get(name);
        if (staged !== undefined) {
          if (!staged.initialized) {
            throw new ReferenceError(`Cannot access '${name}' before initialization`);
          }
          return staged.value;
        }
        const binding = bindings.get(name);
        if (binding === undefined) throw new ReferenceError(`${name} is not defined`);
        return binding.value;
      },
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: This setter is the faithful arbitrary-JavaScript Notebook Binding boundary exercised by the transform tests.
      set(value: unknown) {
        const staged = activeStage?.get(name);
        if (staged !== undefined) {
          if (!staged.initialized) {
            throw new ReferenceError(`Cannot access '${name}' before initialization`);
          }
          staged.value = value;
          return;
        }
        const binding = bindings.get(name);
        if (binding === undefined) throw new ReferenceError(`${name} is not defined`);
        if (binding.kind === "const") {
          throw new TypeError(`Assignment to constant Notebook Binding '${name}'`);
        }
        binding.value = value;
      },
    });
  }

  const initializationTarget = new Proxy(Object.create(null), {
    set(_target, name, value) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: Proxy PropertyKey is the JavaScript boundary; only string Notebook Binding names may enter the staged map.
      if (typeof name !== "string" || activeStage === undefined) return false;
      const staged = activeStage.get(name);
      if (staged === undefined) return false;
      staged.initialized = true;
      staged.value = value;
      return true;
    },
  });
  const declarationHelper = {
    init: initializationTarget,
    async declare(
      entries: readonly (readonly [string, string])[],
      initialize: () => Promise<void>,
    ) {
      const absentNames = entries.map(([name]) => name).filter((name) => !bindings.has(name));
      activeStage = new Map(
        entries.map(([name, kind]) => {
          exposeNotebookBinding(name);
          const existing = bindings.get(name);
          return [
            name,
            {
              initialized: kind === "var",
              kind,
              value: kind === "var" ? existing?.value : undefined,
            },
          ];
        }),
      );
      let committed = false;
      try {
        await initialize();
        for (const [name, staged] of activeStage) {
          if (!staged.initialized) throw new Error("Notebook Binding was not initialized");
          bindings.set(name, { kind: staged.kind, value: staged.value });
        }
        committed = true;
      } finally {
        activeStage = undefined;
        if (!committed) {
          for (const name of absentNames) Reflect.deleteProperty(globalThis, name);
        }
      }
    },
    hoistVars(names: readonly string[]) {
      for (const name of names) {
        const binding = bindings.get(name);
        if (binding === undefined) {
          bindings.set(name, { kind: "var", value: undefined });
          exposeNotebookBinding(name);
        } else binding.kind = "var";
      }
    },
  };

  return async (source, internalIdentifier) => {
    const helperName = `${internalIdentifier}_${Math.random().toString(36).slice(2)}`;
    Object.defineProperty(globalThis, helperName, {
      configurable: true,
      value: declarationHelper,
    });
    const executableSource = source.replaceAll(internalIdentifier, helperName);
    // SAFETY: The transformed source is executed only in this test harness; the returned function has no parameters and always resolves through the async Cell contract.
    // oxlint-disable-next-line typescript/no-implied-eval -- Evaluating transformed Cell source is the behavior under test.
    const executeCell = Function(
      `return async function () {\n${executableSource}\n};`,
    ) as () => () => Promise<TestCellResult>;
    try {
      return await executeCell()();
    } finally {
      Reflect.deleteProperty(globalThis, helperName);
    }
  };
}

function transformCellOrThrow(script: string): TransformedCodeModeCell {
  const result = transformCodeModeCell(script);
  if (!result.ok) {
    throw new Error(`CodeMode Cell transform test: ${result.error.message}`);
  }
  return result.cell;
}

async function runCell(runner: CodeModeNotebookRunner, script: string): Promise<TestCellResult> {
  const cell = transformCellOrThrow(script);
  return runner(cell.source, cell.internalIdentifierPlaceholder);
}

describe("CodeMode Cell transform", () => {
  test("persists a top-level Notebook Binding for a later Cell", async () => {
    const runner = createCodeModeNotebookRunner();

    await expect(runCell(runner, "let answer = 40;")).resolves.toBeUndefined();
    await expect(runCell(runner, "answer += 2; answer")).resolves.toBe(42);
  });

  test("preserves TypeScript for Deno-native transpilation while rewriting declarations", () => {
    const cell = transformCellOrThrow(`
      type Added = { value: number };
      let added: Added = { value: 41 };
      function read<T extends Added>(input: T): number { return input.value; }
      class Box<T> { value?: T }
      read(added) satisfies number
    `);

    expect(cell.source).toContain("type Added = { value: number }");
    expect(cell.source).toContain("as Added");
    expect(cell.source).toContain("function <T extends Added>(input: T): number");
    expect(cell.source).toContain("class Box<T> { value?: T }");
    expect(cell.source).toContain("return (read(added) satisfies number);");
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
    expect(transformCodeModeCell("import.meta.url")).toEqual({
      ok: false,
      error: {
        code: "unsupported-syntax",
        message: "CodeMode Cell import.meta is not supported",
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
          ({
            guessed: eval(\`typeof \${guessed}\`),
            scope: typeof scope,
            declarationHelper: typeof declarationHelper,
          })
        `,
      ),
    ).resolves.toEqual({
      guessed: "undefined",
      scope: "undefined",
      declarationHelper: "undefined",
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

  test("keeps Annex-B block and source-with declarations Cell-local", async () => {
    const runner = createCodeModeNotebookRunner();
    await runCell(runner, "let existing = 1;");

    await runCell(
      runner,
      `
        existing = 2;
        { function annexOnly() { return 1; } }
        with ({}) { var withOnly = 1; }
      `,
    );

    await expect(runCell(runner, "existing")).resolves.toBe(2);
    for (const localName of ["annexOnly", "withOnly"]) {
      await expect(runCell(runner, localName)).rejects.toThrow(`${localName} is not defined`);
    }
  });

  test("supports top-level await, return, final expressions, strict directives, and no result", async () => {
    const runner = createCodeModeNotebookRunner();

    await expect(runCell(runner, "await Promise.resolve(6 * 7)")).resolves.toBe(42);
    await expect(runCell(runner, "return 7;")).resolves.toBe(7);
    await expect(runCell(runner, '1; "final string"')).resolves.toBe("final string");
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

  test("keeps nested lexical declarations local while Notebook Bindings use global lookup", async () => {
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
    ).resolves.toEqual([7, 1, true]);
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
