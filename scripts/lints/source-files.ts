/** Reading the TypeScript source the lints scan: files, globs and import specifiers, line by line. */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Glob matching (package-relative paths; `*` stays within a segment, `**` crosses)
// ---------------------------------------------------------------------------

const REGEXP_SPECIALS = new Set([..."\\^$.|?+()[]{}"]);

function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i++;
      } else {
        pattern += "[^/]*";
      }
    } else if (REGEXP_SPECIALS.has(ch)) {
      pattern += `\\${ch}`;
    } else {
      pattern += ch;
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function matchesAnyGlob(relativePath: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(relativePath));
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

export function collectTsFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        // Tests and declarations are scanned too: a test importing another BC's
        // internals couples the packages exactly as production code would.
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

export interface ImportRef {
  readonly line: number;
  readonly specifier: string;
  /** Target package, or null when a relative specifier resolves outside packages/. */
  readonly pkg: string | null;
}

// `from "@ashara/x"`, side-effect `import "@ashara/x"`, and type-position or
// dynamic `import("@ashara/x")`, each with an optional subpath ("@ashara/x/sub").
export const PACKAGE_IMPORT_RE = /\b(?:from|import)\s*\(?\s*["'](@ashara\/([a-z][a-z0-9-]*)(?:\/[^"']*)?)["']/g;

// Relative specifiers in the same positions: a path that leaves the importing
// package reaches another package's internals without naming it.
export const RELATIVE_IMPORT_RE = /\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']*)["']/g;

export function scanLines(content: string, re: RegExp, onMatch: (line: number, match: RegExpExecArray) => void): void {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(lines[i])) !== null) {
      onMatch(i + 1, match);
    }
  }
}

export function extractAsharaImports(
  content: string,
  filePath: string,
  packagesDir: string,
  fromPkg: string,
): ImportRef[] {
  const refs: ImportRef[] = [];

  scanLines(content, PACKAGE_IMPORT_RE, (line, match) => {
    refs.push({ line, specifier: match[1], pkg: match[2] });
  });

  scanLines(content, RELATIVE_IMPORT_RE, (line, match) => {
    const specifier = match[1];
    const target = path.relative(packagesDir, path.resolve(path.dirname(filePath), specifier));
    const targetPkg = target.split(path.sep)[0];
    if (targetPkg === fromPkg) return;
    const escapes = target === "" || targetPkg === ".." || path.isAbsolute(target);
    refs.push({ line, specifier, pkg: escapes ? null : targetPkg });
  });

  return refs;
}

// ---------------------------------------------------------------------------
// Named imports (named-only files)
// ---------------------------------------------------------------------------

interface NamedImport {
  readonly line: number;
  readonly specifier: string;
  readonly pkg: string;
  /** The imported symbols; null when the clause is a default or namespace import, which names none. */
  readonly names: readonly string[] | null;
}

// A statement whose clause is a brace list, a namespace or a default binding. Anything else that
// carries an `@ashara/` specifier (a side-effect or dynamic import, a clause this does not parse)
// is left unaccounted and reported, never assumed harmless.
const NAMED_STATEMENT_RE =
  /\b(?:import|export)\s+(?:type\s+)?(\{[^}]*\}|\*\s+as\s+[\w$]+|\*|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s*from\s*(["'](@ashara\/([a-z][a-z0-9-]*)(?:\/[^"']*)?)["'])/g;
export const ASHARA_LITERAL_RE = /["'](@ashara\/([a-z][a-z0-9-]*)(?:\/[^"']*)?)["']/g;

export function lineAt(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

function clauseNames(clause: string): string[] | null {
  if (!clause.startsWith("{")) return null;
  return clause
    .slice(1, -1)
    .split(",")
    .map((entry) => entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
    .filter((name) => name !== "");
}

/** The file's `@ashara/` imports by statement, and the line of every `@ashara/` specifier no statement accounts for. */
export function extractNamedImports(content: string): { imports: NamedImport[]; unaccounted: { line: number; specifier: string }[] } {
  const imports: NamedImport[] = [];
  const accounted = new Set<number>();
  for (const match of content.matchAll(NAMED_STATEMENT_RE)) {
    const literalOffset = match.index + match[0].length - match[2].length;
    accounted.add(literalOffset);
    imports.push({ line: lineAt(content, literalOffset), specifier: match[3], pkg: match[4], names: clauseNames(match[1]) });
  }
  const unaccounted: { line: number; specifier: string }[] = [];
  for (const match of content.matchAll(ASHARA_LITERAL_RE)) {
    if (!accounted.has(match.index)) unaccounted.push({ line: lineAt(content, match.index), specifier: match[1] });
  }
  return { imports, unaccounted };
}

// A relative `import type` or `export type` statement: erased at runtime, so it hands no rule over.
// An inline `{ type X }` modifier is not matched, so such an import is followed (fail closed).
const TYPE_ONLY_RELATIVE_RE = /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)\s*from\s*(["']\.{1,2}\/[^"']*["'])/g;
export const RELATIVE_LITERAL_RE = /\b(?:from|import)\s*\(?\s*(["'](\.{1,2}\/[^"']*)["'])/g;

/** Every relative specifier in the file that is not the tail of a type-only statement. */
export function valueRelativeImports(content: string): { line: number; specifier: string }[] {
  const typeOnly = new Set<number>();
  for (const match of content.matchAll(TYPE_ONLY_RELATIVE_RE)) typeOnly.add(match.index + match[0].length - match[1].length);
  const found: { line: number; specifier: string }[] = [];
  for (const match of content.matchAll(RELATIVE_LITERAL_RE)) {
    const offset = match.index + match[0].length - match[1].length;
    if (!typeOnly.has(offset)) found.push({ line: lineAt(content, offset), specifier: match[2] });
  }
  return found;
}

/** The scanned file a relative specifier names, under TypeScript's `.js`-for-`.ts` convention; null when none is. */
export function resolveRelative(fromFile: string, specifier: string, scanned: ReadonlySet<string>): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts")];
  return candidates.find((candidate) => scanned.has(candidate)) ?? null;
}
