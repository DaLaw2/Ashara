/**
 * The joined types of production source, for mirrored-types.ts: a type the checker finds one with
 * what a function of another module returns, written over that function's type, whatever alias of
 * ReturnType or Awaited, `typeof`, namespace or index it is written through. The module that declares
 * the function owns the type of what it returns, and names it for its callers.
 */

import { isBuiltin } from "node:module";
import path from "node:path";
import ts from "typescript";
import type { ModuleProgram } from "../module-program.js";
import type { Violation } from "./lint.js";

export const MIRRORED_TYPES = "mirrored-types";

/** A production module of the tree: its absolute and root-relative paths, and whether it is a package's. */
export interface ProductionModule {
  readonly absolute: string;
  readonly file: string;
  readonly inPackage: boolean;
}

export function lineOf(node: ts.Node): number {
  const source = node.getSourceFile();
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

export function sameType(checker: ts.TypeChecker, a: ts.Type, b: ts.Type): boolean {
  return checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a);
}

/** Whether `declaration` is a global or a Node built-in's: declared in `declare global`, in a script, or in an ambient module a Node built-in names. */
function isGlobalOrBuiltin(declaration: ts.Declaration): boolean {
  for (let node: ts.Node = declaration.parent; !ts.isSourceFile(node); node = node.parent) {
    if (ts.isModuleDeclaration(node) && (ts.isIdentifier(node.name) ? node.name.text === "global" : isBuiltin(node.name.text))) return true;
  }
  return !ts.isExternalModule(declaration.getSourceFile());
}

/** A function of another module a type node names, and the types a join over it can be: what it returns, awaited or not null. */
interface JoinedFunction {
  readonly node: ts.TypeNode;
  readonly declaration: ts.Declaration;
  readonly returns: readonly ts.Type[];
}

