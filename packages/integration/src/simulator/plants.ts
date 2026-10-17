import type { ContendedWaitKind } from "@ashara/shared";
import { pendingUncounted } from "./admissions.js";
import { intakeSecondReadingDropped } from "./intake-plants.js";
import { pinInfrastructureFaults, skipDispatchRefund, skipMergeRecord, throwingActiveListing, unrecordedStepFault } from "./faults.js";
import type { QueryPlant } from "./faults.js";
import { ledgerDrawSkipped, reviewCountReset, reviewLoopUnbounded, suiteReviewBoundIgnored } from "./loop-plants.js";
import {
  briefMisstatesStanding,
  checkSetSkipsItem,
  deliveredReportMisquotesInterface,
  deliveredReportMisstatesStanding,
  deliveredReportOmitsUnverified,
  deliveredReportMisstatesUnchecked,
  deliveredReportOmitsGoal,
  deliveredReportOmitsUncoveredOfSkippedItem,
  deliveredReportUnrecorded,
  haltReportFixedCause,
  questionMisstatesAssumption,
  stopReportOmitsMerge,
  unconfirmedClaimDropped,
} from "./report-plants.js";
import { abandonedReleaseSkipped } from "./residue.js";

/**
 * A plant at a seam: the run must catch it, so a green invariant is not a blind one.
 * - skip-merge-record: every merge recorded under a commit main does not hold (I7, records clause);
 * - no-checkout-lock: a task waiting for the target checkout goes on at once (I7, merge-queue clause);
 * - no-admission-queue: a spend-cap admission goes on without waiting for the ones ahead of it (I5,
 *   admission clause). Planted on a run of two projects, where only the deployment's check stands
 *   between them. An admission's own estimate is a row written
 *   after the project's check, an await later; whether one project now catches it too: unverified;
 * - pending-uncounted: a spend-cap admission's read leaves out the pending rows of calls admitted
 *   and not yet recorded, so it counts the recorded spend alone (I5, admission clause);
 * - infrastructure-fault-pinned: a task's infrastructure faults stop counting at the halt (I8);
 * - halt-report-fixed-cause: a halt's report states a fixed cause, not the recorded one (I4);
 * - stop-report-omits-merge: the stop report leaves out a merge on record (I4);
 * - delivered-report-omits-goal, delivered-report-misstates-unchecked: the delivered report leaves
 *   out a goal's close, or states the wrong tasks as not checked by a stored check (I4);
 * - delivered-report-omits-uncovered: on a check set stored with a cited item undecided
 *   (check-set-skips-item), the delivered report leaves out an asked-for item no stored check
 *   decides (I4; I6 names the undecided item);
 * - delivered-report-unrecorded: the delivered report is posted but not recorded on its sweep, so
 *   it is posted again (I4, exactly once);
 * - brief-misstates-standing: a brief's text calls an assumption asked about Stated by the client
 *   (I9);
 * - delivered-report-misstates-standing: on a check set stored with a cited item undecided
 *   (check-set-skips-item), the delivered report says an assumption the client was asked about was
 *   reported to them (I9; I6 names the undecided item);
 * - delivered-report-omits-unverified: the delivered report leaves out an internal-design
 *   assumption it must name as not verified by Ashara (I4);
 * - delivered-report-misquotes-interface: the delivered report's how-to-run section is not the
 *   public interface file main holds, or misstates its absence (I9);
 * - question-misstates-assumption: a question says work proceeds on an assumption its vision does
 *   not record (I9);
 * - unconfirmed-claim-dropped: a clean review's claim no second opinion confirmed leaves no item
 *   undecided, so the delivered report calls those items decided by a stored check (I6);
 * - intake-second-reading-dropped: a tender reading that asks the client nothing goes on with no
 *   second reading asked, recorded as another family's agreement (I3); caught
 *   under the lazy intake persona;
 * - check-set-skips-item: a check set is stored with one item its check task cites decided by none
 *   of its checks, past Z0's rule, so that item is accepted with no stored check deciding it, though
 *   an acceptance line still cites it (I6);
 * - dispatch-refund-skipped: a dispatch refund gives nothing back, so an attempt stopped by a
 *   substrate fault before its agent worked stays charged (I10);
 * - step-fault-unrecorded: a contained subject's fault cannot be kept, so containEach throws it
 *   through as if no step contained anything: one project's unreadable rows fail every project's
 *   cycle (I1:cycle-error, and I8 on the healthy project of the corruption scenario, run.ts);
 * - active-listing-throws: the listing of dispatchable projects throws on every cycle with no fault
 *   beneath it (I1:cycle-error);
 * - abandoned-release-skipped: the release of settled tasks' host holdings leaves out the Abandoned
 *   ones, so a given-up task's branch and worktree slot stay (I7, residue clause);
 * - ledger-draw-skipped: the work ledger reads no request as drawn, so no task or project is
 *   refused for its spent requests (W1);
 * - review-count-reset: a review drops its earlier findings as it records new ones, so its rounds
 *   leave no count that grows (W2);
 * - suite-review-bound-ignored: the reviews naming a check task are read as at most one, so a check
 *   task is reopened on every review that names it (W3, and W2's bound clause);
 * - review-loop-unbounded: both of the last two and the ledger's: the review loop has no exit at all
 *   (W4 under the liveness profile, and W1).
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
  "delivered-report-omits-unverified",
  "delivered-report-misquotes-interface",
  "question-misstates-assumption",
  "unconfirmed-claim-dropped",
  "intake-second-reading-dropped",
  "check-set-skips-item",
  "dispatch-refund-skipped",
  "step-fault-unrecorded",
  "active-listing-throws",
  "abandoned-release-skipped",
  "ledger-draw-skipped",
  "review-count-reset",
  "suite-review-bound-ignored",
  "review-loop-unbounded",
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
  "delivered-report-omits-uncovered": { bypassed: [], queries: deliveredReportOmitsUncoveredOfSkippedItem, code: null },
  "delivered-report-unrecorded": { bypassed: [], queries: deliveredReportUnrecorded, code: null },
  "brief-misstates-standing": { bypassed: [], queries: briefMisstatesStanding, code: null },
  "delivered-report-misstates-standing": { bypassed: [], queries: deliveredReportMisstatesStanding, code: null },
  "delivered-report-omits-unverified": { bypassed: [], queries: deliveredReportOmitsUnverified, code: null },
  "delivered-report-misquotes-interface": { bypassed: [], queries: deliveredReportMisquotesInterface, code: null },
  "question-misstates-assumption": { bypassed: [], queries: questionMisstatesAssumption, code: null },
  "unconfirmed-claim-dropped": { bypassed: [], queries: unconfirmedClaimDropped, code: null },
  "intake-second-reading-dropped": { bypassed: [], queries: null, code: intakeSecondReadingDropped },
  "check-set-skips-item": { bypassed: [], queries: checkSetSkipsItem, code: null },
  "dispatch-refund-skipped": { bypassed: [], queries: skipDispatchRefund, code: null },
  "step-fault-unrecorded": { bypassed: [], queries: unrecordedStepFault, code: null },
  "active-listing-throws": { bypassed: [], queries: throwingActiveListing, code: null },
  "abandoned-release-skipped": { bypassed: [], queries: abandonedReleaseSkipped, code: null },
  "ledger-draw-skipped": { bypassed: [], queries: ledgerDrawSkipped, code: null },
  "review-count-reset": { bypassed: [], queries: reviewCountReset, code: null },
  "suite-review-bound-ignored": { bypassed: [], queries: suiteReviewBoundIgnored, code: null },
  "review-loop-unbounded": { bypassed: [], queries: reviewLoopUnbounded, code: null },
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
