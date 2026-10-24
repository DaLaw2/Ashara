import { createDomainEvent } from "@ashara/shared";
import type { SuiteReviewProblem } from "../acl/quality-acl.js";
import { HELD_SET_RULE, heldSetRuleText } from "../acl/workplace-acl.js";
import { InvalidStatusTransition, canTransitionTo } from "../work-item-language/transitions.js";
import type { WorkItemStatus } from "../work-item-language/work-item-status.js";
import type { WorkItem } from "./work-item.js";
import { giveUpWorkItem } from "./work-item.js";

/**
 * How many times a check task writes a task's checks again, after its first write, before a task
 * whose checks went stale once more is given up and its plan repaired. Each rewrite is a new
 * revision of the task's checks: a stale revision up to `CHECK_REWRITE_BOUND` reopens the check
 * task, and the revision its last rewrite stores, `CHECK_REWRITE_BOUND + 1`, gives the task up when
 * it goes stale.
 */
const CHECK_REWRITE_BOUND = 2;

/** An implementation task's stored checks no longer hold the red-run rule on their baseline in its dispatch's environment. */
interface StaleChecks {
  readonly checkTaskId: string;
  /** The stale revision: 1 is the check task's first write, each rewrite adds one. */
  readonly revision: number;
  /** The red run on the current environment, for the check author and the repair's planner. */
  readonly detail: string;
}

type StaleChecksExit =
  /** The check task is reopened (Completed -> Pending) and the task waits on it at Pending. */
  | { readonly kind: "rewrite" }
  /** The task is given up with a checks_rewrite_bound reason. */
  | { readonly kind: "bound" }
  /** The named check task cannot be reopened; the task is given up with a checks_stale reason. */
  | { readonly kind: "unreopenable"; readonly why: string };

/**
 * Reopens a Completed check task so it writes the checks of the task it decides again. Pinned to a
 * Completed item of work kind "check": a reopened implementation task would merge its work twice.
 * Why it is reopened (`detail`) is left as the next attempt's context, the way a replan leaves it.
 */
function reopenCheckTask(
  item: WorkItem,
  checkedTaskId: string,
  detail: string,
  raw: Record<string, unknown>,
  // open-by-design: the event names why the check task was reopened, per cause
  why: Record<string, unknown>,
): void {
  if (item.status !== "Completed" || item.workKind !== "check" || !canTransitionTo(item.status, "Pending")) {
    throw new InvalidStatusTransition(item.id, item.status, "Pending");
  }
  item.status = "Pending";
  item.blockedReason = {
    source: "replan",
    replanContext: { attempt: item.dispatchCount, detail, raw: { checkedTaskId, ...raw } },
  };
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.reopened", "delivery", {
      work_item_id: item.id,
      level: item.level,
      checked_task_id: checkedTaskId,
      ...why,
    }),
  );
}

/**
 * Returns an InProgress implementation task to Pending to wait on its reopened check task: its
 * dependency on that task keeps it from the gate until the check task is Completed again, which
 * is only after the new revision is stored. If the check task is Abandoned instead, its project
 * awaits a plan repair, which supersedes this task. Not a requeue (nothing crashed) and not a replan
 * (nothing failed): it has its own event.
 */
function awaitRewrittenChecks(
  item: WorkItem,
  checkTaskId: string,
  // open-by-design: the event names why the checks are written again, per cause
  why: Record<string, unknown>,
): void {
  if (item.status !== "InProgress" || !canTransitionTo(item.status, "Pending")) {
    throw new InvalidStatusTransition(item.id, item.status, "Pending");
  }
  item.status = "Pending";
  item.blockedReason = undefined;
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.awaiting_checks", "delivery", {
      work_item_id: item.id,
      level: item.level,
      check_task_id: checkTaskId,
      ...why,
    }),
  );
}

/**
 * The exit of an InProgress implementation task whose stored checks went stale. Within the bound
 * the check task it names is reopened and the task waits on it; past the bound, or when that
 * check task cannot be reopened (missing, not a check task, not Completed), the task is given up
 * with a reason naming why. Mutates `task` and, on "rewrite", `checkTask`; the caller saves the
 * check task first, so a task is never left waiting on a check task that stayed Completed.
 */
