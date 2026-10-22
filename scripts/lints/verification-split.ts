/**
 * Each verification job is its own short module, built by the composition root, never one class
 * every job is reached through (scripts/verification-split.ts).
 */

import { findVerificationSplitBreaks } from "../verification-split.js";
import type { LintContext, Violation } from "./lint.js";

export function run(context: LintContext): Violation[] {
  return findVerificationSplitBreaks(context.root).map((found) => ({ file: found.file, line: found.line, fromPkg: found.file.split("/")[1] ?? found.file, specifier: "verification-split", reason: found.reason }));
}
