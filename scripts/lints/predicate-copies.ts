/**
 * A raw copy of a cross-context predicate outside the context that owns it, which drifts from the
 * owner's one spelling (scripts/predicate-copies.ts).
 */

import { findPredicateCopies } from "../predicate-copies.js";
import type { LintContext, Violation } from "./lint.js";

export function run(context: LintContext): Violation[] {
  return findPredicateCopies(context.root).map((copy) => ({
    file: copy.file,
    line: copy.line,
    fromPkg: copy.file.split("/")[1] ?? copy.file,
    specifier: `predicate: ${copy.rule}`,
    reason: `a raw copy of a rule another context owns: ${copy.text}; use ${copy.use}`,
  }));
}