export function exitStaleChecks(task: WorkItem, checkTask: WorkItem | null, stale: StaleChecks): StaleChecksExit {
  const rewrites = stale.revision - 1;
  if (rewrites >= CHECK_REWRITE_BOUND) {
    requireInProgress(task, "Abandoned");
    giveUpWorkItem(task, {
      source: "checks_rewrite_bound",
      checkTaskId: stale.checkTaskId,
      revision: stale.revision,
      bound: CHECK_REWRITE_BOUND,
      reason:
        `the checks were written again ${rewrites} time(s), the bound of ${CHECK_REWRITE_BOUND}, and revision ` +
        `${stale.revision} is stale too; check task ${stale.checkTaskId} is not reopened again:\n${stale.detail}`,
    });
    return { kind: "bound" };
  }
  const reopenable = reopenableCheckTask(checkTask, stale.checkTaskId);
  if (reopenable.kind === "refused") {
    requireInProgress(task, "Abandoned");
    giveUpWorkItem(task, {
      source: "checks_stale",
      checkTaskId: stale.checkTaskId,
      reason: `${stale.detail}\nThe check task cannot be reopened: ${reopenable.why}`,
    });
    return { kind: "unreopenable", why: reopenable.why };
  }
  requireInProgress(task, "Pending");
  reopenCheckTask(
    reopenable.item,
    task.id,
    `the checks this task recorded for task ${task.id} (revision ${stale.revision}) no longer hold the red-run rule ` +
      `on the plan's foundation in the project's current environment, so they cannot decide that task; define them ` +
      `again so that each runs there to its verdict and the set keeps the held-set rule: ${heldSetRuleText(HELD_SET_RULE)} ` +
      `The red run that rejected them:\n${stale.detail}`,
    { staleRevision: stale.revision },
    { stale_revision: stale.revision },
  );
  awaitRewrittenChecks(task, stale.checkTaskId, { stale_revision: stale.revision });
  return { kind: "rewrite" };
}

/**
 * How many times an implementer may dispute the checks of one check task
 * (K = 2). A dispute past it gives the disputing task up and its plan is repaired: the
 * implementer and the check author have disagreed that often and nothing in the team settles it.
 */
const CHECK_DISPUTE_BOUND = 2;

/** An implementer's dispute of one stored check (dispute_check). */
interface CheckDispute {
  readonly checkTaskId: string;
  /** The revision of the task's checks the disputed check belongs to. */
  readonly revision: number;
  /** The disputed check as stored. */
  readonly check: { readonly name: string; readonly command: string };
  readonly reason: string;
  /** The output of the implementer's last run_checks; null when it never ran them. */
  readonly evidence: string | null;
  /** How many disputes the check task has drawn, this one included (Quality's durable record). */
  readonly disputes: number;
}

type DisputeExit =
  /** The check task is reopened (Completed -> Pending) with the dispute; the task waits on it at Pending. */
  | { readonly kind: "rewrite" }
  /** Past the bound: the task is given up with a check_disputed reason. */
  | { readonly kind: "bound"; readonly bound: number }
  /** The named check task cannot be reopened; the task is given up with a check_disputed reason. */
  | { readonly kind: "unreopenable"; readonly why: string };

/** The dispute as the check author reads it in the reopened task's brief. */
function disputeBrief(taskId: string, dispute: CheckDispute): string {
  return [
    `The implementer of task ${taskId} disputes check ${JSON.stringify(dispute.check.name)} of the checks this task ` +
      `recorded for it (revision ${dispute.revision}): it holds that the check cannot pass on correct work. Weigh the ` +
      `dispute and define the task's checks again: fix the check if the dispute is right, or keep it if it is wrong, ` +
      `so that each check can pass on correct work and the set keeps the held-set rule on the plan's foundation: ` +
      heldSetRuleText(HELD_SET_RULE),
    `The disputed check: ${JSON.stringify(dispute.check.name)}, command: ${dispute.check.command}`,
    `The implementer's reason:\n${dispute.reason}`,
    dispute.evidence === null
      ? `The implementer did not run the checks before disputing.`
      : `The implementer's last run of the checks:\n${dispute.evidence}`,
  ].join("\n\n");
}

