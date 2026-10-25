/**
 * Finds an optional member of a `*Deps`, `*Port` or `*Config` interface that the composition root
 * never supplies (Discipline D: a new optional dependency field is done only when production
 * supplies it). Run by check-boundaries.ts inside `just check`.
 *
 * Declarations: every interface, and every type alias of an object type literal, whose name ends in
 * Deps, Port or Config, in a non-test module of packages/<pkg>/src (packages/integration is test
 * infrastructure and is not scanned). Each `?` member of one is an optional member.
 *
 * Suppliers: the modules the server's main reaches by value imports (packages/server/src/index.ts,
 * which calls composeAshara in compose.ts), test modules excluded. The TypeScript checker ties each
 * supply to the declaration it fills: a property of an object literal, matched through the literal's
 * contextual type (so `new X({ ... })`, a typed `const`, a returned literal and a spread literal all
 * count, and an `Omit<>` or generic instance resolves to its original member), or an assignment
 * `obj.member = value` to a member of that type. An optional member with no supply fails unless
 * OPTIONAL_MEMBER_ALLOWLIST names it with a reason; an allowlist entry that names no unsupplied
 * optional member fails too, so the list holds only live policy defaults.
 *
 * Blind spots, each a defect this check passes:
 * - A supply counts whatever its value: forwarding a value that may itself be undefined, or a
 *   conditionally spread literal, is a supply. The chain is checked only where each link is itself
 *   a Deps, Port or Config member.
 * - Two live paths under different names: a member supplied while a second member doing the same
 *   job is also supplied, or the consumer reads neither, is invisible; so is semantic duplication
 *   of a member by a differently named one.
 * - Deps built where the server's main does not reach (a script, a test helper) are not seen: a
 *   member supplied only there fails, and an interface built only there is judged by the server.
 * - A member typed `T | undefined` without `?`, an optional member of a nested type literal, and
 *   an interface not named Deps, Port or Config are not scanned.
 * - An object literal with no contextual type (built untyped, then passed) supplies nothing, so its
 *   members fail: the check errs toward a false failure, never a false pass.
 */

import path from "node:path";
import ts from "typescript";
import { moduleEdges } from "./import-targets.js";
import type { ModuleProgram } from "./module-program.js";

const DEPENDENCY_NAME_RE = /(?:Deps|Port|Config)$/;

/** An optional member a policy default justifies: omitting it is consent, not missing evidence. */
export interface AllowedOptionalMember {
  /** Repo-relative path of the declaring module. */
  readonly file: string;
  readonly declaration: string;
  readonly member: string;
  readonly reason: string;
}

export const OPTIONAL_MEMBER_ALLOWLIST: readonly AllowedOptionalMember[] = [];

export interface UnsuppliedOptionalMember {
  /** Repo-relative path. */
  readonly file: string;
  readonly line: number;
  readonly declaration: string;
  readonly member: string;
  readonly reason: string;
}

class OptionalDepsScanError extends Error {
  constructor(
    readonly subject: string,
    readonly reason: string,
  ) {
    super(`optional-deps scan: ${subject}: ${reason}`);
    this.name = "OptionalDepsScanError";
  }
}

interface ScanOptions {
  /** The program over the repository (module-program.ts); every module of packages/<pkg>/src it holds is scanned. */
  readonly program: ModuleProgram;
  /** The repository root the program's packages/ is under. */
  readonly root: string;
  /** The supplier entry module, repo-relative. */
  readonly entry: string;
  readonly allowlist: readonly AllowedOptionalMember[];
}

function isTestModule(file: string): boolean {
  return file.endsWith(".test.ts");
}

/**
 * The non-test modules of packages/ that `entry` reaches by value imports the compiler resolves,
 * itself included. A value import of a workspace subpath its package does not export, and a value
 * load whose target is a template or computed, fail the scan: what it would reach cannot be read, and
 * skipping it would pass the members it supplies as unsupplied. A program a module runs loads in a
 * process of its own and supplies nothing to this one.
 */
function reachableModules(built: ModuleProgram, root: string, entry: string): ts.SourceFile[] {
  const packagesDir = path.join(root, "packages") + path.sep;
  const entrySource = built.sourceFile(entry);
  if (entrySource === undefined) throw new OptionalDepsScanError(entry, "the supplier entry module is not in the program");
  const seen = new Map<string, ts.SourceFile>([[entrySource.fileName, entrySource]]);
  const queue = [entrySource];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const edge of moduleEdges(built, next.fileName)) {
      const site = `${path.relative(root, next.fileName)}:${String(edge.line)}`;
      if (!edge.typeOnly && edge.target.kind === "static") {
        const gap = built.workspaceGap(edge.target.specifier);
        if (gap !== null) throw new OptionalDepsScanError(site, `"${edge.target.specifier}" resolves to no module: ${gap}`);
      }
      if (!edge.typeOnly && edge.form !== "program" && edge.target.kind !== "static") {
        const named = edge.target.kind === "template" ? `whose target begins \`${edge.target.prefix}\`` : "whose target is computed";
        throw new OptionalDepsScanError(site, `a value load ${named} may reach any module, so what it supplies cannot be read`);
      }
      const resolved = edge.typeOnly ? null : edge.resolved;
      if (resolved === null || !path.resolve(resolved).startsWith(packagesDir) || isTestModule(resolved)) continue;
      const sourceFile = built.sourceFile(path.resolve(resolved));
      if (sourceFile === undefined || seen.has(sourceFile.fileName)) continue;
      seen.set(sourceFile.fileName, sourceFile);
      queue.push(sourceFile);
    }
  }
  return [...seen.values()];
}

