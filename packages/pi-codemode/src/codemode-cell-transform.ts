import {
  parse,
  type AssignmentPattern,
  type AssignmentProperty,
  type ClassDeclaration,
  type ExpressionStatement,
  type ForInStatement,
  type ForOfStatement,
  type ForStatement,
  type FunctionDeclaration,
  type Node,
  type ObjectPattern,
  type Pattern,
  type Program,
  type RestElement,
  type Statement,
  type VariableDeclaration,
  type VariableDeclarator,
} from "acorn";

/** Successful pure transform output consumed only by the worker-owned Notebook bootstrap. */
export type TransformedCodeModeCell = {
  /** JavaScript body with only generated declaration operations rewritten. */
  readonly source: string;
  /** Placeholder the guest bootstrap replaces with an inaccessible per-Cell identifier. */
  readonly internalIdentifierPlaceholder: string;
};

/** Expected parse or unsupported-syntax failure returned at the Cell boundary. */
export type CodeModeCellTransformError = {
  readonly code: "syntax" | "unsupported-syntax";
  readonly message: string;
};

/** Result of parsing and transforming one Cell without evaluating guest JavaScript. */
export type CodeModeCellTransformResult =
  | { readonly ok: true; readonly cell: TransformedCodeModeCell }
  | { readonly ok: false; readonly error: CodeModeCellTransformError };

type SourceEdit = {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
};

const INTERNAL_IDENTIFIER_PREFIX = "__piCodeModeCellInternal";

/**
 * Guest bootstrap expression that owns stable Notebook Bindings without placing them on
 * `globalThis`; evaluate it once per CodeMode Session to obtain the Cell runner.
 */
export const CODEMODE_NOTEBOOK_BOOTSTRAP_SOURCE = String.raw`(() => {
  const bindings = new Map();
  const createCellFunction = Function;
  const createIdentifierRandom = Math.random.bind(Math);
  const numberToString = Function.call.bind(Number.prototype.toString);
  const replaceAllString = Function.call.bind(String.prototype.replaceAll);
  const sliceString = Function.call.bind(String.prototype.slice);
  const internalCellFunctions = new WeakSet();
  const addInternalCellFunction = Function.call.bind(
    WeakSet.prototype.add,
    internalCellFunctions,
  );
  const hasInternalCellFunction = Function.call.bind(
    WeakSet.prototype.has,
    internalCellFunctions,
  );
  const originalFunctionToString = Function.call.bind(Function.prototype.toString);
  Object.defineProperty(Function.prototype, "toString", {
    configurable: true,
    writable: true,
    value: function codeModeFunctionToString() {
      return hasInternalCellFunction(this)
        ? "async function () { [CodeMode Cell] }"
        : originalFunctionToString(this);
    },
  });
  let activeStage;
  let internalIdentifierSequence = 0;

  const initializationTarget = new Proxy(Object.create(null), {
    set(_target, name, value) {
      if (typeof name !== "string" || activeStage === undefined) {
        throw new Error("Pi CodeMode: declaration initialization outside an active stage");
      }
      const stagedBinding = activeStage.get(name);
      if (stagedBinding === undefined) {
        throw new Error("Pi CodeMode: declaration initialized an unplanned Notebook Binding");
      }
      stagedBinding.initialized = true;
      stagedBinding.value = value;
      return true;
    },
  });

  const declarationHelper = Object.freeze({
    init: initializationTarget,
    async declare(entries, initialize) {
      if (activeStage !== undefined) {
        throw new Error("Pi CodeMode: overlapping declaration stages");
      }
      activeStage = new Map(entries.map(([name, kind]) => {
        const existingBinding = bindings.get(name);
        return [name, {
          initialized: kind === "var",
          kind,
          value: kind === "var" ? existingBinding?.value : undefined,
        }];
      }));
      try {
        await initialize();
        for (const [name, stagedBinding] of activeStage) {
          if (!stagedBinding.initialized) {
            throw new Error("Pi CodeMode: declaration did not initialize its Notebook Binding");
          }
          const binding = bindings.get(name);
          if (binding === undefined) {
            bindings.set(name, {
              kind: stagedBinding.kind,
              value: stagedBinding.value,
            });
          } else {
            binding.kind = stagedBinding.kind;
            binding.value = stagedBinding.value;
          }
        }
      } finally {
        activeStage = undefined;
      }
    },
    hoistVars(names) {
      if (activeStage !== undefined) {
        throw new Error("Pi CodeMode: variable hoisting during an active declaration stage");
      }
      for (const name of names) {
        const binding = bindings.get(name);
        if (binding === undefined) bindings.set(name, { kind: "var", value: undefined });
        else binding.kind = "var";
      }
    },
  });

  return async function runCodeModeCell(source, internalIdentifierPlaceholder) {
    internalIdentifierSequence += 1;
    const randomPart = sliceString(numberToString(createIdentifierRandom(), 36), 2);
    const internalIdentifier = "__piCodeModeRuntime" + internalIdentifierSequence + "_" + randomPart;
    const executableSource = replaceAllString(
      source,
      internalIdentifierPlaceholder,
      internalIdentifier,
    );
    const scope = new Proxy(Object.create(null), {
      has(_target, name) {
        if (name === internalIdentifier || typeof name !== "string") return false;
        return activeStage?.has(name) === true || bindings.has(name);
      },
      get(_target, name) {
        if (name === Symbol.unscopables || typeof name !== "string") return undefined;
        const stagedBinding = activeStage?.get(name);
        if (stagedBinding !== undefined) {
          if (!stagedBinding.initialized) {
            throw new ReferenceError("Cannot access '" + name + "' before initialization");
          }
          return stagedBinding.value;
        }
        return bindings.get(name)?.value;
      },
      set(_target, name, value) {
        if (typeof name !== "string") return false;
        const stagedBinding = activeStage?.get(name);
        if (stagedBinding !== undefined) {
          if (!stagedBinding.initialized) {
            throw new ReferenceError("Cannot access '" + name + "' before initialization");
          }
          stagedBinding.value = value;
          return true;
        }
        const binding = bindings.get(name);
        if (binding === undefined) return false;
        if (binding.kind === "const") {
          throw new TypeError("Assignment to constant Notebook Binding '" + name + "'");
        }
        binding.value = value;
        return true;
      },
    });

    const scopeIdentifier = internalIdentifier + "Scope";
    const createExecutableCell = createCellFunction(
      scopeIdentifier,
      internalIdentifier,
      "with (" + scopeIdentifier + ") { return async function () {\n" + executableSource +
      "\n}; }",
    );
    const executeCell = createExecutableCell(scope, declarationHelper);
    addInternalCellFunction(executeCell);
    return executeCell.call(undefined);
  };
})()`;