/**
 * The exit of an InProgress implementation task whose implementer disputed one of its stored
 * checks. Not the task's failure: within the bound the check task that wrote the check is reopened
 * with the dispute in its brief and the task waits on it, as for stale checks; past the bound, or
 * with a check task that cannot be reopened, the task is given up and its plan repaired. Mutates
 * `task` and, on "rewrite", `checkTask`; the caller saves the check task first.
 */
export function exitDisputedCheck(task: WorkItem, checkTask: WorkItem | null, dispute: CheckDispute): DisputeExit {
  if (dispute.disputes > CHECK_DISPUTE_BOUND) {
    requireInProgress(task, "Abandoned");
    giveUpWorkItem(task, {
      source: "check_disputed",
      checkTaskId: dispute.checkTaskId,
      checkName: dispute.check.name,
      reason:
        `${dispute.reason}\nThe check task's checks were disputed ${dispute.disputes} time(s), past the bound of ` +
        `${CHECK_DISPUTE_BOUND}; it is not reopened again`,
    });
    return { kind: "bound", bound: CHECK_DISPUTE_BOUND };
  }
  const reopenable = reopenableCheckTask(checkTask, dispute.checkTaskId);
  if (reopenable.kind === "refused") {
    requireInProgress(task, "Abandoned");
    giveUpWorkItem(task, {
      source: "check_disputed",
      checkTaskId: dispute.checkTaskId,
      checkName: dispute.check.name,
      reason: `${dispute.reason}\nThe check task cannot be reopened: ${reopenable.why}`,
    });
    return { kind: "unreopenable", why: reopenable.why };
  }
  requireInProgress(task, "Pending");
  const why = { disputed_check: dispute.check.name, disputed_revision: dispute.revision, dispute: dispute.disputes };
  reopenCheckTask(
    reopenable.item,
    task.id,
    disputeBrief(task.id, dispute),
    { disputedCheck: dispute.check.name, disputedRevision: dispute.revision, dispute: dispute.disputes },
    why,
  );
  awaitRewrittenChecks(task, dispute.checkTaskId, why);
  return { kind: "rewrite" };
}

/** These exits are an InProgress task's alone; `to` is the status the exit about to run would write. */
function requireInProgress(task: WorkItem, to: WorkItemStatus): void {
  if (task.status !== "InProgress") throw new InvalidStatusTransition(task.id, task.status, to);
}

function reopenableCheckTask(
  checkTask: WorkItem | null,
  checkTaskId: string,
): { readonly kind: "reopenable"; readonly item: WorkItem } | { readonly kind: "refused"; readonly why: string } {
  if (checkTask === null) return { kind: "refused", why: `check task ${checkTaskId} is not on record` };
  if (checkTask.id !== checkTaskId) return { kind: "refused", why: `work item ${checkTask.id} is not check task ${checkTaskId}` };
  if (checkTask.workKind !== "check") {
    return { kind: "refused", why: `work item ${checkTask.id} is of work kind ${checkTask.workKind ?? "unrecorded"}, not check` };
  }
  if (checkTask.status !== "Completed") return { kind: "refused", why: `check task ${checkTask.id} is ${checkTask.status}, not Completed` };
  return { kind: "reopenable", item: checkTask };
}

/**
 * How many times the review of a plan revision's suites may reopen one check task:
 * once after the first review that acts on it. The count is
 * the review's durable record of the check tasks it named (suite_review_findings), never the review's
 * dispatch count, which a reopen refunds. Each check task is reopened at most once, so a revision's
 * review rounds end after at most one per check task plus the first. A review that names one again
 * with a problem that acts gives the review up and its plan is repaired; an undecided item on it does
 * not act there and stays undecided (Quality's suite review).
 */
