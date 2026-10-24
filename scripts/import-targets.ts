/**
 * The import edges a module's source spells, read from the TypeScript syntax tree rather than its
 * text, so a comment or a string literal that spells an import is not one, and an import written
 * across lines is: import declarations (type-only ones included), export-from declarations,
 * `import x = require(...)`, `import(...)` calls and `require(...)` calls. The parser picks the
 * script kind from the file name, so .ts, .mts, .js and .mjs read alike.
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

function targetOf(expression: ts.Expression | undefined): ImportTarget {
  if (expression === undefined) return { kind: "computed" };
  if (ts.isStringLiteralLike(expression)) return { kind: "static", specifier: expression.text };
  if (ts.isTemplateExpression(expression)) return { kind: "template", prefix: expression.head.text };
  return { kind: "computed" };
}

function isLoaderCall(call: ts.CallExpression): boolean {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  return ts.isIdentifier(call.expression) && call.expression.text === "require";
}

/** Every import edge of the module at `file` (its name picks the script kind) whose source is `text`. */
export function importTargets(file: string, text: string): ImportTarget[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const found: ImportTarget[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) found.push(targetOf(node.moduleSpecifier));
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) found.push(targetOf(node.moduleSpecifier));
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) found.push(targetOf(node.moduleReference.expression));
    else if (ts.isCallExpression(node) && isLoaderCall(node)) found.push(targetOf(node.arguments[0]));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
