import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Reads `.gitignore` from `projectPath` and returns the set of directory names
 * to skip during tree scans. This is the ONLY mechanism for deciding which
 * directories to exclude — hardcoded skip-lists of ecosystem-specific names
 * (node_modules, target, __pycache__) are a generality defect because they
 * silently miss every ecosystem nobody thought of.
 *
 * `.git` is always included — it is structural, not project-specific.
 *
 * The parser handles the subset of gitignore syntax that names directories:
 * bare names (`node_modules`), trailing-slash patterns (`dist/`), and negation
 * (`!kept/`). Glob patterns (`*.pyc`, `build-*`) are intentionally skipped —
 * they match files or partial names, not the top-level directory exclusion
 * this function serves.
 */
export async function loadSkipDirs(projectPath: string): Promise<ReadonlySet<string>> {
  const dirs = new Set([".git"]);
  const negated = new Set<string>();

  let content: string;
  try {
    content = await readFile(join(projectPath, ".gitignore"), "utf-8");
  } catch {
    return dirs;
  }

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    if (line.startsWith("!")) {
      const name = line.slice(1).replace(/\/+$/, "");
      if (name && !name.includes("*") && !name.includes("/")) {
        negated.add(name);
      }
      continue;
    }

    const name = line.replace(/\/+$/, "");
    if (name.includes("*") || name.includes("/")) continue;
    if (name.startsWith(".")) continue;
    dirs.add(name);
  }

  for (const n of negated) dirs.delete(n);
  return dirs;
}
