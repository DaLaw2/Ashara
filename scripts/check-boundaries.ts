/**
 * ADR-044 Phase 7: Import boundary lint.
 *
 * Statically checks all cross-package @ashara/* imports against the
 * allowed matrix in boundary-rules.toml. Exits 0 if clean, 1 on violations.
 *
 * Usage: npx tsx scripts/check-boundaries.ts
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// TOML parser (minimal: [section] headers + key = ["v1", "v2"] arrays)
// ---------------------------------------------------------------------------

interface BoundaryRules {
  [pkg: string]: string[];
}

function parseRules(toml: string): BoundaryRules {
  const rules: BoundaryRules = {};
  let currentSection: string | null = null;

  for (const raw of toml.split("\n")) {
    const line = raw.trim();

    // Skip blank lines and comments
    if (line === "" || line.startsWith("#")) continue;

    // Section header: [name]
    const sectionMatch = /^\[([a-z][a-z0-9-]*)\]$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }

    // Key = value (we only care about `allow = [...]`)
    if (currentSection === null) continue;

    const kvMatch = /^allow\s*=\s*\[([^\]]*)\]$/.exec(line);
    if (kvMatch) {
      const inner = kvMatch[1].trim();
      if (inner === "") {
        rules[currentSection] = [];
      } else {
        rules[currentSection] = inner
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""));
      }
    }
  }

  return rules;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__stubs__") continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        if (
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts") &&
          !entry.name.endsWith(".d.ts")
        ) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

interface ImportRef {
  line: number;
  pkg: string;
}

const IMPORT_RE = /from\s+["']@ashara\/([a-z][a-z0-9-]*)["']/g;

function extractAsharaImports(content: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    let match: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(lines[i])) !== null) {
      refs.push({ line: i + 1, pkg: match[1] });
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  line: number;
  fromPkg: string;
  importedPkg: string;
}

function main(): void {
  const root = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");
  const rulesPath = path.join(root, "boundary-rules.toml");

  if (!fs.existsSync(rulesPath)) {
    console.error(`ERROR: ${rulesPath} not found`);
    process.exit(1);
  }

  const rules = parseRules(fs.readFileSync(rulesPath, "utf-8"));
  const packagesDir = path.join(root, "packages");

  const violations: Violation[] = [];
  let filesChecked = 0;

  const packageDirs = fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const pkgName of packageDirs) {
    const allowed = rules[pkgName];

    // If no rules defined for this package, skip it (unconfigured)
    if (allowed === undefined) continue;

    // Wildcard: all imports allowed (composition root)
    const isWildcard = allowed.length === 1 && allowed[0] === "*";

    const srcDir = path.join(packagesDir, pkgName, "src");
    if (!fs.existsSync(srcDir)) continue;

    const files = collectTsFiles(srcDir);

    for (const filePath of files) {
      filesChecked++;
      const content = fs.readFileSync(filePath, "utf-8");
      const imports = extractAsharaImports(content);

      for (const ref of imports) {
        if (isWildcard) continue;
        if (allowed.includes(ref.pkg)) continue;

        violations.push({
          file: path.relative(root, filePath),
          line: ref.line,
          fromPkg: pkgName,
          importedPkg: ref.pkg,
        });
      }
    }
  }

  // Report
  if (violations.length > 0) {
    console.error("\nBoundary violations found:\n");
    for (const v of violations) {
      console.error(
        `  ${v.file}:${v.line}  ${v.fromPkg} -> @ashara/${v.importedPkg}  (not in allow list)`
      );
    }
    console.error(`\n${filesChecked} files checked, ${violations.length} violations found\n`);
    process.exit(1);
  } else {
    console.log(`\nAll boundaries clean. ${filesChecked} files checked, 0 violations.\n`);
    process.exit(0);
  }
}

main();
