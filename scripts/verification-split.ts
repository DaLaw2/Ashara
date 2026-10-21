/**
 * Holds Quality's verification split: every verification job is its own module under
 * packages/quality/src/verification/, built by the composition root and reached by Delivery only as
 * a port. Run by check-boundaries.ts inside `just check`.
 *
 * What is read: every .ts file under packages/<pkg>/ (tests included), for the name of the class the
 * jobs were split from and for a property reach `.verification.` (one object holding every job,
 * reached through its holder); and every non-test .ts file under the verification directory, for
 * its length.
 *
 * Blind spots, each a re-merge this check passes:
 * - A class holding every job under another name, under the line cap, reached by another name.
 * - A module over the cap outside the verification directory: only that directory is held to it.
 */

import fs from "node:fs";
import path from "node:path";

/** The longest a verification module may be: one job, its narrow deps and its helpers. */
const VERIFICATION_MODULE_LINE_CAP = 600;

const VERIFICATION_DIR = path.join("packages", "quality", "src", "verification");
const MERGED_NAME = /\bTaskVerification\b|\.verification\./;

export interface VerificationSplitBreak {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

function tsFilesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : tsFilesUnder(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Every place under `root` that undoes the split, and a scan of no verification module. */
export function findVerificationSplitBreaks(root: string): VerificationSplitBreak[] {
  const relative = (file: string): string => path.relative(root, file).split(path.sep).join("/");
  const breaks: VerificationSplitBreak[] = [];
  for (const file of tsFilesUnder(path.join(root, "packages"))) {
    fs.readFileSync(file, "utf-8")
      .split("\n")
      .forEach((text, index) => {
        if (MERGED_NAME.test(text)) {
          breaks.push({ file: relative(file), line: index + 1, reason: "names the merged verification class or reaches every job through one holder; build each job in the composition root and pass it as a port" });
        }
      });
  }
  const modules = tsFilesUnder(path.join(root, VERIFICATION_DIR)).filter((file) => !file.endsWith(".test.ts"));
  if (modules.length === 0) {
    breaks.push({ file: VERIFICATION_DIR.split(path.sep).join("/"), line: 0, reason: "no verification module to measure; a scan of nothing would pass" });
  }
  for (const file of modules) {
    const lines = fs.readFileSync(file, "utf-8").split("\n").length;
    if (lines > VERIFICATION_MODULE_LINE_CAP) {
      breaks.push({ file: relative(file), line: lines, reason: `${lines} lines, over the cap of ${VERIFICATION_MODULE_LINE_CAP}: one module holds one verification job` });
    }
  }
  return breaks;
}