const SUITE_REVIEW_BOUND = 1;

interface SuiteReviewFindings {
  readonly problems: readonly SuiteReviewProblem[];
  /**
   * Per check task the problems name: how many reviews have named it, this one included (Quality's
   * durable record, suite_review_findings). Every named check task has an entry.
   */
  readonly timesNamed: ReadonlyMap<string, number>;
}

type SuiteReviewExit =
  /** Each named check task is reopened (Completed -> Pending) with its problems; the review waits on them at Pending. */
  | { readonly kind: "reopened"; readonly checkTasks: readonly WorkItem[] }
  /** A named check task is past the bound: the review is given up with a suite_review_unresolved reason. */
  | { readonly kind: "bound"; readonly bound: number; readonly checkTaskId: string; readonly times: number }
  /** A named check task cannot be reopened: the review is given up with a suite_review_unresolved reason. */
  | { readonly kind: "unreopenable"; readonly why: string };

/** The review's record names a check task without its count: the record the bound is read from lies. */
class SuiteReviewCountMissing extends Error {
  constructor(
    readonly reviewTaskId: string,
    readonly checkTaskId: string,
  ) {
    super(`review task ${reviewTaskId}: the findings name check task ${checkTaskId}, but no count of reviews naming it was recorded`);
    this.name = "SuiteReviewCountMissing";
  }
}

/** The review's problems name no check task: there is nothing to send them back to, and no problem to wait on. */
class SuiteReviewNamesNoCheckTask extends Error {
  constructor(
    readonly reviewTaskId: string,
    readonly problems: number,
  ) {
    super(`review task ${reviewTaskId}: ${problems} problem(s) were found, but they name no check task`);
    this.name = "SuiteReviewNamesNoCheckTask";
  }
}

/** The check task named by every problem, once each, in the order the problems name them. */
function namedCheckTasks(problems: readonly SuiteReviewProblem[]): string[] {
  return [...new Set(problems.flatMap((problem) => problem.checkTaskIds))];
}

/**
 * Per finding kind, its label and what the check author does about it. Keyed by the whole kind
 * union so a new kind does not compile until its author is told what it asks for: an undecided
 * item asks for a check added, never for one dropped.
 */
const PROBLEM_KINDS: Readonly<Record<SuiteReviewProblem["kind"], { readonly label: string; readonly fix: string }>> = {
  contradiction: {
    label: "checks that contradict each other",
    fix: "change checks that no product could pass together with the other checks named, so that one product can pass them all",
  },
  "outside-vision": {
    label: "a check outside the task's cited vision items",
    fix: "drop or narrow a check that tests behaviour no vision item the task cites asks for",
  },
  "undecided-item": {
    label: "a cited item no check decides",
    fix: "add a check that decides a cited item no check decides: a product that does not do what the item states fails it",
  },
  "breaks-contract": {
    label: "a check that requires what a cited item rules out",
    fix:
      "change a check that requires what a cited guarantee lists as refuting it, or the opposite of a cited assumption, " +
      "so that a product keeping the promise passes it, whatever the task's own lines say",
  },
};

/**
 * The review's problems as the check author reads them in its reopened task's brief. A check task
 * is reopened by a review only once (SUITE_REVIEW_BOUND), so no earlier review's findings on it are
 * ever left to brief.
 */
function reviewBrief(checkTaskId: string, problems: readonly SuiteReviewProblem[]): string {
  const own = problems.filter((problem) => problem.checkTaskIds.includes(checkTaskId));
  const fixes = [...new Set(own.map((problem) => problem.kind))].map((kind) => PROBLEM_KINDS[kind].fix);
  return [
    `A review of every check this plan's check tasks wrote, read together with the vision before any of the work ` +
      `started, found problems with the checks this task recorded. Define the task's checks again so that none of ` +
      `these remains: ${fixes.join("; ")}. Keep every check that is not part of a problem.`,
    ...own.map((problem, i) => {
      const others = problem.checkTaskIds.filter((id) => id !== checkTaskId);
      return [
        `Problem ${i + 1} (${PROBLEM_KINDS[problem.kind].label}): ${problem.problem}`,
        others.length > 0 ? `It also involves the checks of check task(s) ${others.join(", ")}.` : "",
        `Evidence: ${problem.evidence}`,
      ]
        .filter((line) => line !== "")
        .join("\n");
    }),
  ].join("\n\n");
}

