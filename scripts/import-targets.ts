/**
 * The import edges a module's source spells, read from the TypeScript syntax tree rather than its
 * text, so a comment or a string literal that spells an import is not one, and an import written
 * across lines is. An edge is any construct that loads or resolves a module:
 * - import declarations (type-only ones included), export-from declarations, `import x = require(...)`
 *   and type-position `import("...")` types;
 * - `import(...)` calls, `require(...)` calls and `require.resolve(...)`;
 * - the calls of a `createRequire(...)` result: of the name a `const` binds it to, `.resolve` on that
 *   name included, or of the result itself (`createRequire(url)("x")`);
 * - vitest's loaders, which load the module they name: `vi.mock`, `vi.doMock`, `vi.importActual` and
 *   `vi.importMock` (`vitest.` spelled alike), and `import.meta.resolve(...)`.
 * `createRequire` read other than as a callee (aliased, destructured into a name is followed), a
 * `createRequire(...)` result that is neither bound by a `const` nor called, and `require` or a bound
 * result used other than as a callee (assigned, passed, put in an array) load modules this reader
 * cannot see, so reading the file throws ImportReadError. The parser picks the script kind from the file name, so .ts, .mts, .js and .mjs
 * read alike.
 */

import ts from "typescript";

/**
 * What an edge's specifier says about the module it loads: a literal names it whole, a template
 * literal names it up to its first substitution, and anything else names nothing.
 */
export type ImportTarget =
  | { readonly kind: "static"; readonly specifier: string }
  | { readonly kind: "template"; readonly prefix: string }
  | { readonly kind: "computed" };

/** The construct an edge is written as. */
type EdgeForm = "import" | "export" | "import-equals" | "import-type" | "dynamic" | "require" | "loader";

/** One name of a brace clause: the name the target module exports, the name it is bound to here. */
interface ClauseName {
  readonly name: string;
  readonly alias: string;
  /** An inline `type` modifier on the entry. */
  readonly typeOnly: boolean;
  /** The 1-based line the entry is written on. */
  readonly line: number;
}

/**
 * The bindings an edge makes: `none` for a side-effect import and for a call, `names` for a brace
 * list, `whole` for a default, namespace or `export *` clause and an import-equals binding, each of
 * which names no symbol.
 */
type ImportClause = { readonly kind: "none" } | { readonly kind: "names"; readonly names: readonly ClauseName[] } | { readonly kind: "whole" };

export interface ImportEdge {
  readonly target: ImportTarget;
  readonly form: EdgeForm;
  /** The whole statement is erased at runtime: `import type`, `export type` or a type-position `import("...")`. */
  readonly typeOnly: boolean;
  readonly clause: ImportClause;
  /** The names the edge binds in the file: an import's default, namespace and brace names, an import-equals name; none for any other form. */
  readonly locals: readonly string[];
  /** The 1-based line the specifier starts on, or the call's when it has no argument. */
  readonly line: number;
  /** The specifier's offsets in the text, quotes included, or the call's when it has no argument. */
  readonly start: number;
  readonly end: number;
}

/** An `export { ... }` list, with or without a `from` specifier. */
export interface ExportList {
  readonly line: number;
  /** null for a list of the file's own bindings. */
  readonly specifier: string | null;
  readonly typeOnly: boolean;
  readonly names: readonly ClauseName[];
}

class ImportReadError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    readonly reason: string,
  ) {
    super(`import-targets: ${file}:${line}: ${reason}`);
    this.name = "ImportReadError";
  }
}

const LOADER_METHODS = new Set(["mock", "doMock", "importActual", "importMock"]);
const LOADER_OWNERS = new Set(["vi", "vitest"]);
const MODULE_BUILTINS = new Set(["module", "node:module"]);

function targetOf(expression: ts.Expression | undefined): ImportTarget {
  if (expression === undefined) return { kind: "computed" };
  if (ts.isStringLiteralLike(expression)) return { kind: "static", specifier: expression.text };
  if (ts.isTemplateExpression(expression)) return { kind: "template", prefix: expression.head.text };
  return { kind: "computed" };
}