function chooseInternalIdentifier(script: string): string {
  let suffix = 0;
  let candidate = INTERNAL_IDENTIFIER_PREFIX;
  while (script.includes(candidate)) {
    suffix += 1;
    candidate = `${INTERNAL_IDENTIFIER_PREFIX}${suffix}`;
  }
  return candidate;
}

function applySourceEdits(script: string, edits: readonly SourceEdit[]): string {
  let transformed = script;
  const descendingEdits = [...edits].sort(
    (left, right) => right.start - left.start || right.end - left.end,
  );
  for (const edit of descendingEdits) {
    transformed = `${transformed.slice(0, edit.start)}${edit.replacement}${transformed.slice(edit.end)}`;
  }
  return transformed;
}

function collectPatternBindingNames(pattern: Pattern, names: string[]): void {
  switch (pattern.type) {
    case "Identifier":
      if (!names.includes(pattern.name)) names.push(pattern.name);
      return;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        if (element !== null) collectPatternBindingNames(element, names);
      }
      return;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        collectPatternBindingNames(
          property.type === "RestElement" ? property.argument : property.value,
          names,
        );
      }
      return;
    case "AssignmentPattern":
      collectPatternBindingNames(pattern.left, names);
      return;
    case "RestElement":
      collectPatternBindingNames(pattern.argument, names);
      return;
    case "MemberExpression":
      throw new Error("Pi CodeMode: parser returned a member expression in a binding pattern");
  }
}

function renderAssignmentProperty(
  property: AssignmentProperty,
  script: string,
  internalIdentifier: string,
): string {
  const key = script.slice(property.key.start, property.key.end);
  const renderedKey = property.computed ? `[${key}]` : key;
  return `${renderedKey}: ${renderPatternAssignmentTarget(property.value, script, internalIdentifier)}`;
}