/**
 * The exit of an InProgress review task whose review found problems. Past the bound for any named
 * check task, or when a named check task cannot be reopened (missing, not a Completed check task,
 * deciding no task), the review is given up and its plan repaired; otherwise every named check
 * task is reopened with its problems in its brief and the
 * review returns to Pending, where its dependencies on them hold it until they complete again and
 * it reviews the new suites. Mutates `review` and, on "reopened", each check task; the caller saves
 * the check tasks first, so the review is never left waiting on a check task that stayed Completed.
 */
export function exitSuiteReview(
  review: WorkItem,
  checkTasks: ReadonlyMap<string, WorkItem | null>,
  findings: SuiteReviewFindings,
): SuiteReviewExit {
  if (review.status !== "InProgress" || !canTransitionTo(review.status, "Pending")) {
    throw new InvalidStatusTransition(review.id, review.status, "Pending");
  }
  const named = namedCheckTasks(findings.problems);
  if (named.length === 0) throw new SuiteReviewNamesNoCheckTask(review.id, findings.problems.length);
  const problemsText = findings.problems.map((p) => `- [${p.checkTaskIds.join(", ")}] ${p.problem} (evidence: ${p.evidence})`).join("\n");
  for (const checkTaskId of named) {
    const times = findings.timesNamed.get(checkTaskId);
    if (times === undefined) throw new SuiteReviewCountMissing(review.id, checkTaskId);
    if (times > SUITE_REVIEW_BOUND) {
      giveUpWorkItem(review, {
        source: "suite_review_unresolved",
        checkTaskIds: named,
        reason:
          `the review of the plan's checks found problems:\n${problemsText}\nReviews have named check task ${checkTaskId} ` +
          `${times} time(s), past the bound of ${SUITE_REVIEW_BOUND}; it is not reopened again`,
      });
      return { kind: "bound", bound: SUITE_REVIEW_BOUND, checkTaskId, times };
    }
  }
  const reopenable: Array<{ readonly item: WorkItem; readonly checkedTaskId: string }> = [];
  const refused: string[] = [];
  for (const checkTaskId of named) {
    const found = reopenableCheckTask(checkTasks.get(checkTaskId) ?? null, checkTaskId);
    if (found.kind === "refused") refused.push(found.why);
    else if (found.item.taskSpec?.checksFor === undefined) refused.push(`check task ${checkTaskId} decides no implementation task (task_spec.checksFor)`);
    else reopenable.push({ item: found.item, checkedTaskId: found.item.taskSpec.checksFor });
  }
  if (refused.length > 0) {
    const why = refused.join("; ");
    giveUpWorkItem(review, {
      source: "suite_review_unresolved",
      checkTaskIds: named,
      reason: `the review of the plan's checks found problems:\n${problemsText}\nThey cannot be sent back to their check tasks: ${why}`,
    });
    return { kind: "unreopenable", why };
  }
  for (const { item, checkedTaskId } of reopenable) {
    const times = findings.timesNamed.get(item.id);
    reopenCheckTask(
      item,
      checkedTaskId,
      reviewBrief(item.id, findings.problems),
      { reviewTaskId: review.id, reviewed: times },
      { review_task_id: review.id, review: times },
    );
  }
  review.status = "Pending";
  review.blockedReason = undefined;
  review.updatedAt = new Date();
  review.events.push(
    createDomainEvent("work_item.awaiting_checks", "delivery", {
      work_item_id: review.id,
      level: review.level,
      check_task_ids: named,
      review_problems: findings.problems.length,
    }),
  );
  return { kind: "reopened", checkTasks: reopenable.map(({ item }) => item) };
}
