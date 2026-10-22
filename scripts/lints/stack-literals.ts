/**
 * A stack literal (a manifest, language, extension or toolchain name) in a non-test
 * packages/<pkg>/src module, against the tokens and exemptions of the rules file's [stack-literals]
 * section, which is no package's section (scripts/stack-literals.ts states what that scan reads and
 * its blind spots).
 */

import fs from "node:fs";
import path from "node:path";
import { findStackLiterals, parseStackLiteralRules, STACK_LITERALS_SECTION } from "../stack-literals.js";
import type { LintContext, Violation } from "./lint.js";
import { collectTsFiles } from "./source-files.js";

/**
 * A stack literal in a non-test module under packages/<pkg>/src that no [stack-literals] exemption
 * admits, and every exempted token no literal of its file uses, so the exemptions only shrink.
 */
function stackLiteralViolations(
  root: string,
  packagesDir: string,
  packageDirs: readonly string[],
  toml: string,
  rulesRelative: string,
): Violation[] {
  const rules = parseStackLiteralRules(toml, rulesRelative);
  const tokens = [...rules.tokens.values()].flat();
  const violations: Violation[] = [];
  const exemptionsUsed = new Set<string>();
  let scanned = 0;
  for (const pkgName of packageDirs) {
    const srcDir = path.join(packagesDir, pkgName, "src");
    for (const filePath of collectTsFiles(srcDir).filter((file) => !file.endsWith(".test.ts"))) {
      scanned++;
      const file = path.relative(root, filePath).split(path.sep).join("/");
      for (const hit of findStackLiterals(fs.readFileSync(filePath, "utf-8"), filePath, tokens)) {
        const token = hit.token.toLowerCase();
        const exemption = rules.exemptions.find((e) => e.file === file && e.tokens.some((t) => t.toLowerCase() === token));
        if (exemption !== undefined) {
          exemptionsUsed.add(`${exemption.id}\0${token}`);
          continue;
        }
        violations.push({
          file,
          line: hit.line,
          fromPkg: pkgName,
          specifier: hit.token,
          reason: `stack literal in production source: ${hit.literal}; take it from the contract, or exempt it in [${STACK_LITERALS_SECTION}] with a reason`,
        });
      }
    }
  }
  if (scanned === 0) {
    violations.push({ file: "packages", line: 0, fromPkg: "*", specifier: STACK_LITERALS_SECTION, reason: "no source module to scan for stack literals; a scan of nothing would pass" });
  }
  for (const exemption of rules.exemptions) {
    for (const token of exemption.tokens) {
      if (!exemptionsUsed.has(`${exemption.id}\0${token.toLowerCase()}`)) {
        violations.push({
          file: rulesRelative,
          line: 0,
          fromPkg: STACK_LITERALS_SECTION,
          specifier: `exempt.${exemption.id}`,
          reason: `"${token}" is exempted in ${exemption.file}, but no literal there uses it; remove it`,
        });
      }
    }
  }
  return violations;
}

export function run(context: LintContext): Violation[] {
  return stackLiteralViolations(context.root, context.packagesDir, context.packageDirs, context.toml, context.rulesRelative);
}