interface OptionalMember {
  readonly file: string;
  readonly line: number;
  readonly declaration: string;
  readonly member: string;
  readonly node: ts.Declaration;
}

function memberName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return null;
}

function optionalMembersOf(sourceFile: ts.SourceFile, root: string): OptionalMember[] {
  const found: OptionalMember[] = [];
  const file = path.relative(root, sourceFile.fileName).split(path.sep).join("/");
  const visit = (node: ts.Node): void => {
    let members: ts.NodeArray<ts.TypeElement> | null = null;
    let declaration = "";
    if (ts.isInterfaceDeclaration(node) && DEPENDENCY_NAME_RE.test(node.name.text)) {
      members = node.members;
      declaration = node.name.text;
    } else if (ts.isTypeAliasDeclaration(node) && DEPENDENCY_NAME_RE.test(node.name.text) && ts.isTypeLiteralNode(node.type)) {
      members = node.type.members;
      declaration = node.name.text;
    }
    // eslint-disable-next-line no-restricted-syntax -- policy default: a node that declares no *Deps type has no member to check
    for (const member of members ?? []) {
      if (!(ts.isPropertySignature(member) || ts.isMethodSignature(member)) || member.questionToken === undefined) continue;
      const name = memberName(member.name);
      if (name === null) continue;
      const line = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1;
      found.push({ file, line, declaration, member: name, node: member });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function constituents(type: ts.Type): ts.Type[] {
  return type.isUnionOrIntersection() ? type.types.flatMap(constituents) : [type];
}

/** Every member declaration the module's object literals and member assignments fill. */
function suppliedDeclarations(sourceFile: ts.SourceFile, checker: ts.TypeChecker, into: Set<ts.Declaration>): void {
  const record = (symbol: ts.Symbol | undefined): void => {
    // eslint-disable-next-line no-restricted-syntax -- policy default: a symbol with no declaration records none
    for (const declaration of symbol?.declarations ?? []) into.add(declaration);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const contextual = checker.getContextualType(node);
      if (contextual !== undefined) {
        for (const property of node.properties) {
          if (property.name === undefined) continue;
          const name = memberName(property.name);
          if (name === null) continue;
          for (const type of constituents(contextual)) record(checker.getPropertyOfType(type, name));
        }
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      record(checker.getSymbolAtLocation(node.left.name));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

export function findUnsuppliedOptionalMembers(options: ScanOptions): UnsuppliedOptionalMember[] {
  const { program: built, root, allowlist } = options;
  const packagesDir = path.join(root, "packages") + path.sep;
  const integrationDir = path.join(root, "packages", "integration") + path.sep;
  const declarationFiles = built.files.filter((file) => {
    const inSrc = file.startsWith(packagesDir) && file.slice(packagesDir.length).split(path.sep)[1] === "src";
    return inSrc && !file.startsWith(integrationDir) && !isTestModule(file) && !file.endsWith(".d.ts");
  });
  const entry = path.join(root, options.entry);
  const checker = built.checker;

  const optional: OptionalMember[] = [];
  for (const file of declarationFiles) {
    const sourceFile = built.sourceFile(file);
    if (sourceFile === undefined) throw new OptionalDepsScanError(file, "the module is not in the program");
    optional.push(...optionalMembersOf(sourceFile, root));
  }

  const supplied = new Set<ts.Declaration>();
  for (const sourceFile of reachableModules(built, root, entry)) suppliedDeclarations(sourceFile, checker, supplied);

  const key = (file: string, declaration: string, member: string): string => `${file}\0${declaration}\0${member}`;
  const allowed = new Map(allowlist.map((a) => [key(a.file, a.declaration, a.member), a]));
  const unsupplied: UnsuppliedOptionalMember[] = [];
  const allowedUsed = new Set<string>();
  for (const member of optional) {
    if (supplied.has(member.node)) continue;
    const k = key(member.file, member.declaration, member.member);
    if (allowed.has(k)) {
      allowedUsed.add(k);
      continue;
    }
    unsupplied.push({
      file: member.file,
      line: member.line,
      declaration: member.declaration,
      member: member.member,
      reason: `optional member no module reached from ${options.entry} supplies; supply it, make it required, delete it, or allowlist a policy default with its reason`,
    });
  }
  for (const entryOfList of allowlist) {
    if (allowedUsed.has(key(entryOfList.file, entryOfList.declaration, entryOfList.member))) continue;
    unsupplied.push({
      file: entryOfList.file,
      line: 0,
      declaration: entryOfList.declaration,
      member: entryOfList.member,
      reason: "allowlisted, but it is no unsupplied optional member; remove the allowlist entry",
    });
  }
  return unsupplied;
}
