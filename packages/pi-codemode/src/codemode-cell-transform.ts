import ts from "typescript";

/** Successful pure transform output consumed only by the worker-owned Notebook runtime. */
export type TransformedCodeModeCell = {
  /** TypeScript body with only generated declaration operations rewritten. */
  readonly source: string;
  /** Placeholder the worker replaces with an inaccessible per-Cell helper identifier. */
  readonly internalIdentifierPlaceholder: string;
};

/** Expected parse or unsupported-syntax failure returned at the Cell boundary. */
export type CodeModeCellTransformError = {
  readonly code: "syntax" | "unsupported-syntax";
  readonly message: string;
};

/** Result of parsing and transforming one Cell without evaluating guest TypeScript. */
export type CodeModeCellTransformResult =
  | { readonly ok: true; readonly cell: TransformedCodeModeCell }
  | { readonly ok: false; readonly error: CodeModeCellTransformError };

type SourceEdit = {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
};

type CodeModeVariableKind = "const" | "let" | "var";
type UnsupportedModuleSyntax = "dynamic-import" | "import-meta" | "static-module";
type ParsedTypeScriptSourceFile = ts.SourceFile & {
  readonly parseDiagnostics: readonly ts.DiagnosticWithLocation[];
};

const INTERNAL_IDENTIFIER_PREFIX = "__piCodeModeCellInternal";

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

function nodeSource(node: ts.Node, sourceFile: ts.SourceFile, script: string): string {
  return script.slice(node.getStart(sourceFile), node.end);
}

function collectBindingNames(name: ts.BindingName, names: string[]): void {
  if (ts.isIdentifier(name)) {
    if (!names.includes(name.text)) names.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) collectBindingNames(element.name, names);
  }
}

function renderPropertyName(
  name: ts.PropertyName,
  sourceFile: ts.SourceFile,
  script: string,
): string {
  return ts.isComputedPropertyName(name)
    ? `[${nodeSource(name.expression, sourceFile, script)}]`
    : nodeSource(name, sourceFile, script);
}

function renderBindingElementAssignmentTarget(
  element: ts.BindingElement,
  sourceFile: ts.SourceFile,
  script: string,
  internalIdentifier: string,
  includePropertyName: boolean,
): string {
  const target = renderBindingAssignmentTarget(
    element.name,
    sourceFile,
    script,
    internalIdentifier,
  );
  const initializedTarget =
    element.initializer === undefined
      ? target
      : `${target} = ${nodeSource(element.initializer, sourceFile, script)}`;
  if (element.dotDotDotToken !== undefined) return `...${initializedTarget}`;
  if (!includePropertyName) return initializedTarget;
  const propertyName =
    element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
  return propertyName === undefined
    ? initializedTarget
    : `${renderPropertyName(propertyName, sourceFile, script)}: ${initializedTarget}`;
}

function renderBindingAssignmentTarget(
  name: ts.BindingName,
  sourceFile: ts.SourceFile,
  script: string,
  internalIdentifier: string,
): string {
  if (ts.isIdentifier(name)) {
    return `${internalIdentifier}.init[${JSON.stringify(name.text)}]`;
  }
  if (ts.isArrayBindingPattern(name)) {
    return `[${name.elements
      .map((element) =>
        ts.isOmittedExpression(element)
          ? ""
          : renderBindingElementAssignmentTarget(
              element,
              sourceFile,
              script,
              internalIdentifier,
              false,
            ),
      )
      .join(", ")}]`;
  }
  return `{ ${name.elements
    .map((element) =>
      renderBindingElementAssignmentTarget(element, sourceFile, script, internalIdentifier, true),
    )
    .join(", ")} }`;
}

function variableKind(declarationList: ts.VariableDeclarationList): CodeModeVariableKind {
  if ((declarationList.flags & ts.NodeFlags.Const) !== 0) return "const";
  if ((declarationList.flags & ts.NodeFlags.Let) !== 0) return "let";
  return "var";
}

function hasUsingDeclaration(declarationList: ts.VariableDeclarationList): boolean {
  return (declarationList.flags & ts.NodeFlags.Using) !== 0;
}