function renderObjectPattern(
  pattern: ObjectPattern,
  script: string,
  internalIdentifier: string,
): string {
  const properties = pattern.properties.map((property) => {
    if (property.type === "RestElement") {
      return renderPatternAssignmentTarget(property, script, internalIdentifier);
    }
    return renderAssignmentProperty(property, script, internalIdentifier);
  });
  return `{ ${properties.join(", ")} }`;
}

function renderPatternAssignmentTarget(
  pattern: Pattern,
  script: string,
  internalIdentifier: string,
): string {
  switch (pattern.type) {
    case "Identifier":
      return `${internalIdentifier}.init[${JSON.stringify(pattern.name)}]`;
    case "ArrayPattern":
      return `[${pattern.elements
        .map((element) =>
          element === null
            ? ""
            : renderPatternAssignmentTarget(element, script, internalIdentifier),
        )
        .join(", ")}]`;
    case "ObjectPattern":
      return renderObjectPattern(pattern, script, internalIdentifier);
    case "AssignmentPattern": {
      const assignmentPattern: AssignmentPattern = pattern;
      return `${renderPatternAssignmentTarget(assignmentPattern.left, script, internalIdentifier)} = ${script.slice(assignmentPattern.right.start, assignmentPattern.right.end)}`;
    }
    case "RestElement": {
      const restElement: RestElement = pattern;
      return `...${renderPatternAssignmentTarget(restElement.argument, script, internalIdentifier)}`;
    }
    case "MemberExpression":
      return script.slice(pattern.start, pattern.end);
  }
}

function renderVariableDeclarator(
  declarator: VariableDeclarator,
  declaration: VariableDeclaration,
  script: string,
  internalIdentifier: string,
  initializerOverride?: string,
): string {
  if (
    declaration.kind === "var" &&
    (declarator.init === null || declarator.init === undefined) &&
    initializerOverride === undefined
  ) {
    return "void 0";
  }
  const names: string[] = [];
  collectPatternBindingNames(declarator.id, names);
  const entries = names.map(
    (name) => `[${JSON.stringify(name)}, ${JSON.stringify(declaration.kind)}]`,
  );
  const initializer =
    initializerOverride ??
    (declarator.init === null || declarator.init === undefined
      ? "undefined"
      : script.slice(declarator.init.start, declarator.init.end));
  const target = renderPatternAssignmentTarget(declarator.id, script, internalIdentifier);
  return `await ${internalIdentifier}.declare([${entries.join(", ")}], async () => { (${target} = ${initializer}); })`;
}

function renderFunctionDeclaration(
  declaration: FunctionDeclaration,
  script: string,
  internalIdentifier: string,
): string {
  const name = declaration.id.name;
  const anonymousFunction = `${script.slice(declaration.start, declaration.id.start)}${script.slice(declaration.id.end, declaration.end)}`;
  return `await ${internalIdentifier}.declare([[${JSON.stringify(name)}, "function"]], async () => { ${internalIdentifier}.init[${JSON.stringify(name)}] = ${anonymousFunction}; });`;
}

function renderClassDeclaration(
  declaration: ClassDeclaration,
  script: string,
  internalIdentifier: string,
): string {
  const name = declaration.id.name;
  return `await ${internalIdentifier}.declare([[${JSON.stringify(name)}, "class"]], async () => { ${internalIdentifier}.init[${JSON.stringify(name)}] = ${script.slice(declaration.start, declaration.end)}; });`;
}

function addLoopBodyDeclaration(body: Statement, declaration: string, edits: SourceEdit[]): void {
  if (body.type === "BlockStatement") {
    edits.push({ start: body.start + 1, end: body.start + 1, replacement: `\n${declaration};\n` });
    return;
  }
  edits.push({ start: body.start, end: body.start, replacement: `{ ${declaration}; ` });
  edits.push({ start: body.end, end: body.end, replacement: " }" });
}

function transformForIterationDeclaration(
  statement: ForInStatement | ForOfStatement,
  declaration: VariableDeclaration,
  script: string,
  internalIdentifier: string,
  edits: SourceEdit[],
): void {
  const declarator = declaration.declarations[0];
  if (declarator === undefined) {
    throw new Error("Pi CodeMode: parser returned an empty loop variable declaration");
  }
  const iterationIdentifier = `${internalIdentifier}Iteration`;
  edits.push({
    start: declaration.start,
    end: declaration.end,
    replacement: `const ${iterationIdentifier}`,
  });
  addLoopBodyDeclaration(
    statement.body,
    renderVariableDeclarator(
      declarator,
      declaration,
      script,
      internalIdentifier,
      iterationIdentifier,
    ),
    edits,
  );
}

