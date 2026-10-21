/**
 * Finds a raw copy of a cross-context predicate: SQL or a comparison that re-spells a rule another
 * context owns instead of importing the owner's one spelling: a fact is published by the context
 * whose state it describes, so two spellings of it can only drift apart. Each rule below names
 * its owner, the file or the context whose state it describes; a match anywhere else under
 * packages/<pkg>/src is a copy. Run by check-boundaries.ts inside `just check`.
 *
 * What is read: every line of a non-test .ts file under packages/<pkg>/src, except the paths a rule
 * exempts as an oracle: the integration simulator restates the rules on purpose as an independent
 * oracle, and every rule but the status partition exempts all of packages/integration. A line whose
 * first non-blank characters open a comment (`//`, `/*`, `*`) is not read: prose that names a rule
 * decides nothing. A pattern is matched against the file's text as a whole, so the work-item status
 * patterns, which may cross a line break, catch a list or a chain split across lines; a copy is
 * reported at the line it starts on.
 *
 * Blind spots, each a copy this check passes:
 * - A copy spelled in another shape: a different alias or quoting, a literal built from pieces, a
 *   rule restated through a column the patterns do not name, or a cross-context predicate split across
 *   lines (only the work-item status patterns cross a line break).
 * - A rule no pattern below names; only the shapes listed here are enumerated.
 * - A report subject's literal that reaches the column through a name the patterns do not read, such
 *   as a function argument (`unreported("planning-stopped")`) or a constant not named *subject*.
 * - Comparison inside the owner itself is not checked: an owner may spell its rule twice.
 * - A list of work-item statuses whose literals are not adjacent (`["Pending", x, "Failed"]`), a
 *   chain of comparisons on a name other than `status`, or a chain whose comparisons a `;`, `{` or
 *   `}` separates.
 */

import fs from "node:fs";
import path from "node:path";
import { WORK_ITEM_STATUSES } from "@ashara/delivery/work-item";

interface PredicateRule {
  readonly name: string;
  /** Repository-relative path prefixes the rule's spelling may appear under. */
  readonly owners: readonly string[];
  readonly patterns: readonly RegExp[];
  /** What a reader outside the owner imports instead. */
  readonly use: string;
  /** Repository-relative path prefixes not read for this rule: an oracle that restates it on purpose. */
  readonly exempt: readonly string[];
}

const DELIVERY_PREDICATES = "packages/delivery/src/predicates.ts";
const ENGAGEMENT_PREDICATES = "packages/engagement/src/predicates.ts";
const INTEGRATION = "packages/integration/";

const STATUS_LITERAL = `['"](?:${WORK_ITEM_STATUSES.join("|")})['"]`;
const STATUS_COMPARISON = `\\bstatus\\b['"]?\\s*(?:===|!==|==|!=|=|<>)\\s*${STATUS_LITERAL}`;
const ENGAGEMENT_REPORT_SUBJECTS = "packages/engagement/src/report-subjects.ts";
const QUALITY_STORED_CHECKS = "packages/quality/src/stored-checks.ts";
/** Model Access's catalog: read by Model Access itself, by Finance in front of it, and by the catalog repository that loads it at boot. */
const MODEL_CATALOG_OWNERS = ["packages/model-access/src/", "packages/finance/src/", "packages/db/src/repositories/config.ts"];

