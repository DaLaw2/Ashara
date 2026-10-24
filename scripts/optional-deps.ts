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

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { z } from "zod";
import { JsonParseFailed, parseJson } from "@ashara/shared";
import { importEdges } from "./import-targets.js";

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

const PackageJsonSchema = z.object({
  exports: z.record(z.string(), z.string()),
});

interface ScanOptions {
  /** The repository root: packages/<pkg>/src and tsconfig.json are read under it. */
  readonly root: string;
  /** The supplier entry module, repo-relative. */
  readonly entry: string;
  readonly allowlist: readonly AllowedOptionalMember[];
}

function isTestModule(file: string): boolean {
  return file.endsWith(".test.ts");
}

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") results.push(...collectSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !isTestModule(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

/** Workspace packages resolve to this checkout's sources by their package.json exports, never to a linked copy elsewhere. */
function workspaceResolver(packagesDir: string): (specifier: string) => string | null {
  const exportsByPackage = new Map<string, Record<string, string>>();
  return (specifier) => {
    const match = /^@ashara\/([a-z][a-z0-9-]*)(\/.*)?$/.exec(specifier);
    if (match === null) return null;
    const [, pkg, subpath] = match;
    let exportsMap = exportsByPackage.get(pkg);
    if (exportsMap === undefined) {
      const manifestPath = path.join(packagesDir, pkg, "package.json");
      if (!fs.existsSync(manifestPath)) throw new OptionalDepsScanError(specifier, `${manifestPath} does not exist`);
      try {
        exportsMap = parseJson(PackageJsonSchema, fs.readFileSync(manifestPath, "utf-8"), manifestPath).exports;
      } catch (err) {
        if (!(err instanceof JsonParseFailed)) throw err;
        throw new OptionalDepsScanError(manifestPath, `exports is not a map of subpath to file: ${err.message}`);
      }
      exportsByPackage.set(pkg, exportsMap);
    }
    const target = exportsMap[subpath === undefined ? "." : `.${subpath}`];
    if (target === undefined) throw new OptionalDepsScanError(specifier, `packages/${pkg}/package.json exports no such subpath`);
    return path.join(packagesDir, pkg, target);
  };
}

function compilerOptionsOf(root: string): ts.CompilerOptions {
  const tsconfigPath = path.join(root, "tsconfig.json");
  const read = ts.readConfigFile(tsconfigPath, (p) => ts.sys.readFile(p));
  if (read.error !== undefined) {
    throw new OptionalDepsScanError(tsconfigPath, ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, { noEmit: true }, tsconfigPath);
  if (parsed.errors.length > 0) {
    throw new OptionalDepsScanError(tsconfigPath, parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("; "));
  }
  return { ...parsed.options, noEmit: true, declaration: false, declarationMap: false, sourceMap: false };
}

function createProgram(root: string, rootNames: readonly string[]): ts.Program {
  const options = compilerOptionsOf(root);
  const host = ts.createCompilerHost(options);
  const resolveWorkspace = workspaceResolver(path.join(root, "packages"));
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map((literal) => {
      const workspaceFile = resolveWorkspace(literal.text);
      if (workspaceFile !== null) {
        return { resolvedModule: { resolvedFileName: workspaceFile, extension: ts.Extension.Ts, isExternalLibraryImport: false } };
      }
      return ts.resolveModuleName(literal.text, containingFile, options, host);
    });
  return ts.createProgram({ rootNames, options, host });
}

/**
 * Value-import specifiers of a module, read by import-targets.ts: type-only imports and exports carry
 * no supplier at run time.
 */
function valueImportSpecifiers(sourceFile: ts.SourceFile): string[] {
  return importEdges(sourceFile.fileName, sourceFile.text).flatMap((edge) => (edge.typeOnly || edge.target.kind !== "static" ? [] : [edge.target.specifier]));
}

/** The non-test modules of packages/ that `entry` reaches by value imports, itself included. */
function reachableModules(program: ts.Program, root: string, entry: string): ts.SourceFile[] {
  const packagesDir = path.join(root, "packages") + path.sep;
  const options = program.getCompilerOptions();
  const host = ts.createCompilerHost(options);
  const resolveWorkspace = workspaceResolver(path.join(root, "packages"));
  const entrySource = program.getSourceFile(entry);
  if (entrySource === undefined) throw new OptionalDepsScanError(entry, "the supplier entry module is not in the program");
  const seen = new Map<string, ts.SourceFile>([[entrySource.fileName, entrySource]]);
  const queue = [entrySource];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const specifier of valueImportSpecifiers(next)) {
      const resolved = resolveWorkspace(specifier) ?? ts.resolveModuleName(specifier, next.fileName, options, host).resolvedModule?.resolvedFileName;
      if (resolved === undefined || !path.resolve(resolved).startsWith(packagesDir) || isTestModule(resolved)) continue;
      const sourceFile = program.getSourceFile(resolved);
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
  const { root, allowlist } = options;
  const packagesDir = path.join(root, "packages");
  const declarationFiles = fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "integration" && fs.existsSync(path.join(packagesDir, d.name, "src")))
    .flatMap((d) => collectSourceFiles(path.join(packagesDir, d.name, "src")));
  const entry = path.join(root, options.entry);
  if (!fs.existsSync(entry)) throw new OptionalDepsScanError(options.entry, "the supplier entry module does not exist");

  const program = createProgram(root, [...new Set([entry, ...declarationFiles])]);
  const checker = program.getTypeChecker();

  const optional: OptionalMember[] = [];
  for (const file of declarationFiles) {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) throw new OptionalDepsScanError(file, "the module is not in the program");
    optional.push(...optionalMembersOf(sourceFile, root));
  }

  const supplied = new Set<ts.Declaration>();
  for (const sourceFile of reachableModules(program, root, entry)) suppliedDeclarations(sourceFile, checker, supplied);

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