function collectVariableDeclarationBindingNames(
  declaration: VariableDeclaration,
  names: string[],
): void {
  for (const declarator of declaration.declarations) {
    collectPatternBindingNames(declarator.id, names);
  }
}

function collectNestedProgramVarEdits(
  statement: Statement,
  script: string,
  internalIdentifier: string,
  hoistedVarNames: string[],
  edits: SourceEdit[],
): void {
  const collectNested = (nestedStatement: Statement): void =>
    collectNestedProgramVarEdits(
      nestedStatement,
      script,
      internalIdentifier,
      hoistedVarNames,
      edits,
    );

  switch (statement.type) {
    case "VariableDeclaration":
      if (statement.kind === "var") {
        collectVariableDeclarationBindingNames(statement, hoistedVarNames);
        const declarations = statement.declarations.map((declarator) =>
          renderVariableDeclarator(declarator, statement, script, internalIdentifier),
        );
        edits.push({
          start: statement.start,
          end: statement.end,
          replacement: `{ ${declarations.join("; ")}; }`,
        });
      }
      return;
    case "BlockStatement":
      for (const child of statement.body) collectNested(child);
      return;
    case "IfStatement":
      collectNested(statement.consequent);
      if (statement.alternate !== null && statement.alternate !== undefined) {
        collectNested(statement.alternate);
      }
      return;
    case "LabeledStatement":
      collectNested(statement.body);
      return;
    case "SwitchStatement":
      for (const switchCase of statement.cases) {
        for (const child of switchCase.consequent) collectNested(child);
      }
      return;
    case "TryStatement":
      collectNested(statement.block);
      if (statement.handler !== null && statement.handler !== undefined) {
        collectNested(statement.handler.body);
      }
      if (statement.finalizer !== null && statement.finalizer !== undefined) {
        collectNested(statement.finalizer);
      }
      return;
    case "WhileStatement":
    case "DoWhileStatement":
      collectNested(statement.body);
      return;
    case "ForStatement": {
      const forStatement: ForStatement = statement;
      const initializer = forStatement.init;
      if (initializer?.type === "VariableDeclaration" && initializer.kind === "var") {
        collectVariableDeclarationBindingNames(initializer, hoistedVarNames);
        const declarations = initializer.declarations.map((declarator) =>
          renderVariableDeclarator(declarator, initializer, script, internalIdentifier),
        );
        edits.push({
          start: initializer.start,
          end: initializer.end,
          replacement: `(${declarations.join(", ")})`,
        });
      }
      collectNested(forStatement.body);
      return;
    }
    case "ForInStatement":
    case "ForOfStatement": {
      const iterationStatement: ForInStatement | ForOfStatement = statement;
      if (
        iterationStatement.left.type === "VariableDeclaration" &&
        iterationStatement.left.kind === "var"
      ) {
        collectVariableDeclarationBindingNames(iterationStatement.left, hoistedVarNames);
        transformForIterationDeclaration(
          iterationStatement,
          iterationStatement.left,
          script,
          internalIdentifier,
          edits,
        );
      }
      collectNested(iterationStatement.body);
      return;
    }
    case "WithStatement":
    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "ExpressionStatement":
    case "EmptyStatement":
    case "DebuggerStatement":
    case "ReturnStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "ThrowStatement":
      return;
  }
}

function containsDynamicImport(node: Node): boolean {
  if (node.type === "ImportExpression") return true;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const element of value) {
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Acorn nodes cross a generic AST traversal boundary.
        if (typeof element === "object" && element !== null && "type" in element) {
          // SAFETY: Acorn's AST arrays contain Node values where a structural `type` field is present.
          if (containsDynamicImport(element as Node)) return true;
        }
      }
      continue;
    }
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Acorn nodes cross a generic AST traversal boundary.
    if (typeof value === "object" && value !== null && "type" in value) {
      // SAFETY: Acorn's AST object children are Node values where a structural `type` field is present.
      if (containsDynamicImport(value as Node)) return true;
    }
  }
  return false;
}

