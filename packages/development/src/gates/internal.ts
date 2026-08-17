import { dirname, join, resolve } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { loadSkipDirs, TargetPackageJsonSchema } from "@ashara/shared";

// ---------------------------------------------------------------------------
// Shared file-scanning primitives — the import-graph BFS used by both
// checkRouteReachability (reachability.ts) and deriveEndpoints (endpoints.ts),
// plus the route/source-file patterns also used by the smoke-trigger
// detection (smoke.ts). Genuinely shared across gate modules, so they live
// here rather than being duplicated or owned by a single consumer.
// ---------------------------------------------------------------------------

// Blocklist approach: everything that is NOT a known non-source artifact IS
// source. Binary, config, media and lock formats are a finite, slowly-changing
// set; source-code extensions are open and grow with every new language.
const NON_SOURCE_EXTENSIONS = new Set([
  ".json", ".yaml", ".yml", ".toml", ".xml",
  ".lock", ".sum", ".mod",
  ".md", ".txt", ".csv", ".log",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".bmp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".map", ".min.js", ".min.css",
  ".pdf", ".zip", ".tar", ".gz", ".tgz", ".bz2",
  ".wasm", ".so", ".dylib", ".dll", ".exe", ".o", ".a",
  ".snap", ".bin", ".dat", ".db", ".sqlite",
]);

export function isSourceFile(name: string): boolean {
  if (name.endsWith(".d.ts")) return false;
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return !NON_SOURCE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/**
 * Recursively collect source files under `dir` (skipping build/dependency
 * directories and `.d.ts` declarations). When `excludeDirs` is omitted the
 * project's `.gitignore` is read via `loadSkipDirs` — no hardcoded skip-list.
 */
export async function collectSourceFiles(
  dir: string,
  acc: string[],
  excludeDirs?: ReadonlySet<string>,
): Promise<void> {
  const skip = excludeDirs ?? await loadSkipDirs(dir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory does not exist or is unreadable — nothing to collect
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) {
        await collectSourceFiles(join(dir, entry.name), acc, excludeDirs);
      }
    } else if (
      entry.isFile() &&
      isSourceFile(entry.name)
    ) {
      acc.push(join(dir, entry.name));
    }
  }
}

const IMPORT_SPEC_PATTERNS: readonly RegExp[] = [
  /\bfrom\s+["']([^"']+)["']/g, // import ... from "x" / export ... from "x"
  /\bimport\s+["']([^"']+)["']/g, // side-effect import "x"
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("x")
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

export async function findEntryPoint(projectRoot: string, contractEntryPoint: string | null): Promise<string | null> {
  if (contractEntryPoint !== null) {
    const candidatePath = join(projectRoot, contractEntryPoint);
    const isFile = await stat(candidatePath).then(
      (s) => s.isFile(),
      () => false,
    );
    if (isFile) return candidatePath;
  }

  const pkgJsonPath = join(projectRoot, "package.json");
  let pkgContent: string;
  try {
    pkgContent = await readFile(pkgJsonPath, "utf-8");
  } catch {
    return null;
  }
  const parsed = TargetPackageJsonSchema.safeParse(JSON.parse(pkgContent));
  if (!parsed.success) return null;
  const pkg = parsed.data;
  const scripts = pkg.scripts;
  if (scripts && typeof scripts.start === "string") {
    const match = scripts.start.match(/(?:node|npx\s+tsx)\s+(\S+)/);
    if (match) {
      const resolved = join(projectRoot, match[1]);
      const exists = await stat(resolved).then((s) => s.isFile(), () => false);
      if (exists) return resolved;
    }
  }
  if (typeof pkg.main === "string") {
    const resolved = join(projectRoot, pkg.main);
    const exists = await stat(resolved).then((s) => s.isFile(), () => false);
    if (exists) return resolved;
  }
  return null;
}

function extractRelativeImportSpecs(content: string): string[] {
  const specs: string[] = [];
  for (const pattern of IMPORT_SPEC_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const spec = match[1];
      if (spec !== undefined && (spec.startsWith("./") || spec.startsWith("../"))) {
        specs.push(spec);
      }
    }
  }
  return specs;
}