function renderVariableDeclaration(
  declaration: ts.VariableDeclaration,
  declarationList: ts.VariableDeclarationList,
  sourceFile: ts.SourceFile,
  script: string,
  internalIdentifier: string,
  initializerOverride?: string,
): string {
  const kind = variableKind(declarationList);
  if (
    kind === "var" &&
    declaration.initializer === undefined &&
    initializerOverride === undefined
  ) {
    return "void 0";
  }
  const names: string[] = [];
  collectBindingNames(declaration.name, names);
  const entries = names.map((name) => `[${JSON.stringify(name)}, ${JSON.stringify(kind)}]`);
  const rawInitializer =
    initializerOverride ??
    (declaration.initializer === undefined
      ? "undefined"
      : nodeSource(declaration.initializer, sourceFile, script));
  const initializer =
    declaration.type === undefined
      ? rawInitializer
      : `(${rawInitializer} as ${nodeSource(declaration.type, sourceFile, script)})`;
  const target = renderBindingAssignmentTarget(
    declaration.name,
    sourceFile,
    script,
    internalIdentifier,
  );
  return `await ${internalIdentifier}.declare([${entries.join(", ")}], async () => { (${target} = ${initializer}); })`;
}

function renderVariableDeclarationList(
  declarationList: ts.VariableDeclarationList,
  sourceFile: ts.SourceFile,
  script: string,
  internalIdentifier: string,
): string[] {
  return declarationList.declarations.map((declaration) =>
    renderVariableDeclaration(declaration, declarationList, sourceFile, script, internalIdentifier),
  );
}

function renderFunctionDeclaration(
  declaration: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  script: string,
  internalIdentifier: string,
): string | undefined {
  if (declaration.name === undefined || declaration.body === undefined) return undefined;
  const name = declaration.name.text;
  const declarationStart = declaration.getStart(sourceFile);
  const anonymousFunction = `${script.slice(declarationStart, declaration.name.getStart(sourceFile))}${script.slice(declaration.name.end, declaration.end)}`;
  return `await ${internalIdentifier}.declare([[${JSON.stringify(name)}, "function"]], async () => { ${internalIdentifier}.init[${JSON.stringify(name)}] = ${anonymousFunction}; });`;
}

function renderClassDeclaration(
  declaration: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  script: string,
  internalIdentifier: string,
): string | undefined {
  if (declaration.name === undefined) return undefined;
  const name = declaration.name.text;
  return `await ${internalIdentifier}.declare([[${JSON.stringify(name)}, "class"]], async () => { ${internalIdentifier}.init[${JSON.stringify(name)}] = ${nodeSource(declaration, sourceFile, script)}; });`;
}

function collectDeclarationListBindingNames(
  declarationList: ts.VariableDeclarationList,
  names: string[],
): void {
  for (const declaration of declarationList.declarations) {
    collectBindingNames(declaration.name, names);
  }
}

function addLoopBodyDeclaration(
  body: ts.Statement,
  declaration: string,
  sourceFile: ts.SourceFile,
  edits: SourceEdit[],
): void {
  if (ts.isBlock(body)) {
    edits.push({
      start: body.getStart(sourceFile) + 1,
      end: body.getStart(sourceFile) + 1,
      replacement: `\n${declaration};\n`,
    });
    return;
  }
  edits.push({
    start: body.getStart(sourceFile),
    end: body.getStart(sourceFile),
    replacement: `{ ${declaration}; `,
  });
  edits.push({ start: body.end, end: body.end, replacement: " }" });
}

function transformForIterationDeclaration(
  statement: ts.ForInStatement | ts.ForOfStatement,
  declarationList: ts.VariableDeclarationList,
  sourceFile: ts.SourceFile,
  script: string,
  internalIdentifier: string,
  edits: SourceEdit[],
): void {
  const declaration = declarationList.declarations[0];
  if (declaration === undefined) {
    throw new Error("Pi CodeMode: TypeScript parser returned an empty loop declaration");
  }
  const iterationIdentifier = `${internalIdentifier}Iteration`;
  edits.push({
    start: declarationList.getStart(sourceFile),
    end: declarationList.end,
    replacement: `const ${iterationIdentifier}`,
  });
  addLoopBodyDeclaration(
    statement.statement,
    renderVariableDeclaration(
      declaration,
      declarationList,
      sourceFile,
      script,
      internalIdentifier,
      iterationIdentifier,
    ),
    sourceFile,
    edits,
  );
}

