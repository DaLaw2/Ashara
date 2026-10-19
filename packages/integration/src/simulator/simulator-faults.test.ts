import { describe, expect, it } from "vitest";
import { TRANSPORT_RESPONSES } from "./faults.js";
import { directed, draw, fault, keys, statements, useSimulatorDatabase } from "./simulator-harness.js";
import type { Direction } from "./tape.js";

/*
 * The directed tier's faults on the database, the host and the model transport (simulator-harness.ts
 * directed): production meets each forced fault and passes every invariant.
 * The directed tier's faults are split across the simulator-faults*.test.ts files so vitest runs
 * them on separate workers; the plants the invariants must catch are the simulator-plants*.test.ts
 * files.
 */
useSimulatorDatabase();

/**
 * The db layer's attempts per statement or transaction on a concurrent-update conflict (db
 * connection.ts CONFLICT_ATTEMPTS), restated because the simulator imports only reviewed names. A
 * bound changed there fails the directed tests below that count on it.
 */
const CONFLICT_ATTEMPTS = 5;

describe("lifecycle simulator, directed", () => {
  // The first BEGIN fails with a 40001. The transaction wrapper (db
  // connection.ts) releases the connection whose BEGIN failed, so no checkout outlives the process.
  it("releases the connection of a failed BEGIN, leaving none checked out", async (ctx) => {
    const result = await directed(ctx, [{ kind: "fault", seam: "db", label: "begin", nth: 1, fault: "db-query-failed" }]);
    expect(result.faults.map((f) => `${f.label}:${f.fault}`)).toEqual(["begin:db-query-failed"]);
    expect(keys(result)).toEqual([]);
  }, 90_000);

  // A 40001 on the roster read that staffs the first attempt (assignAgent), on one send fewer than
  // the db layer's conflict bound, which is one more than the task's fault budget. The statement was
  // rolled back on its own and is sent again, so the conflict never reaches dispatch as a fault: no
  // requeue, no fault counted on the task, no AsharaFaultBudgetSpent halt. The run's first two roster
  // reads are the roster and first-plan steps'; staffing's follow.
  it("absorbs a serialization failure on the roster read that staffs an attempt, never spending the task's fault budget", async (ctx) => {
    const rosterRead = /^select "?revision"? from "?roster_roles/;
    const conflicts = Array.from({ length: CONFLICT_ATTEMPTS - 1 }, (_, index) => ({ kind: "fault", seam: "db", label: rosterRead, nth: index + 3, fault: "db-query-failed" }) as const);
    const result = await directed(ctx, conflicts);
    expect(result.faults.map((f) => `${f.seam}:${f.fault}`)).toEqual(conflicts.map(() => "db:db-query-failed"));
    expect(result.log.filter((line) => line.includes("met a concurrent-update conflict (SQLSTATE 40001)"))).toHaveLength(conflicts.length);
    const faulted = (text: string): boolean => text.includes("stage assignAgent") || text.includes("infrastructure fault") || text.includes("AsharaFaultBudgetSpent");
    expect(result.log.filter(faulted)).toEqual([]);
    expect(result.records.map((r) => JSON.stringify(r)).filter(faulted)).toEqual([]);
    expect(result.asharaHalts).toEqual([]);
    expect(result.outcome.kind).toBe("accepted");
    expect(keys(result), statements(result)).toEqual([]);
  }, 90_000);

  /** A crash in the implementation's dispatch, which leaves its task InProgress for the next startup. */
  const CRASH_IN_DISPATCH: Direction = { kind: "fault", seam: "git", label: "ls-tree", nth: 2, fault: "crash-before" };

  // A crash in a dispatch leaves its task InProgress (its orphan), then a 40001 on the startup
  // reconciler's dev_sessions read of that orphan on every send the db layer's conflict retry makes,
  // so the read fails. The reconciler retries the requeue within its bound, so the orphan is never
  // left InProgress.
  it("retries a failed requeue of an orphan, never leaving it InProgress while the process lives", async (ctx) => {
    const devSessionsCount = /^select count\(\*\) from "dev_sessions"/;
    const conflicts = Array.from({ length: CONFLICT_ATTEMPTS }, (_, index) => ({ kind: "fault", seam: "db", label: devSessionsCount, nth: index + 2, fault: "db-query-failed" }) as const);
    const result = await directed(ctx, [CRASH_IN_DISPATCH, ...conflicts]);
    expect(result.faults.map((f) => `${f.seam}:${f.fault}`)).toEqual(["git:crash-before", ...conflicts.map(() => "db:db-query-failed")]);
    expect(
      result.records.some(
        (r) => r.event === "delivery.orphan-settle-failed" && r.level === "warn" && r.fields?.["step"] === "requeue the task" && r.fields["attempt"] === 1,
      ),
    ).toBe(true);
    expect(keys(result)).toEqual([]);
  }, 90_000);

  // The crash loop's early stop (startup-reconciler.ts CRASH_LOOP_BOUND): the task's
  // dispatch dies, and its re-dispatch dies again right after the task is set InProgress. The second
  // startup to find it InProgress gives it up as crash_loop instead of dispatching it a third time.
  it("gives up a task found InProgress at two startups in a row as a crash loop, never re-dispatching it", async (ctx) => {
    const result = await directed(ctx, [
      CRASH_IN_DISPATCH,
      { kind: "fault", seam: "db", label: /^update "work_items" set "status" = \$1, "blocked_reason" = \$2/, nth: 5, fault: "crash-after" },
    ]);
    expect(result.faults.map((f) => `${f.seam}:${f.fault}`)).toEqual(["git:crash-before", "db:crash-after"]);
    expect(result.records.some((r) => r.event === "delivery.task-given-up" && r.fields?.["source"] === "crash_loop")).toBe(true);
    expect(keys(result), statements(result)).toEqual([]);
  }, 90_000);

  // The process dies on the
  // merge-record write right after the merge commit landed on main (Quality merge.ts
  // commitMerge, then orchestrator execution.ts writes the record). The startup reconciler reads
  // main before it requeues an orphan, and records the merge it finds instead of dispatching the
  // merged work again.
  it("records a merge on main whose record a crash lost, never re-dispatching it", async (ctx) => {
    const result = await directed(ctx, [{ kind: "fault", seam: "db", label: /^update "work_items" set "merge_commit" = \$1/, nth: 1, fault: "crash-before" }]);
    expect(result.faults.map((f) => `${f.seam}:${f.fault}`)).toEqual(["db:crash-before"]);
    expect(result.records.some((r) => r.event === "delivery.orphan-merged" && typeof r.fields?.["mergeCommit"] === "string")).toBe(true);
    expect(keys(result)).toEqual([]);
  }, 90_000);

  // Two simulated git index.lock failures fail the substrate gate's cell start. The fault is
  // requeued uncharged and the next dispatch completes it, never parking the task for an operator.
  it("requeues a task whose cell could not start, never parks it for a person", async (ctx) => {
    const result = await directed(ctx, [
      { kind: "fault", seam: "git", label: "add", nth: 6, fault: "git-failed" },
      { kind: "fault", seam: "git", label: "commit-tree", nth: 4, fault: "git-failed" },
    ]);
    expect(result.faults.map((f) => `${f.seam}:${f.fault}`)).toEqual(["git:git-failed", "git:git-failed"]);
    expect(result.trace).toContain("cycle 1: 1 task(s) [interrupted]");
    expect(keys(result)).toEqual([]);
    expect(result.outcome.kind).toBe("accepted");
  }, 90_000);

  // The fake transport answers the first model call (the tender's intake read) with each status. A
  // 4xx rejecting the request as Ashara built it is Ashara's: never counted against the read (I10),
  // contained to its tender and retried. A reset, a 429 or a 5xx is the provider's, counted against it.
  for (const [index, response] of TRANSPORT_RESPONSES.entries()) {
    it(`answers a transport ${response.status ?? "reset"} as ${response.owner === "ashara" ? "Ashara's" : "the provider's"}, charging only what is the provider's`, async (ctx) => {
      const result = await directed(ctx, [fault("model", /./, "provider-error"), draw(/^fault\.model:.*\.response$/, 1, index)]);
      expect(result.faults.map((f) => `${f.fault}:${f.response?.status ?? "reset"}`)).toEqual([`provider-error:${response.status ?? "reset"}`]);
      const blamed = response.owner === "ashara" ? "(a fault on Ashara's side)" : "(the provider failed the request)";
      expect(result.log.some((line) => line.includes(blamed)), result.log.join("\n")).toBe(true);
      expect(keys(result), statements(result)).toEqual([]);
    }, 90_000);
  }
});