function isUntyped(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

/** Whether the checker finds `a` and `b` one type: the same type, or each assignable to the other where neither is `any` or `unknown`. */
function oneType(checker: ts.TypeChecker, a: ts.Type, b: ts.Type): boolean {
  return a === b || (!isUntyped(a) && !isUntyped(b) && sameType(checker, a, b));
}

/**
 * The function of a module other than `source` whose type `node` names, by the checker's type of
 * it, whatever alias, `typeof`, namespace or index it is written through; null when it names none,
 * or a global's or a Node built-in's.
 */
function namedFunction(checker: ts.TypeChecker, node: ts.TypeNode, source: ts.SourceFile): JoinedFunction | null {
  if (!ts.isTypeQueryNode(node) && !ts.isTypeReferenceNode(node) && !ts.isIndexedAccessTypeNode(node)) return null;
  const signatures = checker.getTypeFromTypeNode(node).getCallSignatures();
  const declaration = signatures.at(-1)?.declaration;
  if (declaration === undefined || declaration.getSourceFile() === source || isGlobalOrBuiltin(declaration)) return null;
  const returns = signatures.flatMap((signature) => {
    const returned = checker.getReturnTypeOfSignature(signature);
    const awaited = checker.getAwaitedType(returned);
    return [returned, checker.getNonNullableType(returned), ...(awaited === undefined ? [] : [awaited, checker.getNonNullableType(awaited)])];
  });
  return { node, declaration, returns };
}

/** The members a generic alias written over `returned` may stand for: its properties and its element type, when it is an object. */
function membersOf(checker: ts.TypeChecker, returned: ts.Type): ts.Type[] {
  if ((returned.flags & ts.TypeFlags.Object) === 0) return [];
  const element = checker.getIndexTypeOfType(returned, ts.IndexKind.Number);
  return [...checker.getPropertiesOfType(returned).map((property) => checker.getTypeOfSymbol(property)), ...(element === undefined ? [] : [element])];
}

/**
 * The outermost type node around `fn.node` whose type the checker finds one with what the function
 * returns (awaited or not null): the joined type, whatever alias of ReturnType or Awaited it is
 * written through. The first generic instantiated over the function must itself give what it
 * returns, or for an alias, a member of that; one that gives anything else (its parameters) is no
 * join, and null is returned.
 */
function joinedNode(checker: ts.TypeChecker, fn: JoinedFunction): ts.TypeNode | null {
  let joined: ts.TypeNode | null = null;
  let instantiated = false;
  for (let node: ts.Node = fn.node.parent; ts.isTypeNode(node); node = node.parent) {
    const type = checker.getTypeFromTypeNode(node);
    const isInstance = ts.isTypeReferenceNode(node) && node.typeArguments !== undefined;
    const candidates = isInstance && !instantiated ? [...fn.returns, ...fn.returns.flatMap((returned) => membersOf(checker, returned))] : fn.returns;
    const matches = candidates.some((candidate) => oneType(checker, type, candidate));
    if (isInstance && !instantiated && !matches) return null;
    instantiated ||= isInstance;
    if (matches && instantiated) joined = node;
  }
  return joined;
}

/** How a violation names the function: as a `typeof` query writes it, else by its declared name. */
function functionShown(fn: JoinedFunction, source: ts.SourceFile): string {
  if (ts.isTypeQueryNode(fn.node)) return fn.node.exprName.getText(source);
  const name = ts.getNameOfDeclaration(fn.declaration);
  return name === undefined ? fn.node.getText(source) : name.getText(fn.declaration.getSourceFile());
}

/** The names of the types `module` exports that the checker finds assignable each way to `joined`. */
function namedIn(checker: ts.TypeChecker, module: ts.SourceFile, joined: ts.Type): string[] {
  const moduleSymbol = checker.getSymbolAtLocation(module);
  if (moduleSymbol === undefined) return [];
  return checker
    .getExportsOfModule(moduleSymbol)
    .map((exported) => (exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported))
    .filter((exported) => (exported.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) !== 0)
    .filter((exported) => sameType(checker, checker.getDeclaredTypeOfSymbol(exported), joined))
    .map((exported) => exported.name);
}

/**
 * Every type of production source the checker finds one with what a function of another module
 * returns, written over that function's type, and a scan of no script. MIRRORED_ALLOWED is never
 * consulted here: the module that declares the function can always name what it returns.
 */
export function returnTypeViolations(built: ModuleProgram, modules: readonly ProductionModule[]): Violation[] {
  const checker = built.checker;
  const violations: Violation[] = [];
  for (const module of modules) {
    const source = built.sourceFile(module.absolute);
    if (source === undefined) continue;
    const joins = new Map<ts.TypeNode, JoinedFunction>();
    const visit = (node: ts.Node): void => {
      const fn = ts.isTypeNode(node) ? namedFunction(checker, node, source) : null;
      const joined = fn === null ? null : joinedNode(checker, fn);
      if (fn !== null && joined !== null && !joins.has(joined)) joins.set(joined, fn);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const [node, fn] of joins) {
      const owner = fn.declaration.getSourceFile();
      const named = namedIn(checker, owner, checker.getTypeFromTypeNode(node));
      const fix = named.length > 0 ? `import ${named.join(" or ")}, which it exports for it` : "export a named type for it there and import that";
      const [top, pkg] = module.file.split("/");
      violations.push({
        file: module.file,
        line: lineOf(node),
        fromPkg: top === "packages" && pkg !== undefined ? pkg : "scripts",
        specifier: MIRRORED_TYPES,
        reason: `a type written over what ${functionShown(fn, source)}, declared in ${path.relative(built.root, owner.fileName).split(path.sep).join("/")}, returns; ${fix}`,
      });
    }
  }
  if (!modules.some((module) => !module.inPackage)) {
    violations.push({ file: "scripts", line: 0, fromPkg: "scripts", specifier: MIRRORED_TYPES, reason: "no script to scan; a scan of nothing would pass" });
  }
  return violations;
}
