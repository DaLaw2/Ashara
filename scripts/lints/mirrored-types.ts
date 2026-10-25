/**
 * Every concept production source declares as a type has one declaration, and every other site
 * imports it. Read from the one program over the tree (module-program.ts), by the checker's type
 * identity, never by the text a declaration is written in:
 * - one name: two module-level type declarations (interface or type alias) of packages' production
 *   src/ that share a name;
 * - one type: two module-level type declarations of a package's src/ or of scripts/, tests among
 *   them, in one file or in two, under one name or different names, whose declared types the checker
 *   finds assignable each to the other: object types over one set of at least MIN_MEMBERS property
 *   names, unions of at least MIN_MEMBERS members or with an object member, and generic declarations
 *   of one arity instantiated over one set of fresh type parameters. A copy drifts from its original
 *   as silently under another name as under the same one, and an alias that names another
 *   declaration whole is one;
 * - a joined type (joined-types.ts): a type of production source the checker finds one with what a
 *   function of another module returns, written over that function's type. The violation names the
 *   type that module exports assignable each way to the joined one, or says it exports none.
 *
 * A pair that is two distinct concepts is named in MIRRORED_ALLOWED with its reason; an entry with
 * no reason, or that names no such declarations, fails, so the list cannot outlive the declarations
 * it excuses. The list excuses a shared name and a shared type, never a joined type: the module that
 * declares the function can always name what it returns, so no reason makes the join the right home.
 */

import path from "node:path";
import ts from "typescript";
import { overriddenProgram, type ModuleProgram } from "../module-program.js";
import { MIRRORED_TYPES, lineOf, returnTypeViolations, sameType, type ProductionModule } from "./joined-types.js";
import { contextProgram, type LintContext, type Violation } from "./lint.js";
import { MIRRORED_ALLOWED, type AllowedPair } from "./mirrored-allowed.js";

const MIN_MEMBERS = 3;

/** One module-level type declaration of a scanned module. */
interface TypeDeclaration {
  readonly name: string;
  /** Root-relative, `/`-separated. */
  readonly file: string;
  readonly absolute: string;
  readonly line: number;
  /** A package's src/ rather than scripts/: the one-name rule reads only these. */
  readonly inPackage: boolean;
  /** A test module's: only the one-type rule reads these. */
  readonly test: boolean;
  /** The declared type, how many type parameters it takes, and a key two copies share; null when it is no type a copy is read of. */
  readonly shape: { readonly type: ts.Type; readonly arity: number; readonly key: string } | null;
}

/** A module the lint scans: its absolute and root-relative paths, whether it is a package's, and whether it is a test. */
interface ScannedModule extends ProductionModule {
  readonly test: boolean;
}

/** The modules of a package's src/ and of scripts/, tests among them; declaration files are none. */
function scannedModules(context: LintContext, built: ModuleProgram): ScannedModule[] {
  const modules: ScannedModule[] = [];
  for (const pkg of context.packages) {
    for (const filePath of pkg.contents.keys()) {
      const relative = pkg.relativeTo(filePath);
      if (relative.startsWith("src/") && !relative.endsWith(".d.ts")) modules.push({ absolute: filePath, file: `packages/${pkg.name}/${relative}`, inPackage: true, test: relative.endsWith(".test.ts") });
    }
  }
  const scriptsDir = path.join(context.root, "scripts") + path.sep;
  for (const absolute of built.files) {
    const file = path.relative(context.root, absolute).split(path.sep).join("/");
    if (absolute.startsWith(scriptsDir) && !file.endsWith(".d.ts")) modules.push({ absolute, file, inPackage: false, test: file.endsWith(".test.ts") });
  }
  return modules;
}

function isObjectType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Object) !== 0;
}

/**
 * The declared type of `declaration` and the key two copies of it share: its type parameters' count
 * and, for a union of at least MIN_MEMBERS members or with an object member, its members' count, or,
 * for an object type, its property names, of at least MIN_MEMBERS; null for any other type.
 */
function shapeOf(checker: ts.TypeChecker, declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration): TypeDeclaration["shape"] {
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (symbol === undefined) return null;
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  const arity = declaration.typeParameters === undefined ? 0 : declaration.typeParameters.length;
  if (type.isUnion()) {
    if (type.types.length < MIN_MEMBERS && !type.types.some(isObjectType)) return null;
    return { type, arity, key: `${String(arity)}\0union\0${String(type.types.length)}` };
  }
  if ((type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) === 0 || checker.isArrayLikeType(type)) return null;
  const names = checker.getPropertiesOfType(type).map((property) => property.name);
  if (names.length < MIN_MEMBERS) return null;
  return { type, arity, key: `${String(arity)}\0${names.sort().join("\n")}` };
}

