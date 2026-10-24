/**
 * What the lints over function-like declarations read: every production file of a package's src/
 * and of scripts/, and the name a declaration is reported and allowlisted by.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { LintContext } from "./lint.js";
import { collectTsFiles } from "./source-files.js";

function nameText(name: ts.PropertyName | ts.BindingName, sf: ts.SourceFile): string {
  return ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : name.getText(sf);
}

/** What an expression is bound to: the variable, property or parameter it initialises; null when it is bound to none. */
function boundName(node: ts.Node, sf: ts.SourceFile): string | null {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isParameter(parent)) {
    return nameText(parent.name, sf);
  }
  return null;
}

/** The class, interface, type alias or object a member belongs to, by name. */
function ownerName(member: ts.Node, sf: ts.SourceFile): string {
  const owner = member.parent;
  if ((ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner)) && owner.name !== undefined) return owner.name.text;
  if (ts.isTypeLiteralNode(owner) && ts.isTypeAliasDeclaration(owner.parent)) return owner.parent.name.text;
  return boundName(owner, sf) ?? "<anonymous>";
}

/** How a function-like node is named in a violation and in an allowlist: `<name>`, `<Owner>.<method>` or `constructor of <Class>`. */
export function functionName(fn: ts.SignatureDeclaration, sf: ts.SourceFile): string {
  if (ts.isConstructorDeclaration(fn)) return `constructor of ${ownerName(fn, sf)}`;
  if (ts.isMethodDeclaration(fn) || ts.isMethodSignature(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) {
    return `${ownerName(fn, sf)}.${nameText(fn.name, sf)}`;
  }
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name !== undefined) return fn.name.text;
  return boundName(fn, sf) ?? `<${ts.SyntaxKind[fn.kind]}>`;
}

/** An allowlist entry of a lint over function-like declarations: the function, and why it may stay as it is. */
export interface AllowedFunction {
  /** Root-relative, `/`-separated. */
  readonly file: string;
  /** The function's name as functionName reports it: `<name>`, `<Owner>.<method>` or `constructor of <Class>`. */
  readonly name: string;
  readonly reason: string;
}

/** Production source: a test or a declaration file is left out. */
function isProduction(relative: string): boolean {
  return !relative.endsWith(".test.ts") && !relative.endsWith(".d.ts");
}

/** Every production file, root-relative, with its text: each package's src/, then scripts/. */
export function productionFiles(context: LintContext): Array<readonly [string, string]> {
  const files: Array<readonly [string, string]> = [];
  for (const pkg of context.packages) {
    for (const [filePath, source] of pkg.contents) {
      const relative = pkg.relativeTo(filePath);
      if (relative.startsWith("src/") && isProduction(relative)) files.push([`packages/${pkg.name}/${relative}`, source]);
    }
  }
  const scriptsDir = path.join(context.root, "scripts");
  if (fs.existsSync(scriptsDir)) {
    for (const filePath of collectTsFiles(scriptsDir)) {
      const relative = path.relative(context.root, filePath).split(path.sep).join("/");
      if (isProduction(relative)) files.push([relative, fs.readFileSync(filePath, "utf-8")]);
    }
  }
  return files;
}