function clauseNames(elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[]): ClauseName[] {
  return elements.map((element) => {
    const source = element.getSourceFile();
    const line = source.getLineAndCharacterOfPosition(element.getStart(source)).line + 1;
    return { name: (element.propertyName ?? element.name).text, alias: element.name.text, typeOnly: element.isTypeOnly, line };
  });
}

function importClauseOf(clause: ts.ImportClause | undefined): ImportClause {
  if (clause === undefined) return { kind: "none" };
  if (clause.name !== undefined || clause.namedBindings === undefined || ts.isNamespaceImport(clause.namedBindings)) return { kind: "whole" };
  return { kind: "names", names: clauseNames(clause.namedBindings.elements) };
}

function exportClauseOf(clause: ts.NamedExportBindings | undefined): ImportClause {
  if (clause === undefined || ts.isNamespaceExport(clause)) return { kind: "whole" };
  return { kind: "names", names: clauseNames(clause.elements) };
}

/**
 * The local names `createRequire` goes by in the file: its own, each alias an import of node:module
 * gives it, and each name a destructuring of a `createRequire` property binds, whatever object it
 * destructures.
 */
function createRequireNames(source: ts.SourceFile): Set<string> {
  const names = new Set(["createRequire"]);
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "createRequire") {
      const declaration = node.parent.parent.parent;
      if (ts.isStringLiteral(declaration.moduleSpecifier) && MODULE_BUILTINS.has(declaration.moduleSpecifier.text)) names.add(node.name.text);
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && ts.isIdentifier(node.name)) {
      const property = node.propertyName ?? node.name;
      if ((ts.isIdentifier(property) || ts.isStringLiteral(property)) && property.text === "createRequire") names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function isCreateRequireCall(node: ts.Node, names: ReadonlySet<string>): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (ts.isIdentifier(callee) && names.has(callee.text)) || (ts.isPropertyAccessExpression(callee) && callee.name.text === "createRequire");
}

/** An identifier that is a reference to a binding, not a property or member name spelled alike. */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || (ts.isExportSpecifier(parent) && parent.parent.parent.moduleSpecifier !== undefined)) return false;
  return !ts.isBindingElement(parent) || parent.name === node;
}

/** An identifier that names the binding its declaration introduces. */
function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent)) &&
    parent.name === node
  );
}

function isCalleeOf(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isCallExpression(parent) && parent.expression === node;
}

/**
 * A use of a require-like value that this reader can follow: a call of it, a call of its `.resolve`,
 * a read of any other property (`require.main`), and `typeof`. Anything else (an assignment, an
 * argument, an array element, an unread `.resolve`) hands the value to code that loads modules this
 * reader cannot see.
 */
function isFollowableRequireUse(node: ts.Identifier): boolean {
  if (isCalleeOf(node)) return true;
  const parent = node.parent;
  if (ts.isTypeOfExpression(parent) || ts.isTypeQueryNode(parent)) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return parent.name.text !== "resolve" || isCalleeOf(parent);
  return false;
}

function isRequireLike(callee: ts.Expression, requires: ReadonlySet<string>, createRequires: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(callee)) return callee.text === "require" || requires.has(callee.text);
  return isCreateRequireCall(callee, createRequires);
}

/** How a call loads a module, or null when it loads none this reader knows of. */
function callForm(call: ts.CallExpression, requires: ReadonlySet<string>, createRequires: ReadonlySet<string>): EdgeForm | null {
  const callee = call.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return "dynamic";
  if (isRequireLike(callee, requires, createRequires)) return "require";
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const method = callee.name.text;
  if (method === "resolve" && isRequireLike(callee.expression, requires, createRequires)) return "require";
  if (method === "resolve" && ts.isMetaProperty(callee.expression) && callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword) return "loader";
  if (LOADER_METHODS.has(method) && ts.isIdentifier(callee.expression) && LOADER_OWNERS.has(callee.expression.text)) return "loader";
  return null;
}

/**
 * The names a `const` binds to a `createRequire(...)` result. Any use of `createRequire` itself other
 * than a call, and any use of a createRequire result, a bound name or `require` that
 * isFollowableRequireUse rejects, throws: the value escapes to code whose loads this reader cannot see.
 */