/**
 * Whether a type alias is derived by a type operator from a type declared or inferred elsewhere: an
 * indexed access, a `typeof` query, a generic instantiation (`Parameters<...>`, `Extract<...>`), a
 * conditional or mapped type; not one written as its own structure, nor one that names another
 * declaration whole.
 */
function isDerived(declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration): boolean {
  if (!ts.isTypeAliasDeclaration(declaration)) return false;
  const node = declaration.type;
  if (ts.isTypeReferenceNode(node)) return node.typeArguments !== undefined;
  return ts.isIndexedAccessTypeNode(node) || ts.isTypeQueryNode(node) || ts.isConditionalTypeNode(node) || ts.isMappedTypeNode(node) || (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.KeyOfKeyword);
}

/**
 * The module-level type declarations of `modules`. A test's alias derived by a type operator is none:
 * it is how a test names a type its module under test takes or returns without exporting it, and it
 * is that type by construction; a test's type written as its own structure, or one naming another
 * declaration whole, is read like any other.
 */
function typeDeclarations(built: ModuleProgram, modules: readonly ScannedModule[]): TypeDeclaration[] {
  return modules.flatMap((module) => {
    const source = built.sourceFile(module.absolute);
    if (source === undefined) return [];
    return source.statements
      .filter((statement) => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
      .filter((declaration) => !module.test || !isDerived(declaration))
      .map((declaration) => ({
        name: declaration.name.text,
        file: module.file,
        absolute: module.absolute,
        line: lineOf(declaration),
        inPackage: module.inPackage,
        test: module.test,
        shape: shapeOf(built.checker, declaration),
      }));
  });
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((item, i) => item === right[i]);
}

/** Groups of two or more declarations that share a name. */
function byName(declarations: readonly TypeDeclaration[]): TypeDeclaration[][] {
  const groups = new Map<string, TypeDeclaration[]>();
  for (const declaration of declarations) {
    const known = groups.get(declaration.name);
    if (known === undefined) groups.set(declaration.name, [declaration]);
    else known.push(declaration);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return "objectFlags" in type && typeof type.objectFlags === "number" && (type.objectFlags & ts.ObjectFlags.Reference) !== 0;
}

/** The prefix of the names a probe of two generic declarations writes beside the source. */
const PROBE = "__mirroredTypesProbe";

/**
 * Whether the checker finds each pair of generic declarations one type when both are instantiated
 * over one set of fresh type parameters: a program beside `built` declares, for each pair, a tuple
 * alias over fresh parameters in A's module whose two members are A and B instantiated over them (B
 * exported from its own module under a probe name when it is elsewhere), and compares the two.
 */
function genericPairsAlike(built: ModuleProgram, pairs: readonly (readonly [TypeDeclaration, TypeDeclaration])[]): boolean[] {
  if (pairs.length === 0) return [];
  const appended = new Map<string, string>();
  const append = (file: string, text: string): void => {
    const known = appended.get(file);
    appended.set(file, known === undefined ? text : known + text);
  };
  pairs.forEach(([a, b], i) => {
    const params = Array.from({ length: a.shape === null ? 0 : a.shape.arity }, (_, k) => `P${String(k)}`).join(", ");
    let other = b.name;
    if (b.absolute !== a.absolute) {
      append(b.absolute, `\nexport type { ${b.name} as ${PROBE}${String(i)}B };\n`);
      other = `import(${JSON.stringify(b.absolute.replace(/\.ts$/, ".js"))}).${PROBE}${String(i)}B`;
    }
    append(a.absolute, `\ntype ${PROBE}${String(i)}<${params}> = [${a.name}<${params}>, ${other}<${params}>];\n`);
  });
  const overrides = new Map<string, string>();
  for (const [file, extra] of appended) {
    const source = built.sourceFile(file);
    if (source !== undefined) overrides.set(file, source.text + extra);
  }
  const probe = overriddenProgram(built, overrides);
  const checker = probe.checker;
  return pairs.map(([a], i) => {
    const alias = probe.sourceFile(a.absolute)?.statements.find((statement): statement is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(statement) && statement.name.text === `${PROBE}${String(i)}`);
    const symbol = alias === undefined ? undefined : checker.getSymbolAtLocation(alias.name);
    const tuple = symbol === undefined ? undefined : checker.getDeclaredTypeOfSymbol(symbol);
    if (tuple === undefined || !isTypeReference(tuple)) return false;
    const [left, right] = checker.getTypeArguments(tuple);
    return left !== undefined && right !== undefined && sameType(checker, left, right);
  });
}

/**
 * Groups of two or more declarations whose declared types are one: one key, each assignable to the
 * other (a generic pair instantiated over one set of type parameters), under one name or several. A
 * group of one name all in packages' production source is the one-name rule's already, so it is left
 * to that rule.
 */
function byType(built: ModuleProgram, declarations: readonly TypeDeclaration[]): TypeDeclaration[][] {
  const byKey = new Map<string, TypeDeclaration[]>();
  for (const declaration of declarations) {
    if (declaration.shape === null) continue;
    const known = byKey.get(declaration.shape.key);
    if (known === undefined) byKey.set(declaration.shape.key, [declaration]);
    else known.push(declaration);
  }
  const genericPairs: (readonly [TypeDeclaration, TypeDeclaration])[] = [];
  for (const candidates of byKey.values()) {
    for (const [i, first] of candidates.entries()) {
      if (first.shape !== null && first.shape.arity > 0) for (const other of candidates.slice(i + 1)) genericPairs.push([first, other]);
    }
  }
  const alike = genericPairsAlike(built, genericPairs);
  const genericAlike = (a: TypeDeclaration, b: TypeDeclaration): boolean => genericPairs.some(([x, y], i) => alike[i] === true && ((x === a && y === b) || (x === b && y === a)));
  const same = (a: TypeDeclaration, b: TypeDeclaration): boolean => {
    if (a.shape === null || b.shape === null) return false;
    return a.shape.arity > 0 ? genericAlike(a, b) : sameType(built.checker, a.shape.type, b.shape.type);
  };
  const groups: TypeDeclaration[][] = [];
  for (const candidates of byKey.values()) {
    const left = [...candidates];
    while (left.length > 0) {
      const [first, ...rest] = left;
      const group = [first, ...rest.filter((other) => same(first, other))];
      left.splice(0, left.length, ...rest.filter((other) => !group.includes(other)));
      const oneNameInPackages = new Set(group.map((d) => d.name)).size === 1 && group.every((d) => d.inPackage && !d.test);
      if (group.length > 1 && !oneNameInPackages) groups.push(group);
    }
  }
  return groups;
}

function where(group: readonly TypeDeclaration[]): string {
  return group.map((d) => `${d.name} at ${d.file}:${d.line}`).join(", ");
}

/**
 * The mirrored types of the tree, `allowed` excusing a shared name or type it names with a reason.
 * @testseam mirrored-types.test.ts holds an allowlist entry to the rule without the repository's list
 */
export function mirroredTypes(context: LintContext, allowed: readonly AllowedPair[]): Violation[] {
  const built = contextProgram(context);
  const modules = scannedModules(context, built);
  const declarations = typeDeclarations(built, modules);
  const violations: Violation[] = [];
  if (!declarations.some((d) => d.inPackage && !d.test)) {
    violations.push({ file: "packages", line: 0, fromPkg: "*", specifier: MIRRORED_TYPES, reason: "no production type declaration to scan; a scan of nothing would pass" });
  }
  const used = new Set<AllowedPair>();
  const report = (group: readonly TypeDeclaration[], what: string): void => {
    const names = group.map((d) => d.name);
    const files = group.map((d) => d.file);
    const pair = allowed.find((entry) => entry.reason.trim() !== "" && sameSet(entry.names, names) && sameSet(entry.files, files));
    if (pair !== undefined) {
      used.add(pair);
      return;
    }
    const [first] = group;
    if (first === undefined) return;
    const [, pkg] = first.file.split("/");
    violations.push({
      file: first.file,
      line: first.line,
      fromPkg: first.inPackage && pkg !== undefined ? pkg : "scripts",
      specifier: MIRRORED_TYPES,
      reason: `${what}: ${where(group)}; keep one declaration and import it, or name it in MIRRORED_ALLOWED with why it is a distinct concept`,
    });
  };
  for (const group of byName(declarations.filter((d) => d.inPackage && !d.test))) report(group, "one name declared more than once");
  for (const group of byType(built, declarations)) report(group, new Set(group.map((d) => d.name)).size > 1 ? "one type declared under more than one name" : "one type declared more than once");
  violations.push(...returnTypeViolations(built, modules.filter((module) => !module.test)));
  for (const pair of allowed) {
    if (pair.reason.trim() === "") {
      violations.push({ file: pair.files[0] ?? "packages", line: 0, fromPkg: "*", specifier: MIRRORED_TYPES, reason: `the allowed entry ${pair.names.join(", ")} gives no reason; state why the declarations are distinct concepts` });
    } else if (!used.has(pair)) {
      violations.push({ file: pair.files[0] ?? "packages", line: 0, fromPkg: "*", specifier: MIRRORED_TYPES, reason: `the allowed entry ${pair.names.join(", ")} no longer matches its declarations; remove or correct its entry` });
    }
  }
  return violations;
}

export function run(context: LintContext): Violation[] {
  return mirroredTypes(context, MIRRORED_ALLOWED);
}
