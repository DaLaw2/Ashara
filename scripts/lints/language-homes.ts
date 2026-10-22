/**
 * A name of one context's language declared, or re-exported, in another package, against the
 * [homes] section of the rules file: a type, function or constant lives in the one package whose
 * language it is, and a package that moved it out leaves no copy and no re-export shim behind.
 */

import { BoundaryRulesParseError } from "./rules-parse-error.js";
import type { LintContext, Violation } from "./lint.js";

export const HOMES_SECTION = "homes";

const SECTION_RE = /^\[([^\]]+)\]$/;
const HOME_RE = /^([A-Za-z_$][\w$]*)\s*=\s*"([a-z][a-z0-9-]*)"$/;

interface Home {
  readonly name: string;
  readonly pkg: string;
  readonly line: number;
}

/** Each `<Name> = "<package>"` line of [homes]; a malformed line, or an unknown package, refuses the gate. */
function parseHomes(toml: string, rulesRelative: string, packageDirs: readonly string[]): Home[] {
  const homes: Home[] = [];
  let inSection = false;
  const lines = toml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    const section = SECTION_RE.exec(line);
    if (section !== null) {
      inSection = section[1] === HOMES_SECTION;
      continue;
    }
    if (!inSection) continue;
    const home = HOME_RE.exec(line);
    if (home === null) throw new BoundaryRulesParseError(rulesRelative, i + 1, line, `[${HOMES_SECTION}] expects Name = "package"`);
    if (!packageDirs.includes(home[2])) throw new BoundaryRulesParseError(rulesRelative, i + 1, line, `[${HOMES_SECTION}] names no package under packages/`);
    if (homes.some((h) => h.name === home[1])) throw new BoundaryRulesParseError(rulesRelative, i + 1, line, `[${HOMES_SECTION}] names ${home[1]} twice`);
    homes.push({ name: home[1], pkg: home[2], line: i + 1 });
  }
  return homes;
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** Where `source` declares `name`, or names it in an export list (a re-export included): 1-based lines. */
function declarationLines(source: string, name: string): number[] {
  const word = escapeRegExp(name);
  const patterns = [
    new RegExp(`^[ \\t]*(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:type|interface|function|const|let|var|class|enum)\\s+${word}(?![\\w$])`, "gm"),
    new RegExp(`^[ \\t]*export\\s+(?:type\\s+)?\\{[^}]*?(?<![\\w$])${word}(?![\\w$])`, "gm"),
  ];
  const lines = new Set<number>();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      lines.add(source.slice(0, match.index + match[0].length).split("\n").length);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

export function run(context: LintContext): Violation[] {
  const homes = parseHomes(context.toml, context.rulesRelative, context.packageDirs);
  const violations: Violation[] = [];
  for (const home of homes) {
    let declaredAtHome = false;
    for (const pkg of context.packages) {
      for (const [filePath, source] of pkg.contents) {
        const relative = pkg.relativeTo(filePath);
        if (relative.endsWith(".test.ts")) continue;
        for (const line of declarationLines(source, home.name)) {
          if (pkg.name === home.pkg) {
            declaredAtHome = true;
            continue;
          }
          violations.push({
            file: `packages/${pkg.name}/${relative}`,
            line,
            fromPkg: pkg.name,
            specifier: home.name,
            reason: `${home.name} is ${home.pkg}'s language ([${HOMES_SECTION}]); import it from @ashara/${home.pkg}, never declare or re-export it here`,
          });
        }
      }
    }
    if (!declaredAtHome) {
      violations.push({
        file: context.rulesRelative,
        line: home.line,
        fromPkg: HOMES_SECTION,
        specifier: home.name,
        reason: `no source file of ${home.pkg} declares ${home.name}; remove its entry or declare it there`,
      });
    }
  }
  return violations;
}