const PREDICATE_RULES: readonly PredicateRule[] = [
  {
    name: "superseded",
    owners: ["packages/delivery/src/"],
    patterns: [/blocked_?[rR]eason\b.*['"]superseded['"]/, /\.source\s*[!=]==?\s*['"]superseded['"]/],
    use: "isSupersededItem, inCurrentPlan or givenUpItem from @ashara/delivery/predicates",
    exempt: [INTEGRATION],
  },
  {
    name: "current plan, given-up tasks left out",
    owners: [DELIVERY_PREDICATES],
    patterns: [/status\s*(?:<>|!=)\s*'Abandoned'/],
    use: "liveInCurrentPlan from @ashara/delivery/predicates",
    exempt: [INTEGRATION],
  },
  {
    name: "task origin (goal task, product scaffold, review, ...)",
    owners: ["packages/delivery/src/"],
    patterns: [/origin'?\s*(?:===|!==|==|!=|=|<>)\s*['"](?:decomposition|product-scaffold|sprint0|review|check|environment-change|acceptance)['"]/],
    use: "goalTaskSql, isGoalTask, productScaffoldTask, isProductScaffoldOrigin, isSprint0Origin or reviewTask from @ashara/delivery/predicates",
    exempt: [INTEGRATION],
  },
  {
    name: "project at work (engagement lifecycle 'active')",
    owners: [ENGAGEMENT_PREDICATES],
    patterns: [/lifecycle\W*=\s*'active'/, /lifecycle,\s*['"]active['"]/],
    use: "projectActive or projectAtWork from @ashara/engagement/predicates",
    exempt: [INTEGRATION],
  },
  {
    name: "first plan told",
    owners: [ENGAGEMENT_PREDICATES],
    patterns: [/reports_on\s*=\s*'first-plan'/],
    use: "firstPlanTold or firstPlanUnreported from @ashara/engagement/predicates",
    exempt: [INTEGRATION],
  },
  {
    // A hand-written list or chain of statuses drifts from the partition when the vocabulary grows.
    // Workplace's session phases share two words with it and name another vocabulary.
    name: "work-item status list (open or settled)",
    owners: ["packages/delivery/src/work-item-language/"],
    patterns: [new RegExp(`${STATUS_LITERAL}\\s*,\\s*${STATUS_LITERAL}`), new RegExp(`${STATUS_COMPARISON}[^;{}]*?${STATUS_COMPARISON}`)],
    use: "OPEN_WORK_ITEM_STATUSES or SETTLED_WORK_ITEM_STATUSES from @ashara/delivery/work-item, or a named subset derived from one",
    exempt: ["packages/integration/src/simulator/", "packages/workplace/src/session-vocabulary.ts"],
  },
  {
    name: "an attempt's model grade (the model catalog read outside Finance)",
    owners: MODEL_CATALOG_OWNERS,
    patterns: [/\b(?:join|from)\s+model_configs\b/i, /\b(?:leftJoin|innerJoin|rightJoin|fullJoin|join|from)\(\s*modelConfigs\b/],
    use: "attemptGrade from @ashara/finance",
    exempt: [INTEGRATION],
  },
  {
    name: "the latest stored check revision",
    owners: [QUALITY_STORED_CHECKS],
    patterns: [/max\(\s*(?:\w+\.)?revision\s*\).*\bfrom\s+task_checks\b/i, /max\(\s*taskChecks\.revision\s*\)/],
    use: "latestCheckRevision or inLatestCheckRevision from @ashara/quality/stored-checks",
    exempt: [INTEGRATION],
  },
  {
    name: "the stored check decides schema",
    owners: [QUALITY_STORED_CHECKS],
    patterns: [/\b\w*Decides\w*\s*=\s*z\./],
    use: "StoredDecidesSchema from @ashara/quality/stored-checks",
    exempt: [INTEGRATION],
  },
  {
    name: "a report subject (client_messages.reports_on)",
    owners: [ENGAGEMENT_REPORT_SUBJECTS],
    // A literal a report's subject is compared with, stored as or named by; the same words name the
    // core loop's contained steps (shared ContainedStep), which are another vocabulary and not read.
    patterns: [
      /reports_?[oO]n\b.*['"`](?:first-plan|planning-stopped|client-stop|contract-draft|stack-choice)['"`]/,
      /\bsubject\w*\s*(?:===?|!==?|=|:)\s*['"`](?:first-plan|planning-stopped|client-stop|contract-draft|stack-choice)['"`]/i,
      /\b(?:type|interface)\s+PlanReportSubject\b/,
    ],
    use: "REPORT_SUBJECT or PlanReportSubject from @ashara/engagement/report-subjects",
    exempt: [INTEGRATION],
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

function under(file: string, prefix: string): boolean {
  return file === prefix || (prefix.endsWith("/") && file.startsWith(prefix));
}

/** The copies in one file's text, `file` repository-relative. */
function findPredicateCopiesIn(file: string, content: string): PredicateCopy[] {
  const copies: PredicateCopy[] = [];
  const code = content.split("\n").map((text) => (COMMENT_LINE.test(text) ? "" : text)).join("\n");
  for (const rule of PREDICATE_RULES) {
    if (rule.owners.some((owner) => under(file, owner)) || rule.exempt.some((prefix) => under(file, prefix))) continue;
    const hits = new Map<number, string>();
    for (const pattern of rule.patterns) {
      for (const match of code.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
        const start = code.lastIndexOf("\n", match.index) + 1;
        const end = code.indexOf("\n", match.index);
        hits.set(code.slice(0, match.index).split("\n").length, code.slice(start, end === -1 ? code.length : end).trim());
      }
    }
    for (const [line, text] of [...hits].sort(([a], [b]) => a - b)) copies.push({ file, line, rule: rule.name, text, use: rule.use });
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

/** Every copy under `root`/packages/<pkg>/src, each rule's exempt paths aside. */
export function findPredicateCopies(root: string): PredicateCopy[] {
  const packagesDir = path.join(root, "packages");
  const files = fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => productionFiles(path.join(packagesDir, entry.name, "src")));
  if (files.length === 0) throw new NoSourceToScan(packagesDir);
  return files.flatMap((full) => findPredicateCopiesIn(path.relative(root, full).split(path.sep).join("/"), fs.readFileSync(full, "utf-8")));
}