export async function resolveImportSpec(fromFile: string, spec: string): Promise<string[]> {
  const base = resolve(dirname(fromFile), spec);
  const candidates = new Set<string>([base]);
  // TS NodeNext convention: "./x.js" in source resolves to x.ts on disk.
  if (base.endsWith(".js")) candidates.add(`${base.slice(0, -3)}.ts`);
  if (base.endsWith(".mjs")) candidates.add(`${base.slice(0, -4)}.mts`);
  if (base.endsWith(".cjs")) candidates.add(`${base.slice(0, -4)}.cts`);
  for (const ext of [".ts", ".tsx", ".js", ".mjs", ".cjs"]) {
    candidates.add(`${base}${ext}`);
  }
  for (const index of ["index.ts", "index.js"]) {
    candidates.add(join(base, index));
  }
  const resolved: string[] = [];
  for (const candidate of candidates) {
    const isFile = await stat(candidate).then(
      (s) => s.isFile(),
      () => false,
    );
    if (isFile) resolved.push(candidate);
  }
  return resolved;
}

export async function computeReachableFiles(entryPoint: string): Promise<Set<string>> {
  const reachable = new Set<string>([entryPoint]);
  const queue: string[] = [entryPoint];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    let content: string;
    try {
      content = await readFile(current, "utf-8");
    } catch {
      continue;
    }
    for (const spec of extractRelativeImportSpecs(content)) {
      for (const resolvedFile of await resolveImportSpec(current, spec)) {
        if (!reachable.has(resolvedFile)) {
          reachable.add(resolvedFile);
          queue.push(resolvedFile);
        }
      }
    }
  }
  return reachable;
}

// ---------------------------------------------------------------------------
// Mount resolution — resolving `app.use(prefix, <identifier>)` to the file the
// identifier is imported from. Used by deriveEndpoints (endpoints.ts) to
// compute full route paths.
// ---------------------------------------------------------------------------

export interface RouterMount {
  readonly prefix: string;
  readonly identifier: string;
}

const APP_MOUNT_PATTERN = /\bapp\.use\s*\(\s*["'`]([^"'`]*)["'`]\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
const APP_MOUNT_NO_PREFIX_PATTERN = /\bapp\.use\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g;

export function extractMounts(content: string): RouterMount[] {
  const mounts: RouterMount[] = [];
  for (const m of content.matchAll(APP_MOUNT_PATTERN)) {
    mounts.push({ prefix: m[1], identifier: m[2] });
  }
  for (const m of content.matchAll(APP_MOUNT_NO_PREFIX_PATTERN)) {
    mounts.push({ prefix: "", identifier: m[1] });
  }
  return mounts;
}

const IMPORT_DEFAULT_PATTERN =
  /\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g;
const IMPORT_NAMED_PATTERN = /\bimport\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const REQUIRE_DEFAULT_PATTERN =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_NAMED_PATTERN =
  /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;

function addNamedBindings(bindings: Map<string, string>, list: string, spec: string): void {
  for (const raw of list.split(",")) {
    const item = raw.trim();
    if (item.length === 0) continue;
    // "a as b" (ESM) and "a: b" (require destructure) bind the local name b.
    const aliasMatch = item.match(/^[\w$]+\s+as\s+([\w$]+)$/) ?? item.match(/^[\w$]+\s*:\s*([\w$]+)$/);
    if (aliasMatch) {
      bindings.set(aliasMatch[1], spec);
    } else if (/^[A-Za-z_$][\w$]*$/.test(item)) {
      bindings.set(item, spec);
    }
  }
}

/** Map each locally-bound identifier (default/named/aliased, ESM or CJS) to the module spec it came from. */
export function extractImportBindings(content: string): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const m of content.matchAll(IMPORT_DEFAULT_PATTERN)) {
    bindings.set(m[1], m[3]);
    if (m[2] !== undefined) addNamedBindings(bindings, m[2], m[3]);
  }
  for (const m of content.matchAll(IMPORT_NAMED_PATTERN)) {
    addNamedBindings(bindings, m[1], m[2]);
  }
  for (const m of content.matchAll(REQUIRE_DEFAULT_PATTERN)) {
    bindings.set(m[1], m[2]);
  }
  for (const m of content.matchAll(REQUIRE_NAMED_PATTERN)) {
    addNamedBindings(bindings, m[1], m[2]);
  }
  return bindings;
}