function parsesAsStaticModule(script: string): boolean {
  try {
    const moduleProgram = parse(script, {
      ecmaVersion: "latest",
      sourceType: "module",
    });
    return moduleProgram.body.some(
      (statement) =>
        statement.type === "ImportDeclaration" ||
        statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportDefaultDeclaration" ||
        statement.type === "ExportAllDeclaration",
    );
  } catch {
    return false;
  }
}

function parseCodeModeProgram(
  script: string,
):
  | { readonly ok: true; readonly program: Program }
  | { readonly ok: false; readonly error: CodeModeCellTransformError } {
  try {
    const program = parse(script, {
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      ecmaVersion: "latest",
      sourceType: "script",
    });
    if (containsDynamicImport(program)) {
      return {
        ok: false,
        error: {
          code: "unsupported-syntax",
          message: "CodeMode Cell dynamic import is not supported",
        },
      };
    }
    return { ok: true, program };
  } catch (cause) {
    if (parsesAsStaticModule(script)) {
      return {
        ok: false,
        error: {
          code: "unsupported-syntax",
          message: "CodeMode Cell imports and exports are not supported",
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "syntax",
        message: cause instanceof Error ? cause.message : "Invalid JavaScript Cell",
      },
    };
  }
}

/** Parses and transforms one Cell into the explicit persistent Notebook Binding dialect. */
export function transformCodeModeCell(script: string): CodeModeCellTransformResult {
  const parsed = parseCodeModeProgram(script);
  if (!parsed.ok) return parsed;

  const internalIdentifier = chooseInternalIdentifier(script);
  const edits: SourceEdit[] = [];
  const finalStatement = parsed.program.body.at(-1);
  if (finalStatement?.type === "ExpressionStatement") {
    const expressionStatement: ExpressionStatement = finalStatement;
    edits.push({
      start: expressionStatement.start,
      end: expressionStatement.end,
      replacement: `return (${script.slice(expressionStatement.expression.start, expressionStatement.expression.end)});`,
    });
  }

  const hoistedVarNames: string[] = [];
  const functionPrologue: string[] = [];
  for (const statement of parsed.program.body) {
    if (statement.type === "VariableDeclaration") {
      if (statement.kind === "var") {
        collectVariableDeclarationBindingNames(statement, hoistedVarNames);
      }
      edits.push({
        start: statement.start,
        end: statement.end,
        replacement: `${statement.declarations
          .map((declarator) =>
            renderVariableDeclarator(declarator, statement, script, internalIdentifier),
          )
          .join(";\n")};`,
      });
      continue;
    }
    if (statement.type === "FunctionDeclaration") {
      functionPrologue.push(renderFunctionDeclaration(statement, script, internalIdentifier));
      edits.push({ start: statement.start, end: statement.end, replacement: "" });
      continue;
    }
    if (statement.type === "ClassDeclaration") {
      edits.push({
        start: statement.start,
        end: statement.end,
        replacement: renderClassDeclaration(statement, script, internalIdentifier),
      });
      continue;
    }
    if (
      statement.type === "ImportDeclaration" ||
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration" ||
      statement.type === "ExportAllDeclaration"
    ) {
      throw new Error("Pi CodeMode: script parser returned a module declaration");
    }
    collectNestedProgramVarEdits(statement, script, internalIdentifier, hoistedVarNames, edits);
  }

  const cellPrologue = [
    ...(hoistedVarNames.length === 0
      ? []
      : [`${internalIdentifier}.hoistVars(${JSON.stringify(hoistedVarNames)});`]),
    ...functionPrologue,
  ];
  if (cellPrologue.length > 0) {
    const directiveEnd = parsed.program.body.findIndex(
      (statement) => statement.type !== "ExpressionStatement" || statement.directive === undefined,
    );
    const insertionIndex =
      directiveEnd === -1 ? parsed.program.end : (parsed.program.body[directiveEnd]?.start ?? 0);
    edits.push({
      start: insertionIndex,
      end: insertionIndex,
      replacement: `${cellPrologue.join("\n")}\n`,
    });
  }

  return {
    ok: true,
    cell: {
      source: applySourceEdits(script, edits),
      internalIdentifierPlaceholder: internalIdentifier,
    },
  };
}