function collectNestedProgramVarEdits(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
  script: string,
  internalIdentifier: string,
  hoistedVarNames: string[],
  edits: SourceEdit[],
): void {
  const collectNested = (nestedStatement: ts.Statement): void =>
    collectNestedProgramVarEdits(
      nestedStatement,
      sourceFile,
      script,
      internalIdentifier,
      hoistedVarNames,
      edits,
    );

  if (ts.isVariableStatement(statement)) {
    const declarationList = statement.declarationList;
    if (variableKind(declarationList) === "var") {
      collectDeclarationListBindingNames(declarationList, hoistedVarNames);
      const declarations = renderVariableDeclarationList(
        declarationList,
        sourceFile,
        script,
        internalIdentifier,
      );
      edits.push({
        start: statement.getStart(sourceFile),
        end: statement.end,
        replacement: `{ ${declarations.join("; ")}; }`,
      });
    }
    return;
  }
  if (ts.isBlock(statement)) {
    for (const child of statement.statements) collectNested(child);
    return;
  }
  if (ts.isIfStatement(statement)) {
    collectNested(statement.thenStatement);
    if (statement.elseStatement !== undefined) collectNested(statement.elseStatement);
    return;
  }
  if (ts.isLabeledStatement(statement)) {
    collectNested(statement.statement);
    return;
  }
  if (ts.isSwitchStatement(statement)) {
    for (const clause of statement.caseBlock.clauses) {
      for (const child of clause.statements) collectNested(child);
    }
    return;
  }
  if (ts.isTryStatement(statement)) {
    collectNested(statement.tryBlock);
    if (statement.catchClause !== undefined) collectNested(statement.catchClause.block);
    if (statement.finallyBlock !== undefined) collectNested(statement.finallyBlock);
    return;
  }
  if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
    collectNested(statement.statement);
    return;
  }
  if (ts.isForStatement(statement)) {
    const initializer = statement.initializer;
    if (
      initializer !== undefined &&
      ts.isVariableDeclarationList(initializer) &&
      variableKind(initializer) === "var"
    ) {
      collectDeclarationListBindingNames(initializer, hoistedVarNames);
      const declarations = renderVariableDeclarationList(
        initializer,
        sourceFile,
        script,
        internalIdentifier,
      );
      edits.push({
        start: initializer.getStart(sourceFile),
        end: initializer.end,
        replacement: `(${declarations.join(", ")})`,
      });
    }
    collectNested(statement.statement);
    return;
  }
  if (ts.isForInStatement(statement) || ts.isForOfStatement(statement)) {
    const initializer = statement.initializer;
    if (ts.isVariableDeclarationList(initializer) && variableKind(initializer) === "var") {
      collectDeclarationListBindingNames(initializer, hoistedVarNames);
      transformForIterationDeclaration(
        statement,
        initializer,
        sourceFile,
        script,
        internalIdentifier,
        edits,
      );
    }
    collectNested(statement.statement);
  }
  // Functions, classes, modules, and source `with` introduce boundaries whose `var`
  // declarations are deliberately Cell-local rather than Program-scope Notebook Bindings.
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((item) => item.kind === kind) === true
  );
}

function findUnsupportedModuleSyntax(
  sourceFile: ts.SourceFile,
): UnsupportedModuleSyntax | undefined {
  let found: UnsupportedModuleSyntax | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node) ||
      ts.isImportTypeNode(node) ||
      hasModifier(node, ts.SyntaxKind.ExportKeyword) ||
      hasModifier(node, ts.SyntaxKind.DefaultKeyword)
    ) {
      found = "static-module";
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found = "dynamic-import";
      return;
    }
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      found = "import-meta";
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function syntaxErrorFromDiagnostic(
  diagnostic: ts.DiagnosticWithLocation,
): CodeModeCellTransformError {
  return {
    code: "syntax",
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  };
}

