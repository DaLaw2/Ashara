import type { ContendedWaitKind } from "@ashara/shared";
import { pendingUncounted } from "./admissions.js";
import { pinInfrastructureFaults, skipMergeRecord } from "./faults.js";
import type { QueryPlant } from "./faults.js";
import {
  briefMisstatesStanding,
  deliveredReportMisquotesInterface,
  deliveredReportMisstatesStanding,
  deliveredReportMisstatesUnchecked,
  deliveredReportOmitsGoal,
  deliveredReportOmitsUncovered,
  deliveredReportUnrecorded,
  haltReportFixedCause,
  questionMisstatesAssumption,
  stopReportOmitsMerge,
} from "./report-plants.js";

/**
 * A plant at a seam (L3 acceptance): the run must catch it, so a green invariant is not a blind one.
 * - skip-merge-record: every merge recorded under a commit main does not hold (I7, records clause);
 * - no-checkout-lock: a task waiting for the target checkout goes on at once (I7, merge-queue clause);
 * - no-admission-queue: a spend-cap admission goes on without waiting for the ones ahead of it (I5,
 *   admission clause). Planted on a run of two projects, where only the deployment's check stands
 *   between them (baseline §7.6). Since migration 053 an admission's own estimate is a row written
 *   after the project's check, an await later; whether one project now catches it too: unverified;
 * - pending-uncounted: a spend-cap admission's read leaves out the pending rows of calls admitted
 *   and not yet recorded, so it counts the recorded spend alone (I5, admission clause);
 * - infrastructure-fault-pinned: a task's infrastructure faults stop counting at the halt (I8);
 * - halt-report-fixed-cause: a halt's report states a fixed cause, not the recorded one (I4);
 * - stop-report-omits-merge: the stop report leaves out a merge on record (I4);
 * - delivered-report-omits-goal, delivered-report-misstates-unchecked: the delivered report leaves
 *   out a goal's close, or states the wrong tasks as not checked by a stored check (I4);
 * - delivered-report-omits-uncovered: the delivered report leaves out an asked-for item no
 *   acceptance line of a swept check task cites (I4, W11c D3);
 * - delivered-report-unrecorded: the delivered report is posted but not recorded on its sweep, so
 *   it is posted again (I4, exactly once);
 * - brief-misstates-standing: a brief's text calls an assumption asked about Stated by the client
 *   (I9, W12a D1's class);
 * - delivered-report-misstates-standing: the delivered report says an assumption the client was
 *   asked about was reported to them (I9, smoke2 D1's class);
 * - delivered-report-misquotes-interface: the delivered report's how-to-run section is not the
 *   public interface file main holds, or misstates its absence (I9, smoke2 D3's class);
 * - question-misstates-assumption: a question says work proceeds on an assumption its vision does
 *   not record (I9).
 */
export const MUTATIONS = [
  "skip-merge-record",
  "no-checkout-lock",
  "no-admission-queue",
  "pending-uncounted",
  "infrastructure-fault-pinned",
  "halt-report-fixed-cause",
  "stop-report-omits-merge",
  "delivered-report-omits-goal",
  "delivered-report-misstates-unchecked",
  "delivered-report-omits-uncovered",
  "delivered-report-unrecorded",
  "brief-misstates-standing",
  "delivered-report-misstates-standing",
  "delivered-report-misquotes-interface",
  "question-misstates-assumption",
] as const;
export type Mutation = (typeof MUTATIONS)[number];

interface Plant {
  readonly bypassed: readonly ContendedWaitKind[];
  readonly queries: QueryPlant | null;
  /** Patches production code for the run; returns what undoes it. */
  readonly code: (() => () => void) | null;
}

/** The contended wait each mutation skips, the queries it rewrites, and the code it patches. */
export const PLANTED: Readonly<Record<Mutation, Plant>> = {
  "skip-merge-record": { bypassed: [], queries: skipMergeRecord, code: null },
  "no-checkout-lock": { bypassed: ["target-checkout"], queries: null, code: null },
  "no-admission-queue": { bypassed: ["spend-admission"], queries: null, code: null },
  "pending-uncounted": { bypassed: [], queries: pendingUncounted, code: null },
  "infrastructure-fault-pinned": { bypassed: [], queries: pinInfrastructureFaults, code: null },
  "halt-report-fixed-cause": { bypassed: [], queries: haltReportFixedCause, code: null },
  "stop-report-omits-merge": { bypassed: [], queries: stopReportOmitsMerge, code: null },
  "delivered-report-omits-goal": { bypassed: [], queries: deliveredReportOmitsGoal, code: null },
  "delivered-report-misstates-unchecked": { bypassed: [], queries: deliveredReportMisstatesUnchecked, code: null },
  "delivered-report-omits-uncovered": { bypassed: [], queries: deliveredReportOmitsUncovered, code: null },
  "delivered-report-unrecorded": { bypassed: [], queries: deliveredReportUnrecorded, code: null },
  "brief-misstates-standing": { bypassed: [], queries: briefMisstatesStanding, code: null },
  "delivered-report-misstates-standing": { bypassed: [], queries: deliveredReportMisstatesStanding, code: null },
  "delivered-report-misquotes-interface": { bypassed: [], queries: deliveredReportMisquotesInterface, code: null },
  "question-misstates-assumption": { bypassed: [], queries: questionMisstatesAssumption, code: null },
};

/** A sent value as text, to tell a rewritten parameter from the one sent; a bigint is not JSON. */
function sentForm(value: unknown): string {
  return JSON.stringify(value, (_, inner: unknown) => (typeof inner === "bigint" ? `${inner}n` : inner)) ?? String(value);
}

/** Whether `plant` would change what `args` sends: the query reaches the seam the plant acts on. */
function rewrites(plant: QueryPlant, args: readonly unknown[]): boolean {
  const planted = plant(args);
  if (planted === null) return false;
  if (planted.length !== args.length) return true;
  return planted.some((value, index) => value !== args[index] && sentForm(value) !== sentForm(args[index]));
}

const QUERY_PLANTS = MUTATIONS.flatMap((mutation) => {
  const queries = PLANTED[mutation].queries;
  return queries === null ? [] : [{ mutation, queries }];
});

/**
 * The plants whose seam one production query reaches (the coverage floor's `plants`): each query
 * plant that would rewrite it. A soak that never sends such a query never gives the plant a chance
 * to be caught, so its mutation test would be the only run that reaches it.
 */
export function plantSeamsOf(args: readonly unknown[], skip: ReadonlySet<string>): Mutation[] {
  return QUERY_PLANTS.filter((plant) => !skip.has(plant.mutation) && rewrites(plant.queries, args)).map((plant) => plant.mutation);
}

/** The plants that skip a contended wait of `kind`: a run that met the wait reached their seam. */
export function plantsBypassing(kind: ContendedWaitKind): Mutation[] {
  return MUTATIONS.filter((mutation) => PLANTED[mutation].bypassed.includes(kind));
}
