/** Reading the TypeScript source the lints scan: files, globs, and import edges from each file's syntax tree. */

import fs from "node:fs";
import path from "node:path";
import { importEdges, type ImportEdge, type ImportTarget } from "../import-targets.js";

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
// Import extraction: every edge is read from the file's syntax tree (import-targets.ts), never
// from its text, so a comment or a string that spells an import is none.
// ---------------------------------------------------------------------------

export interface ImportRef {
  readonly line: number;
  readonly specifier: string;
  /** Target package, or null when a relative specifier resolves outside packages/. */
  readonly pkg: string | null;
}

const ASHARA_SCOPE = "@ashara/";

/** The package an `@ashara/<pkg>[/<sub>]` specifier names; null for any other specifier. */
export function asharaPackageOf(specifier: string): string | null {
  if (!specifier.startsWith(ASHARA_SCOPE)) return null;
  const pkg = specifier.slice(ASHARA_SCOPE.length).split("/")[0];
  return /^[a-z][a-z0-9-]*$/.test(pkg) ? pkg : null;
}

export function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/** An edge of a file whose specifier is a literal, spelled whole. */
interface StaticEdge {
  readonly line: number;
  readonly specifier: string;
  readonly edge: ImportEdge;
}

/** Every edge of the file whose specifier is a literal. */
export function staticEdges(filePath: string, content: string): StaticEdge[] {
  return importEdges(filePath, content).flatMap((edge) => (edge.target.kind === "static" ? [{ line: edge.line, specifier: edge.target.specifier, edge }] : []));
}

/** The specifier a report shows for an edge: its literal, its template prefix, or that it is computed. */
export function shownTarget(target: ImportTarget): string {
  if (target.kind === "static") return target.specifier;
  return target.kind === "template" ? `\`${target.prefix}\${...}\`` : "<computed specifier>";
}

/** Whether an edge's loads may hand the module a binding: every edge but a program run, whose loads are in a process of its own. */
export function bindsInModule(edge: ImportEdge): boolean {
  return edge.form !== "program";
}

/**
 * Whether an edge may load `@ashara/<entry>` (any `@ashara/` module when `entry` is undefined): a
 * literal names one module, a template prefix every module it begins, and a computed target any.
 */
export function mayNameAshara(target: ImportTarget, entry?: string): boolean {
  if (target.kind === "computed") return true;
  const whole = entry === undefined ? ASHARA_SCOPE : `${ASHARA_SCOPE}${entry}`;
  if (target.kind === "template") return whole.startsWith(target.prefix) || target.prefix.startsWith(entry === undefined ? whole : `${whole}/`);
  return entry === undefined ? asharaPackageOf(target.specifier) !== null : target.specifier === whole;
}

/** Whether an edge may load package `@ashara/<pkg>`, its root entry or any subpath of it. */
export function mayLoadAsharaPackage(target: ImportTarget, pkg: string): boolean {
  return target.kind === "static" ? asharaPackageOf(target.specifier) === pkg : mayNameAshara(target, pkg);
}

export function extractAsharaImports(
  content: string,
  filePath: string,
  packagesDir: string,
  fromPkg: string,
): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const { line, specifier } of staticEdges(filePath, content)) {
    const pkg = asharaPackageOf(specifier);
    if (pkg !== null) {
      refs.push({ line, specifier, pkg });
      continue;
    }
    // A relative path that leaves the importing package reaches another package's internals without naming it.
    if (!isRelativeSpecifier(specifier)) continue;
    const target = path.relative(packagesDir, path.resolve(path.dirname(filePath), specifier));
    const targetPkg = target.split(path.sep)[0];
    if (targetPkg === fromPkg) continue;
    const escapes = target === "" || targetPkg === ".." || path.isAbsolute(target);
    refs.push({ line, specifier, pkg: escapes ? null : targetPkg });
  }
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

/** An edge that may load an `@ashara/` module and that no brace, namespace or default clause accounts for. */
interface UnaccountedImport {
  readonly line: number;
  readonly specifier: string;
  readonly target: ImportTarget;
}

/**
 * The file's `@ashara/` imports and re-exports by statement, and every other edge that may load an
 * `@ashara/` module: a side-effect import, a call (a dynamic import, a require, a vitest loader), a
 * type-position import, an import-equals, and an edge whose target no literal spells whole. Those
 * are left unaccounted and reported, never assumed harmless. A program run loads in a process of its
 * own and hands the file no name, so it is neither.
 */
export function extractNamedImports(filePath: string, content: string): { imports: NamedImport[]; unaccounted: UnaccountedImport[] } {
  const imports: NamedImport[] = [];
  const unaccounted: UnaccountedImport[] = [];
  for (const edge of importEdges(filePath, content)) {
    if (!bindsInModule(edge) || !mayNameAshara(edge.target)) continue;
    const pkg = edge.target.kind === "static" ? asharaPackageOf(edge.target.specifier) : null;
    const statement = (edge.form === "import" || edge.form === "export") && edge.clause.kind !== "none";
    if (edge.target.kind === "static" && pkg !== null && statement) {
      const names = edge.clause.kind === "names" ? edge.clause.names.map((entry) => entry.name) : null;
      imports.push({ line: edge.line, specifier: edge.target.specifier, pkg, names });
      continue;
    }
    unaccounted.push({ line: edge.line, specifier: shownTarget(edge.target), target: edge.target });
  }
  return { imports, unaccounted };
}

export function lineAt(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

/**
 * Every relative specifier of the file whose statement is not erased at runtime. An inline
 * `{ type X }` entry does not erase its statement, so such an import is followed (fail closed).
 */
export function valueRelativeImports(filePath: string, content: string): { line: number; specifier: string }[] {
  return staticEdges(filePath, content).filter(({ specifier, edge }) => isRelativeSpecifier(specifier) && !edge.typeOnly);
}

/** The scanned file a relative specifier names, under TypeScript's `.js`-for-`.ts` convention; null when none is. */
export function resolveRelative(fromFile: string, specifier: string, scanned: ReadonlySet<string>): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts")];
  return candidates.find((candidate) => scanned.has(candidate)) ?? null;
}
