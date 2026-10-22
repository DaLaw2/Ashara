/**
 * A production prompt wording a simulator stand-in recognises is spelled once, in the simulator's
 * wording module: a copy elsewhere under packages/integration/src/simulator drifts from it when the
 * production prompt changes, and the stand-in and the copy then read the prompt differently. The
 * recognised literals are the wording module's string literals, the static text of its template
 * literals and the leading literal text of its regular expressions, each of at least
 * MIN_LITERAL_CHARS characters. Blind spots: a copy split across a concatenation, or spelled with
 * different escapes, is not seen.
 */

import fs from "node:fs";
import path from "node:path";
import type { LintContext, Violation } from "./lint.js";
import { collectTsFiles, lineAt } from "./source-files.js";

const SIMULATOR_DIR = "packages/integration/src/simulator";
const WORDING_MODULE = `${SIMULATOR_DIR}/stand-ins/recognised-wording.ts`;
const SPECIFIER = "recognised-wording";

/** Shorter text (a heading such as `Interface:`) is common enough to appear by chance, so only longer text is held. */
const MIN_LITERAL_CHARS = 12;

const COMMENT_RE = /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm;
/** An import or re-export statement: its specifier names a module, never a wording. */
const IMPORT_RE = /^(?:import|export)\b[^;]*?\bfrom\s*["'][^"']*["'];?$/gm;
const QUOTED_RE = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
const TEMPLATE_RE = /`((?:[^`\\]|\\.)*)`/g;
const REGEX_RE = /(?<=[(=,]\s*)\/((?:[^/\\\n]|\\.)+)\/[dgimsuy]*/g;
const REGEX_META = new Set([..."()[]{}.*+?^$|"]);

/** The leading text a regular expression matches literally, its escapes read as the characters they name. */
function literalPrefix(source: string): string {
  let text = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === undefined || /[A-Za-z0-9]/.test(next)) break;
      text += next;
      i++;
      continue;
    }
    if (REGEX_META.has(ch)) break;
    text += ch;
  }
  return text;
}

/** Every recognised literal of the wording module's source, each once. */
function recognisedLiterals(source: string): string[] {
  const code = source.replace(COMMENT_RE, "").replace(IMPORT_RE, "");
  const found = new Set<string>();
  for (const match of code.matchAll(QUOTED_RE)) found.add(match[1] ?? match[2]);
  for (const match of code.matchAll(TEMPLATE_RE)) for (const part of match[1].split(/\$\{[^}]*\}/)) found.add(part);
  for (const match of code.matchAll(REGEX_RE)) found.add(literalPrefix(match[1]));
  return [...found].filter((literal) => literal.length >= MIN_LITERAL_CHARS);
}

export function run(context: LintContext): Violation[] {
  const { root } = context;
  const wordingPath = path.join(root, WORDING_MODULE);
  const at = (file: string, line: number, reason: string): Violation => ({ file, line, fromPkg: "integration", specifier: SPECIFIER, reason });
  if (!fs.existsSync(wordingPath)) return [at(WORDING_MODULE, 0, "the simulator's wording module is missing; a scan against no wording would pass")];
  const literals = recognisedLiterals(fs.readFileSync(wordingPath, "utf-8"));
  if (literals.length === 0) return [at(WORDING_MODULE, 0, "the wording module holds no recognised literal; a scan of nothing would pass")];
  const violations: Violation[] = [];
  for (const filePath of collectTsFiles(path.join(root, SIMULATOR_DIR))) {
    if (filePath === wordingPath) continue;
    const content = fs.readFileSync(filePath, "utf-8");
    const file = path.relative(root, filePath).split(path.sep).join("/");
    for (const literal of literals) {
      const offset = content.indexOf(literal);
      if (offset < 0) continue;
      violations.push(at(file, lineAt(content, offset), `a copy of ${JSON.stringify(literal)}, a wording a stand-in recognises; import it from ${WORDING_MODULE}`));
    }
  }
  return violations;
}
