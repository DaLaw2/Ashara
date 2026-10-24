/**
 * The one TypeScript program every guard that decides an import edge or a type copy asks: a
 * ts.Program over a set of module texts, its type checker, and the module each specifier of those
 * texts resolves to. A guard reads edges and type identity from it, never from a syntax form or a
 * name of its own.
 *
 * A program is built once per set of texts and kept for the run, so the gate's lints, which read
 * the same files, share one checker. Its options are the root's tsconfig.json, or this checkout's
 * when the root holds none (an in-memory tree), with `allowJs` so a .js or .mjs module is read
 * alike, and vitest's globals declared so a test that calls `vi` without importing it resolves.
 * A workspace specifier `@ashara/<pkg>[/<sub>]` resolves through the root's
 * packages/<pkg>/package.json exports, never through a linked copy elsewhere; any other bare
 * specifier the module's own directory cannot resolve resolves from this checkout, whose
 * node_modules holds the types the checker needs.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { z } from "zod";

const CHECKOUT = path.resolve(import.meta.dirname, "..");
const WORKSPACE_SPECIFIER = /^@ashara\/([a-z][a-z0-9-]*)(\/.*)?$/;
/** The programs over many modules kept at once: the gate's one, and the one a test builds beside it. */
const KEPT_PROGRAMS = 2;
/** The programs of one module kept at once, for the reads that come back to the same text. */
const KEPT_SINGLES = 8;

class ModuleProgramError extends Error {
  constructor(
    readonly subject: string,
    readonly reason: string,
  ) {
    super(`module-program: ${subject}: ${reason}`);
    this.name = "ModuleProgramError";
  }
}

const PackageExportsSchema = z.object({ exports: z.record(z.string(), z.string()) });

export interface ModuleProgram {
  readonly root: string;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  /** The absolute paths of the texts the program was built over, in the order given. */
  readonly files: readonly string[];
  /** The text's source file, or undefined when `file` is none of the program's texts. */
  sourceFile(file: string): ts.SourceFile | undefined;
  /** The file `specifier`, written in `file`, resolves to, a specifier only a loader call names included; null when the compiler resolves it to none. */
  resolvedModule(file: string, specifier: string): string | null;
  /**
   * The module symbol `specifier`, written in `file`, names: an ambient module the program declares,
   * or the program's source file it resolves to, resolved now when the compiler has not; undefined
   * when it names neither.
   */
  moduleSymbol(file: string, specifier: string): ts.Symbol | undefined;
}

function compilerOptionsOf(root: string): ts.CompilerOptions {
  const own = path.join(root, "tsconfig.json");
  const tsconfigPath = fs.existsSync(own) ? own : path.join(CHECKOUT, "tsconfig.json");
  const read = ts.readConfigFile(tsconfigPath, (p) => ts.sys.readFile(p));
  if (read.error !== undefined) throw new ModuleProgramError(tsconfigPath, ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfigPath), { noEmit: true }, tsconfigPath);
  if (parsed.errors.length > 0) throw new ModuleProgramError(tsconfigPath, parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("; "));
  // eslint-disable-next-line no-restricted-syntax -- policy default: a tsconfig that names no types loads the ambient types of none
  const types = parsed.options.types ?? [];
  return { ...parsed.options, noEmit: true, declaration: false, declarationMap: false, sourceMap: false, allowJs: true, checkJs: false, types: [...types, "vitest/globals"] };
}

