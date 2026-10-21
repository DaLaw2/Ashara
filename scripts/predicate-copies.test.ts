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
    ]);
  });

  test("the owner of each rule may spell it: the same lines in the owners' files report only the other context's rules", () => {
    const root = treeOf({
      "packages/delivery/src/predicates.ts": PLANTED,
      "packages/engagement/src/predicates.ts": PLANTED,
    });
    expect(findPredicateCopies(root).map((copy) => [copy.file, copy.rule])).toEqual([
      ["packages/delivery/src/predicates.ts", "project at work (engagement lifecycle 'active')"],
      ["packages/delivery/src/predicates.ts", "first plan told"],
      ["packages/engagement/src/predicates.ts", "superseded"],
      ["packages/engagement/src/predicates.ts", "current plan, given-up tasks left out"],
      ["packages/engagement/src/predicates.ts", "task origin (goal task, product scaffold, review, ...)"],
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

  test("the repository holds no copy outside an owner", () => {
    expect(findPredicateCopies(REPO)).toEqual([]);
  });
});
