/**
 * Finds a raw copy of a cross-context predicate: SQL or a comparison that re-spells a rule another
 * context owns instead of importing the owner's one spelling: a fact is published by the context
 * whose state it describes, so two spellings of it can only drift apart. Each rule below names
 * its owner, the file or the context whose state it describes; a match anywhere else under
 * packages/<pkg>/src is a copy. Run by check-boundaries.ts inside `just check`.
 *
 * What is read: every line of a non-test .ts file under packages/<pkg>/src, except packages/integration,
 * whose simulator restates the rules on purpose as an independent oracle. A line whose first
 * non-blank characters open a comment (`//`, `/*`, `*`) is not read: prose that names a rule decides
 * nothing.
 *
 * Blind spots, each a copy this check passes:
 * - A copy spelled in another shape: a different alias or quoting, a literal built from pieces, a
 *   rule restated through a column the patterns do not name, or one split across lines.
 * - A rule no pattern below names; only the shapes listed here are enumerated.
 * - Comparison inside the owner itself is not checked: an owner may spell its rule twice.
 */

import fs from "node:fs";
import path from "node:path";

interface PredicateRule {
  readonly name: string;
  /** Repository-relative path prefixes the rule's spelling may appear under. */
  readonly owners: readonly string[];
  readonly patterns: readonly RegExp[];
  /** What a reader outside the owner imports instead. */
  readonly use: string;
}

const DELIVERY_PREDICATES = "packages/delivery/src/predicates.ts";
const ENGAGEMENT_PREDICATES = "packages/engagement/src/predicates.ts";

const PREDICATE_RULES: readonly PredicateRule[] = [
  {
    name: "superseded",
    owners: ["packages/delivery/src/"],
    patterns: [/blocked_?[rR]eason\b.*['"]superseded['"]/, /\.source\s*[!=]==?\s*['"]superseded['"]/],
    use: "isSupersededItem, inCurrentPlan or givenUpItem from @ashara/delivery/predicates",
  },
  {
    name: "current plan, given-up tasks left out",
    owners: [DELIVERY_PREDICATES],
    patterns: [/status\s*(?:<>|!=)\s*'Abandoned'/],
    use: "liveInCurrentPlan from @ashara/delivery/predicates",
  },
  {
    name: "task origin (goal task, product scaffold, review, ...)",
    owners: ["packages/delivery/src/"],
    patterns: [/origin'?\s*(?:===|!==|==|!=|=|<>)\s*['"](?:decomposition|product-scaffold|sprint0|review|check|environment-change|acceptance)['"]/],
    use: "goalTaskSql, isGoalTask, productScaffoldTask, isProductScaffoldOrigin, isSprint0Origin or reviewTask from @ashara/delivery/predicates",
  },
  {
    name: "project at work (engagement lifecycle 'active')",
    owners: [ENGAGEMENT_PREDICATES],
    patterns: [/lifecycle\W*=\s*'active'/, /lifecycle,\s*['"]active['"]/],
    use: "projectActive or projectAtWork from @ashara/engagement/predicates",
  },
  {
    name: "first plan told",
    owners: [ENGAGEMENT_PREDICATES],
    patterns: [/reports_on\s*=\s*'first-plan'/],
    use: "firstPlanTold or firstPlanUnreported from @ashara/engagement/predicates",
  },
];

export interface PredicateCopy {
  /** Repository-relative, `/`-separated. */
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
  readonly use: string;
}

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** The copies in one file's text, `file` repository-relative. */
function findPredicateCopiesIn(file: string, content: string): PredicateCopy[] {
  const copies: PredicateCopy[] = [];
  const lines = content.split("\n");
  for (const rule of PREDICATE_RULES) {
    if (rule.owners.some((owner) => file === owner || (owner.endsWith("/") && file.startsWith(owner)))) continue;
    lines.forEach((text, index) => {
      if (COMMENT_LINE.test(text)) return;
      if (rule.patterns.some((pattern) => pattern.test(text))) copies.push({ file, line: index + 1, rule: rule.name, text: text.trim(), use: rule.use });
    });
  }
  return copies;
}

/** A tree to scan holds no production source: a scan of nothing would pass. */
class NoSourceToScan extends Error {
  constructor(readonly packagesDir: string) {
    super(`predicate copies: no production .ts file under ${packagesDir}/<pkg>/src to scan; a scan of nothing would pass`);
    this.name = "NoSourceToScan";
  }
}

function productionFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return productionFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

/** Every copy under `root`/packages/<pkg>/src, packages/integration aside. */
export function findPredicateCopies(root: string): PredicateCopy[] {
  const packagesDir = path.join(root, "packages");
  const files = fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "integration")
    .flatMap((entry) => productionFiles(path.join(packagesDir, entry.name, "src")));
  if (files.length === 0) throw new NoSourceToScan(packagesDir);
  return files.flatMap((full) => findPredicateCopiesIn(path.relative(root, full).split(path.sep).join("/"), fs.readFileSync(full, "utf-8")));
}