function requireBindings(source: ts.SourceFile, file: string, createRequires: ReadonlySet<string>): Set<string> {
  const bound = new Set<string>();
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "createRequire" && !isCalleeOf(node)) {
      throw new ImportReadError(file, lineOf(node), "createRequire is read other than as a callee, so the require it makes loads modules this reader cannot see; call createRequire(...) directly");
    }
    if (ts.isIdentifier(node) && createRequires.has(node.text) && isReference(node) && !isDeclarationName(node) && !isCalleeOf(node)) {
      throw new ImportReadError(file, lineOf(node), `"${node.text}" names createRequire and is used other than as a callee, so the require it makes loads modules this reader cannot see; call it directly`);
    }
    if (isCreateRequireCall(node, createRequires)) {
      const parent = node.parent;
      const isResolveOwner = ts.isPropertyAccessExpression(parent) && parent.name.text === "resolve" && isCalleeOf(parent);
      const constBinding = ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name) && (ts.getCombinedNodeFlags(parent) & ts.NodeFlags.Const) !== 0;
      if (constBinding) bound.add(parent.name.text);
      else if (!isCalleeOf(node) && !isResolveOwner) throw new ImportReadError(file, lineOf(node), "a createRequire(...) result that no const binds and nothing calls loads modules no reader can see; bind it with const and call it by that name");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const check = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && (node.text === "require" || bound.has(node.text)) && isReference(node) && !isDeclarationName(node) && !isFollowableRequireUse(node)) {
      const holds = bound.has(node.text) ? "holds a createRequire(...) result" : "is the global require";
      throw new ImportReadError(file, lineOf(node), `"${node.text}" ${holds} and is used other than as a callee, so the modules it loads cannot be read`);
    }
    ts.forEachChild(node, check);
  };
  check(source);
  return bound;
}

function importLocals(clause: ts.ImportClause | undefined): string[] {
  if (clause === undefined) return [];
  const bindings = clause.namedBindings;
  const named = bindings === undefined ? [] : ts.isNamespaceImport(bindings) ? [bindings.name.text] : bindings.elements.map((element) => element.name.text);
  return clause.name === undefined ? named : [clause.name.text, ...named];
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

/** Every import edge of the module at `file` (its name picks the script kind) whose source is `text`. */
export function importEdges(file: string, text: string): ImportEdge[] {
  const source = parse(file, text);
  const createRequires = createRequireNames(source);
  const requires = requireBindings(source, file, createRequires);
  const found: ImportEdge[] = [];
  const add = (spec: ts.Node, target: ImportTarget, form: EdgeForm, typeOnly: boolean, binds: { clause: ImportClause; locals?: readonly string[] }): void => {
    const { clause, locals = [] } = binds;
    const start = spec.getStart(source);
    found.push({ target, form, typeOnly, clause, locals, line: source.getLineAndCharacterOfPosition(start).line + 1, start, end: spec.getEnd() });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier, targetOf(node.moduleSpecifier), "import", node.importClause?.isTypeOnly === true, { clause: importClauseOf(node.importClause), locals: importLocals(node.importClause) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      add(node.moduleSpecifier, targetOf(node.moduleSpecifier), "export", node.isTypeOnly, { clause: exportClauseOf(node.exportClause) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, targetOf(node.moduleReference.expression), "import-equals", node.isTypeOnly, { clause: { kind: "whole" }, locals: [node.name.text] });
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      const literal = ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal) ? argument.literal : undefined;
      add(argument, literal === undefined ? { kind: "computed" } : { kind: "static", specifier: literal.text }, "import-type", true, { clause: { kind: "whole" } });
    } else if (ts.isCallExpression(node)) {
      const form = callForm(node, requires, createRequires);
      if (form !== null) {
        const first = node.arguments.at(0);
        add(first ?? node, targetOf(first), form, false, { clause: { kind: "none" } });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every import edge's target; see importEdges. */
export function importTargets(file: string, text: string): ImportTarget[] {
  return importEdges(file, text).map((edge) => edge.target);
}

/** Every `export { ... }` list of the module at `file`, a re-export's included. */
export function exportLists(file: string, text: string): ExportList[] {
  const source = parse(file, text);
  const lists: ExportList[] = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) continue;
    const specifier = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
    lists.push({ line: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1, specifier, typeOnly: statement.isTypeOnly, names: clauseNames(statement.exportClause.elements) });
  }
  return lists;
}