/** The `exports` map of the package manifest at `manifestPath`, read with the compiler's own JSON reader. */
function manifestExports(manifestPath: string): Readonly<Record<string, string>> {
  const read = ts.readConfigFile(manifestPath, (p) => ts.sys.readFile(p));
  if (read.error !== undefined) throw new ModuleProgramError(manifestPath, ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const manifest = PackageExportsSchema.safeParse(read.config);
  if (!manifest.success) throw new ModuleProgramError(manifestPath, `exports is not a map of subpath to file: ${manifest.error.message}`);
  return manifest.data.exports;
}

/** Each workspace specifier resolved through its package's manifest under `root`; null for any other specifier, or a package `root` does not hold. */
function workspaceResolver(root: string): (specifier: string) => string | null {
  const exportsByPackage = new Map<string, Readonly<Record<string, string>> | null>();
  return (specifier) => {
    const match = WORKSPACE_SPECIFIER.exec(specifier);
    if (match === null) return null;
    const [, pkg, subpath] = match;
    let exportsMap = exportsByPackage.get(pkg);
    if (exportsMap === undefined) {
      const manifestPath = path.join(root, "packages", pkg, "package.json");
      exportsMap = fs.existsSync(manifestPath) ? manifestExports(manifestPath) : null;
      exportsByPackage.set(pkg, exportsMap);
    }
    if (exportsMap === null) return null;
    const target = exportsMap[subpath === undefined ? "." : `.${subpath}`];
    return target === undefined ? null : path.join(root, "packages", pkg, target);
  };
}

/** Source files read from disk, kept across programs: node_modules and the lib never change in a run, and a file read again with other text is parsed again. */
const diskSources = new Map<string, { readonly text: string; readonly source: ts.SourceFile }>();

function sourceOptionsKey(fileName: string, options: ts.ScriptTarget | ts.CreateSourceFileOptions): string {
  return typeof options === "number" ? `${fileName}\0${options}` : `${fileName}\0${options.languageVersion}\0${String(options.impliedNodeFormat)}`;
}

function scriptKindOf(fileName: string): ts.ScriptKind {
  if (/\.m?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function build(root: string, texts: ReadonlyMap<string, string>): ModuleProgram {
  const options = compilerOptionsOf(root);
  const base = ts.createCompilerHost(options, true);
  const resolveWorkspace = workspaceResolver(root);
  const resolutions = new Map<string, Map<string, string | null>>();
  const textDirectories = new Set<string>();
  for (const file of texts.keys()) for (let dir = path.dirname(file); !textDirectories.has(dir) && dir !== path.dirname(dir); dir = path.dirname(dir)) textDirectories.add(dir);
  const resolutionCache =ts.createModuleResolutionCache(CHECKOUT, (fileName) => base.getCanonicalFileName(fileName), options);
  const resolveOne = (specifier: string, containingFile: string): ts.ResolvedModuleWithFailedLookupLocations => {
    const workspaceFile = resolveWorkspace(specifier);
    if (workspaceFile !== null) {
      return { resolvedModule: { resolvedFileName: workspaceFile, extension: ts.Extension.Ts, isExternalLibraryImport: false } };
    }
    const fromHere = ts.resolveModuleName(specifier, containingFile, options, host, resolutionCache);
    const isBare = !specifier.startsWith(".") && !path.isAbsolute(specifier);
    if (fromHere.resolvedModule !== undefined || !isBare) return fromHere;
    return ts.resolveModuleName(specifier, path.join(CHECKOUT, "index.ts"), options, host, resolutionCache);
  };
  const host: ts.CompilerHost = {
    ...base,
    getCurrentDirectory: () => CHECKOUT,
    fileExists: (fileName) => texts.has(fileName) || base.fileExists(fileName),
    directoryExists: (directoryName) => textDirectories.has(directoryName) || ts.sys.directoryExists(directoryName),
    readFile: (fileName) => texts.get(fileName) ?? base.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError) => {
      const text = texts.get(fileName);
      if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true, scriptKindOf(fileName));
      const diskText = base.readFile(fileName);
      if (diskText === undefined) return undefined;
      const key = sourceOptionsKey(fileName, languageVersion);
      const kept = diskSources.get(key);
      if (kept !== undefined && kept.text === diskText) return kept.source;
      const source = base.getSourceFile(fileName, languageVersion, onError);
      if (source !== undefined) diskSources.set(key, { text: diskText, source });
      return source;
    },
    resolveModuleNameLiterals: (literals, containingFile) => {
      let own = resolutions.get(containingFile);
      if (own === undefined) {
        own = new Map();
        resolutions.set(containingFile, own);
      }
      const resolved = literals.map((literal) => resolveOne(literal.text, containingFile));
      literals.forEach((literal, i) => own.set(literal.text, resolved[i]?.resolvedModule?.resolvedFileName ?? null));
      return resolved;
    },
  };
  const files = [...texts.keys()];
  const program = ts.createProgram({ rootNames: files, options, host });
  /** The file `specifier`, written in `file`, resolves to: as the compiler resolved it for the program, or resolved now for a specifier only a loader call names. */
  const resolvedModule = (file: string, specifier: string): string | null => {
    let own = resolutions.get(file);
    if (own === undefined) {
      own = new Map();
      resolutions.set(file, own);
    }
    const known = own.get(specifier);
    if (known !== undefined) return known;
    const resolved = resolveOne(specifier, file).resolvedModule?.resolvedFileName ?? null;
    own.set(specifier, resolved);
    return resolved;
  };
  const checker = program.getTypeChecker();
  return {
    root,
    program,
    checker,
    files,
    sourceFile: (file) => (texts.has(file) ? program.getSourceFile(file) : undefined),
    resolvedModule,
    moduleSymbol: (file, specifier) => {
      const ambient = checker.getAmbientModules().find((module) => module.name === JSON.stringify(specifier));
      if (ambient !== undefined) return ambient;
      const resolved = resolvedModule(file, specifier);
      const source = resolved === null ? undefined : program.getSourceFile(resolved);
      return source === undefined ? undefined : checker.getSymbolAtLocation(source);
    },
  };
}

interface KeptProgram {
  readonly key: string;
  readonly built: ModuleProgram;
}

/** The programs of this run over many modules, the most recently asked last. */
const kept: KeptProgram[] = [];
/** The programs of one module each, kept apart so a read of a stray text never drops a program over many. */
const singles: KeptProgram[] = [];

function contentKey(root: string, texts: ReadonlyMap<string, string>): string {
  const hash = createHash("sha1").update(root);
  for (const [file, text] of [...texts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) hash.update(`\0${file}\0${text}`);
  return hash.digest("hex");
}

/** The program `key` names in `pool`, made the most recently asked, or one `build` makes and the pool keeps, dropping its oldest past `size`. */
function keptOrBuilt(pool: KeptProgram[], size: number, key: string, make: () => ModuleProgram): ModuleProgram {
  const at = pool.findIndex((entry) => entry.key === key);
  if (at !== -1) {
    const [entry] = pool.splice(at, 1);
    pool.push(entry);
    return entry.built;
  }
  const built = make();
  pool.push({ key, built });
  if (pool.length > size) pool.shift();
  return built;
}

/**
 * The program over `texts` (each module's path to its text), with options and workspace packages
 * read under `root`; built once per set of texts and kept for the run.
 */
export function moduleProgram(root: string, texts: ReadonlyMap<string, string>): ModuleProgram {
  const absolute = new Map([...texts].map(([file, text]) => [path.resolve(file), text]));
  const pool = absolute.size === 1 ? singles : kept;
  return keptOrBuilt(pool, pool === singles ? KEPT_SINGLES : KEPT_PROGRAMS, contentKey(root, absolute), () => build(root, absolute));
}

/** The program over `texts`, with this checkout's options and workspace packages. */
export function checkoutProgram(texts: ReadonlyMap<string, string>): ModuleProgram {
  return moduleProgram(CHECKOUT, texts);
}

/** Drops every kept program and source, so a run that is done reading lets their memory go. */
export function forgetPrograms(): void {
  kept.length = 0;
  singles.length = 0;
  diskSources.clear();
}

function tsFilesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : tsFilesUnder(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Every .ts module of `root`'s sources, each path to its text on disk: each package's src/ and test/, and scripts/. */
function sourceTexts(root: string): Map<string, string> {
  const packagesDir = path.join(root, "packages");
  const packages = fs.existsSync(packagesDir) ? fs.readdirSync(packagesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()) : [];
  const dirs = [...packages.flatMap((entry) => ["src", "test"].map((dir) => path.join(packagesDir, entry.name, dir))), path.join(root, "scripts")];
  return new Map(dirs.flatMap(tsFilesUnder).map((file): [string, string] => [file, fs.readFileSync(file, "utf-8")]));
}

/**
 * A kept program that holds `file` with exactly `text`; else, when `file` is a source of this
 * checkout as it stands on disk, the program over every source of the checkout (one build serves
 * every later file); else a program of that one module whose other modules resolve from this
 * checkout.
 */
export function programHolding(file: string, text: string): ModuleProgram {
  const absolute = path.resolve(file);
  for (const pool of [kept, singles]) {
    for (let i = pool.length - 1; i >= 0; i--) {
      const built = pool[i].built;
      if (built.sourceFile(absolute)?.text === text) return built;
    }
  }
  const whole = sourceTexts(CHECKOUT);
  if (whole.get(absolute) === text) return checkoutProgram(whole);
  return checkoutProgram(new Map([[absolute, text]]));
}
