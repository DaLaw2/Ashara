import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { findPredicateCopies } from "./predicate-copies.js";

const REPO = path.join(import.meta.dirname, "..");

/** One raw copy per rule, each on its own line, as a reader outside the owner would write it. */
const PLANTED = [
  "const a = sql`NOT (w.status = 'Abandoned' AND w.blocked_reason->>'source' = 'superseded')`;",
  "const b = sql`w.level = 'Task' AND w.status <> 'Abandoned'`;",
  "const c = sql`${workItems.taskSpec}->>'origin' = 'product-scaffold'`;",
  "const d = sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = x AND p.lifecycle = 'active')`;",
  "const e = sql`EXISTS (SELECT 1 FROM client_messages m WHERE m.reports_on = 'first-plan')`;",
  "// a comment naming p.lifecycle = 'active' decides nothing",
].join("\n");

/** One raw copy per shape of the model grade, the latest check revision, the decides schema and a report subject, each on its own line. */
const PLANTED_OWNED = [
  "const f = sql`(SELECT m.capability FROM dev_sessions s LEFT JOIN model_configs m ON m.model_id = s.attempt_model)`;",
  ".leftJoin(modelConfigs, eq(modelConfigs.modelId, devSessions.attemptModel))",
  "const g = sql`${taskChecks.revision} = (SELECT max(latest.revision) FROM task_checks latest WHERE latest.task_id = ${taskChecks.taskId})`;",
  "const [h] = await db.select({ revision: max(taskChecks.revision) }).from(taskChecks);",
  "const StoredDecidesSchema = z.array(z.string().min(1)).min(1).nullable();",
  'await tx.insert(clientMessages).values({ reportsOn: "contract-draft" });',
  'if (due.subject === "planning-stopped") return;',
  'type PlanReportSubject = "first-plan" | "planning-stopped";',
  'const step = await this.step("client-stop", () => deps.clientStops.runPending());',
].join("\n");

const MODEL_GRADE = "an attempt's model grade (the model catalog read outside Finance)";
const LATEST_REVISION = "the latest stored check revision";
const DECIDES_SCHEMA = "the stored check decides schema";
const REPORT_SUBJECT = "a report subject (client_messages.reports_on)";

let scratch: string | null = null;