function parseCodeModeProgram(
  script: string,
):
  | { readonly ok: true; readonly sourceFile: ts.SourceFile }
  | { readonly ok: false; readonly error: CodeModeCellTransformError } {
  const sourceFile = ts.createSourceFile(
    "codemode-cell.ts",
    script,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  // SAFETY: TypeScript's createSourceFile result owns parseDiagnostics at runtime, but the public SourceFile contract omits this parser-owned field.
  const parsedSourceFile = sourceFile as ParsedTypeScriptSourceFile;
  const diagnostic = parsedSourceFile.parseDiagnostics[0];
  if (diagnostic !== undefined) return { ok: false, error: syntaxErrorFromDiagnostic(diagnostic) };

  const unsupported = findUnsupportedModuleSyntax(sourceFile);
  if (unsupported === "static-module") {
    return {
      ok: false,
      error: {
        code: "unsupported-syntax",
        message: "CodeMode Cell imports and exports are not supported",
      },
    };
  }
  if (unsupported === "dynamic-import") {
    return {
      ok: false,
      error: {
        code: "unsupported-syntax",
        message: "CodeMode Cell dynamic import is not supported",
      },
    };
  }
  if (unsupported === "import-meta") {
    return {
      ok: false,
      error: {
        code: "unsupported-syntax",
        message: "CodeMode Cell import.meta is not supported",
      },
    };
  }
  return { ok: true, sourceFile };
}

function isDirective(statement: ts.Statement): boolean {
  return ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression);
}

function directVariableStatementError(
  statement: ts.VariableStatement,
): CodeModeCellTransformError | undefined {
  if (hasUsingDeclaration(statement.declarationList)) {
    return {
      code: "unsupported-syntax",
      message: "CodeMode Cell top-level using declarations are not supported",
    };
  }
  const kind = variableKind(statement.declarationList);
  if (
    kind === "const" &&
    statement.declarationList.declarations.some(
      (declaration) => declaration.initializer === undefined,
    )
  ) {
    return { code: "syntax", message: "CodeMode Cell const declarations require an initializer" };
  }
  return undefined;
}

/** Parses TypeScript and rewrites one Cell into the explicit persistent Notebook Binding dialect. */
export function transformCodeModeCell(script: string): CodeModeCellTransformResult {
  const parsed = parseCodeModeProgram(script);
  if (!parsed.ok) return parsed;
  const sourceFile = parsed.sourceFile;
  const internalIdentifier = chooseInternalIdentifier(script);
  const edits: SourceEdit[] = [];
  const finalStatement = sourceFile.statements.at(-1);
  if (finalStatement !== undefined && ts.isExpressionStatement(finalStatement)) {
    edits.push({
      start: finalStatement.getStart(sourceFile),
      end: finalStatement.end,
      replacement: `return (${nodeSource(finalStatement.expression, sourceFile, script)});`,
    });
  }

  const hoistedVarNames: string[] = [];
  const functionPrologue: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      const error = directVariableStatementError(statement);
      if (error !== undefined) return { ok: false, error };
      const declarationList = statement.declarationList;
      if (variableKind(declarationList) === "var") {
        collectDeclarationListBindingNames(declarationList, hoistedVarNames);
      }
      edits.push({
        start: statement.getStart(sourceFile),
        end: statement.end,
        replacement: `${renderVariableDeclarationList(
          declarationList,
          sourceFile,
          script,
          internalIdentifier,
        ).join("; ")};`,
      });
      continue;
    }
    if (ts.isFunctionDeclaration(statement)) {
      const declaration = renderFunctionDeclaration(
        statement,
        sourceFile,
        script,
        internalIdentifier,
      );
      if (declaration !== undefined) {
        functionPrologue.push(declaration);
        edits.push({
          start: statement.getStart(sourceFile),
          end: statement.end,
          replacement: "void 0;",
        });
      }
      continue;
    }
    if (ts.isClassDeclaration(statement)) {
      const declaration = renderClassDeclaration(statement, sourceFile, script, internalIdentifier);
      if (declaration !== undefined) {
        edits.push({
          start: statement.getStart(sourceFile),
          end: statement.end,
          replacement: declaration,
        });
      }
      continue;
    }
    collectNestedProgramVarEdits(
      statement,
      sourceFile,
      script,
      internalIdentifier,
      hoistedVarNames,
      edits,
    );
  }

  const prologue: string[] = [];
  if (hoistedVarNames.length > 0) {
    prologue.push(`${internalIdentifier}.hoistVars(${JSON.stringify(hoistedVarNames)});`);
  }
  prologue.push(...functionPrologue);
  if (prologue.length > 0) {
    let insertionPosition = 0;
    for (const statement of sourceFile.statements) {
      if (!isDirective(statement)) break;
      insertionPosition = statement.end;
    }
    edits.push({
      start: insertionPosition,
      end: insertionPosition,
      replacement: `\n${prologue.join("\n")}\n`,
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