afterEach(() => {
  if (scratch !== null) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/** A tree holding `files` (repository-relative path -> text) under a fresh temporary root. */
function treeOf(files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "predicate-copies-"));
  scratch = root;
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

describe("findPredicateCopies", () => {
  test("a copy of each rule planted in an Engagement file is reported, with its line; a comment is not", () => {
    const root = treeOf({ "packages/engagement/src/planted.ts": PLANTED });
    expect(findPredicateCopies(root).map((copy) => [copy.file, copy.line, copy.rule])).toEqual([
      ["packages/engagement/src/planted.ts", 1, "superseded"],
      ["packages/engagement/src/planted.ts", 2, "current plan, given-up tasks left out"],
      ["packages/engagement/src/planted.ts", 3, "task origin (goal task, product scaffold, review, ...)"],
      ["packages/engagement/src/planted.ts", 4, "project at work (engagement lifecycle 'active')"],
      ["packages/engagement/src/planted.ts", 5, "first plan told"],
      ["packages/engagement/src/planted.ts", 5, REPORT_SUBJECT],
    ]);
  });

  test("a copy of each shape of the model grade, the latest check revision, the decides schema and a report subject is reported, with its line; a contained step's name is not", () => {
    const root = treeOf({ "packages/delivery/src/planted.ts": PLANTED_OWNED });
    expect(findPredicateCopies(root).map((copy) => [copy.line, copy.rule])).toEqual([
      [1, MODEL_GRADE],
      [2, MODEL_GRADE],
      [3, LATEST_REVISION],
      [4, LATEST_REVISION],
      [5, DECIDES_SCHEMA],
      [6, REPORT_SUBJECT],
      [7, REPORT_SUBJECT],
      [8, REPORT_SUBJECT],
    ]);
  });

  test("each owner may spell its own rule: Finance and Model Access the catalog read, Quality's stored checks the revision and schema, Engagement's vocabulary the subjects", () => {
    const root = treeOf({
      "packages/finance/src/attempt-grade.ts": PLANTED_OWNED,
      "packages/model-access/src/catalog.ts": PLANTED_OWNED,
      "packages/quality/src/stored-checks.ts": PLANTED_OWNED,
      "packages/engagement/src/report-subjects.ts": PLANTED_OWNED,
    });
    const copies = findPredicateCopies(root);
    const rulesIn = (file: string) => new Set(copies.filter((copy) => copy.file === file).map((copy) => copy.rule));
    expect(rulesIn("packages/finance/src/attempt-grade.ts")).toEqual(new Set([LATEST_REVISION, DECIDES_SCHEMA, REPORT_SUBJECT]));
    expect(rulesIn("packages/model-access/src/catalog.ts")).toEqual(new Set([LATEST_REVISION, DECIDES_SCHEMA, REPORT_SUBJECT]));
    expect(rulesIn("packages/quality/src/stored-checks.ts")).toEqual(new Set([MODEL_GRADE, REPORT_SUBJECT]));
    expect(rulesIn("packages/engagement/src/report-subjects.ts")).toEqual(new Set([MODEL_GRADE, LATEST_REVISION, DECIDES_SCHEMA]));
  });

  test("Quality's repositories own neither the latest revision nor the decides schema: only its stored-checks module does", () => {
    const root = treeOf({ "packages/quality/src/repositories/task-check.ts": PLANTED_OWNED });
    expect(new Set(findPredicateCopies(root).map((copy) => copy.rule))).toEqual(new Set([MODEL_GRADE, LATEST_REVISION, DECIDES_SCHEMA, REPORT_SUBJECT]));
  });

  test("the owner of each rule may spell it: the same lines in the owners' files report only the other context's rules", () => {
    const root = treeOf({
      "packages/delivery/src/predicates.ts": PLANTED,
      "packages/engagement/src/predicates.ts": PLANTED,
    });
    expect(findPredicateCopies(root).map((copy) => [copy.file, copy.rule])).toEqual([
      ["packages/delivery/src/predicates.ts", "project at work (engagement lifecycle 'active')"],
      ["packages/delivery/src/predicates.ts", "first plan told"],
      ["packages/delivery/src/predicates.ts", REPORT_SUBJECT],
      ["packages/engagement/src/predicates.ts", "superseded"],
      ["packages/engagement/src/predicates.ts", "current plan, given-up tasks left out"],
      ["packages/engagement/src/predicates.ts", "task origin (goal task, product scaffold, review, ...)"],
      ["packages/engagement/src/predicates.ts", REPORT_SUBJECT],
    ]);
  });

  test("test files, and the integration package for the cross-context rules, are not read; a tree with no production source fails closed", () => {
    expect(findPredicateCopies(treeOf({ "packages/engagement/src/planted.test.ts": PLANTED, "packages/integration/src/oracle.ts": PLANTED, "packages/shared/src/x.ts": "" }))).toEqual([]);
    expect(() => findPredicateCopies(treeOf({ "packages/engagement/src/planted.test.ts": PLANTED }))).toThrow(/a scan of nothing would pass/);
  });

  test("a TypeScript comparison of a task origin outside Delivery is a copy", () => {
    const root = treeOf({ "packages/quality/src/x.ts": 'if (spec.origin === "decomposition") return;' });
    expect(findPredicateCopies(root).map((copy) => copy.rule)).toEqual([
      "task origin (goal task, product scaffold, review, ...)",
    ]);
  });

  test("a hand-written work-item status list outside Delivery's work-item language is a copy, in SQL, a literal or a comparison chain, on one line or split across lines; the language and the simulator oracle may spell one", () => {
    const planted = [
      "const a = sql`${workItems.status} IN ('Pending','Blocked')`;",
      'const b = new Set(["Completed","Abandoned"]);',
      'const c = item.status !== "Completed" && item.status !== "Abandoned";',
      'const d = item.status === "InProgress" || canTransitionTo(item.status, "InProgress");',
      'const e = listIdsByStatus(["InProgress"]);',
      "const f =",
      '  item.status === "Pending" ||',
      '  item.status === "Failed";',
      'const g = ["Pending",',
      '  "Blocked"];',
    ].join("\n");
    const root = treeOf({
      "packages/server/src/planted.ts": planted,
      "packages/delivery/src/domain/planted.ts": planted,
      "packages/integration/src/server/planted.ts": planted,
      "packages/delivery/src/work-item-language/planted.ts": planted,
      "packages/integration/src/simulator/planted.ts": planted,
    });
    const rule = "work-item status list (open or settled)";
    expect(findPredicateCopies(root).map((copy) => `${copy.file}:${copy.line} ${copy.rule}`).sort()).toEqual(
      ["packages/delivery/src/domain/planted.ts", "packages/integration/src/server/planted.ts", "packages/server/src/planted.ts"].flatMap((file) => [1, 2, 3, 7, 9].map((line) => `${file}:${line} ${rule}`)),
    );
  });

  test("a latest check revision whose max() and FROM task_checks a SQL template literal splits across lines is a copy; a revision of another table, or a max() in another literal, is not", () => {
    const planted = [
      "const a = sql`",
      "  SELECT max(stored.revision)",
      "  FROM task_checks stored",
      "  WHERE stored.task_id = ${taskId}`;",
      "const b = sql`SELECT max(r.revision)",
      "  FROM plan_revisions r`;",
      "const c = sql`SELECT max(r.revision) FROM plan_revisions r`; const d = sql`SELECT 1 FROM task_checks t`;",
    ].join("\n");
    const root = treeOf({ "packages/quality/src/repositories/check-set-freeze.ts": planted });
    expect(findPredicateCopies(root).map((copy) => [copy.line, copy.rule])).toEqual([[2, LATEST_REVISION]]);
  });

  test("a report subject compared with reports_on across lines, in SQL or a drizzle eq(), is a copy; a subject in another statement is not", () => {
    const planted = [
      "const a = sql`m.reports_on",
      "  = 'planning-stopped'`;",
      ".where(eq(clientMessages.reportsOn,",
      '  "stack-choice"));',
      "const b = sql`m.reports_on = ${subject}`;",
      'const c = await this.step("client-stop", () => run());',
    ].join("\n");
    const root = treeOf({ "packages/delivery/src/planted.ts": planted });
    expect(findPredicateCopies(root).map((copy) => [copy.line, copy.rule])).toEqual([
      [1, REPORT_SUBJECT],
      [3, REPORT_SUBJECT],
    ]);
  });

  test("every report subject Engagement's vocabulary names is a copy outside it, the decline among them; a subject named lines after the column, past anything but a comparison, is not", () => {
    const planted = [
      "const a = sql`m.reports_on = 'declined'`;",
      'const b = { reportsOn: "declined" };',
      'if (report.subject === "declined") return;',
      "const c = sql`m.reports_on IS NOT NULL",
      "  AND ${this.step('client-stop')}`;",
      "const d = sql`m.reports_on IN ('first-plan', 'declined')`;",
      'const e = { status: "declined" };',
    ].join("\n");
    const root = treeOf({ "packages/delivery/src/planted.ts": planted });
    expect(findPredicateCopies(root).map((copy) => [copy.line, copy.rule])).toEqual([
      [1, REPORT_SUBJECT],
      [2, REPORT_SUBJECT],
      [3, REPORT_SUBJECT],
      [6, REPORT_SUBJECT],
    ]);
  });

  test("an inline subset of the work-item vocabulary outside Delivery's work-item language is a copy, on one line or split across lines; a subset the language names is not", () => {
    const planted = [
      'const a = inArray(workItems.status, OPEN_WORK_ITEM_STATUSES.filter((status) => status !== "InProgress"));',
      'const b = OPEN_WORK_ITEM_STATUSES.includes(item.status) && (item.status !== "InProgress" || item.level === "Epic");',
      "const c =",
      "  OPEN_WORK_ITEM_STATUSES.includes(item.status) &&",
      '  item.status !== "Failed";',
      "const d = WORK_ITEM_STATUSES",
      '  .filter((status) => status !== "Abandoned");',
      'const e = IDLE_OPEN_WORK_ITEM_STATUSES.includes(item.status) || (item.status === "InProgress" && item.level === "Epic");',
      "const f = inArray(workItems.status, IDLE_OPEN_WORK_ITEM_STATUSES);",
    ].join("\n");
    const root = treeOf({ "packages/delivery/src/repositories/replan.ts": planted, "packages/delivery/src/work-item-language/work-item-status.ts": planted });
    expect(findPredicateCopies(root).map((copy) => `${copy.file}:${copy.line}`)).toEqual([1, 2, 4, 6].map((line) => `packages/delivery/src/repositories/replan.ts:${line}`));
  });

  test("Workplace's terminal session phases may spell two status words; another status list in the same file is a copy", () => {
    const vocabulary = [
      'type SessionPhase = "Preparing" | "Completed" | "Failed";',
      "",
      'export const TERMINAL_SESSION_PHASES: readonly SessionPhase[] = ["Completed", "Failed"] as const;',
      'const settled = ["Completed",',
      '  "Abandoned"];',
    ].join("\n");
    const root = treeOf({ "packages/workplace/src/session-vocabulary.ts": vocabulary });
    expect(findPredicateCopies(root).map((copy) => [copy.line, copy.rule])).toEqual([[4, "work-item status list (open or settled)"]]);
  });

  test("the repository holds no copy outside an owner", () => {
    expect(findPredicateCopies(REPO)).toEqual([]);
  });
});
