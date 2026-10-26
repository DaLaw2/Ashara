import { PreCallRefusal, modelCallAbortedOf, modelCallFailureOf } from "@ashara/finance";
import type { Logger } from "@ashara/shared";
import { describeErrorChain, wrapError } from "@ashara/shared";
import { NO_AGENT, environmentBlocked, failedBeforeAgent, thrownBlocked } from "../dispatch-result.js";
import type { ExecutionEventSink, ExecutionResult, VerifiedTask } from "../dispatch-result.js";
import type { SuiteReviewOutcome, SuiteReviewing } from "../suite-review.js";

/** The PreCallRefusal anywhere in the error's cause chain, or null when no model call was refused. */
function preCallRefusalOf(e: unknown): PreCallRefusal | null {
  for (let current: unknown = e; current instanceof Error; current = current.cause) {
    if (current instanceof PreCallRefusal) return current;
  }
  return null;
}

export interface SuiteReviewRunDeps {
  /**
   * Quality's review of a plan revision's suites: a review task is
   * dispatched to it, never to an agent, so it runs no cell. Required: no implementation is released
   * without it.
   */
  readonly suiteReview: SuiteReviewing;
  readonly eventSink?: ExecutionEventSink;
  readonly logger: Logger;
}

/** A review task's dispatch: the suite review run and its outcome read as the dispatch's result. */
export class SuiteReviewRun {
  private readonly deps: SuiteReviewRunDeps;

  constructor(deps: SuiteReviewRunDeps) {
    this.deps = deps;
  }

  /**
   * The review of the plan revision's suites. Clean only once the model's
   * verdict validated against its schema and names only suites it read: the plan's implementations
   * are released by completing it. Problems are returned for Delivery to route. A refused
   * model call is a refusal like an agent's; a verdict that never validated or is unfit to act on
   * fails the review; a provider's failure or Ashara's own (an unreadable suite, a store, its code)
   * blocks it under that class. Nothing is released on any of them.
   */
  async reviewSuites(task: VerifiedTask, sessionId: string, targetProjectPath: string): Promise<ExecutionResult> {
    let outcome: SuiteReviewOutcome;
    try {
      outcome = await this.deps.suiteReview.review(task, targetProjectPath);
    } catch (e) {
      return this.reviewThrew(task, sessionId, e);
    }
    return this.reviewed(task, sessionId, outcome);
  }

  /** A review that threw: interrupted, refused, failed as the review's own work, or blocked under the fault's class. */
  private reviewThrew(task: VerifiedTask, sessionId: string, e: unknown): ExecutionResult {
    const { eventSink } = this.deps;
    // The shutdown stopped the review's model call: nothing was judged, so nothing failed or is blocked.
    const aborted = modelCallAbortedOf(e);
    if (aborted !== null) {
      const summary = `the review of the plan's checks for ${task.id} was interrupted by shutdown: ${aborted.message}; nothing was reviewed`;
      this.deps.logger.info("quality.suite-review-interrupted", summary, { taskId: task.id, attempt: task.attempt });
      return {
        status: "interrupted",
        detail: summary,
        outcome: null,
        sessionId,
        attempt: task.attempt,
        errorEnvelope: { outcome: "blocked", summary, chain: wrapError("development", "reviewSuites", e, { taskId: task.id }) },
      };
    }
    const refusal = preCallRefusalOf(e);
    if (refusal !== null) {
      const summary = `the review of the plan's checks for ${task.id} stopped at a refused model call: ${refusal.message}; nothing was reviewed`;
      return {
        status: "refused",
        refusal,
        detail: summary,
        outcome: null,
        sessionId,
        attempt: task.attempt,
        errorEnvelope: { outcome: "blocked", summary, chain: wrapError("development", "reviewSuites", e, { taskId: task.id }) },
      };
    }
    // Only the review model's own failure is the review's (a verdict that never validated, or one
    // unfit to act on), retried as its work. A provider's failure, or Ashara's (its records, git on
    // the host, a store, its code), says nothing of the suites: blocked under its class, uncharged.
    const failure = modelCallFailureOf(e);
    if (failure === "model") {
      const result = failedBeforeAgent(task, sessionId, "reviewSuites", e, `the review of the plan's checks for ${task.id} gave no verdict`);
      eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason: result.detail });
      return result;
    }
    if (failure === "provider") {
      const errorClass = e instanceof Error ? e.name : typeof e;
      return environmentBlocked(
        {
          task,
          sessionId,
          stage: "reviewSuites",
          fault: "provider",
          errorClass,
          message: `the review of the plan's checks for ${task.id} gave no verdict: ${describeErrorChain(e)}`,
          chain: wrapError("development", "reviewSuites", e, { taskId: task.id, errorClass }),
          unavailable: "model provider (suite review)",
          ...NO_AGENT,
        },
        eventSink,
        this.deps.logger,
      );
    }
    return thrownBlocked({ task, sessionId, stage: "reviewSuites", error: e, where: { step: "review the plan's checks", cell: "no cell" }, agent: NO_AGENT, eventSink, logger: this.deps.logger });
  }

  /** The review's outcome as the dispatch's result: clean, releasing the plan's implementations, or its problems to route. */
  private reviewed(task: VerifiedTask, sessionId: string, outcome: SuiteReviewOutcome): ExecutionResult {
    const { eventSink } = this.deps;
    const setAside = outcome.setAside.length === 0 ? "" : `; set aside the abandoned check task(s) ${outcome.setAside.join(", ")}`;
    // A rejection the second review did not reach is released; both judgements are recorded whole
    // by the reviewer (suite_review_judgements) before this outcome exists.
    const released =
      outcome.released.length === 0
        ? ""
        : `\nReleased as passing review, the two reviews disagreeing:\n` +
          outcome.released
            .map(
              (r) =>
                `- check ${JSON.stringify(r.check)} of ${r.checkTaskId}: the first review judged ${r.first}; the second, ${r.secondReview}, ` +
                (r.second.length === 0 ? "found no problem in that check task" : `judged ${r.second.join("; ")}`),
            )
            .join("\n");
    const releasedChecks = outcome.released.map((r) => `${r.checkTaskId}: ${r.check}`);
    // A finding with neither a witness nor another family's agreement reopens nothing; it is kept
    // as advisory, and an item it leaves undecided is reported unverified.
    const advisory =
      (outcome.advisory.length === 0
        ? ""
        : `\nKept as advisory, acting on nothing:\n` + outcome.advisory.map((a) => `- [${a.kind}; ${a.checkTaskIds.join(", ")}] ${a.finding} (${a.why})`).join("\n")) +
      (outcome.undecided.length === 0
        ? ""
        : `\nLeft undecided, to be reported unverified: ${outcome.undecided.map((u) => `${u.itemId} of ${u.checkTaskId}`).join(", ")}`);
    if (outcome.kind === "clean") {
      // A review that routes nothing is a claim a second opinion confirms or not:
      // the items it leaves unconfirmed are reported unverified.
      const { claim } = outcome;
      const claimed =
        claim.unconfirmed.length === 0
          ? `\nEvery item the suites cite and no finding left undecided reads as verified: ${claim.why}`
          : `\nNot verified, to be reported unverified (${claim.why}): ${claim.unconfirmed.map((u) => `${u.itemId} of ${u.checkTaskId}`).join(", ")}`;
      const detail = `the review read the suites of ${outcome.reviewed.length} check task(s) with the vision and found no problem that acts${setAside}${released}${advisory}${claimed}`;
      this.deps.logger.info("quality.suites-reviewed", detail, {
        taskId: task.id,
        attempt: task.attempt,
        reviewed: outcome.reviewed,
        setAside: outcome.setAside,
        released: releasedChecks,
        advisory: outcome.advisory.length,
        undecided: outcome.undecided.length,
        claim: claim.unconfirmed.length === 0 ? "verified" : "unverified",
        claimWhy: claim.why,
      });
      eventSink?.emit({ event: "suites_reviewed", taskId: task.id, attempt: task.attempt, reviewed: outcome.reviewed, setAside: outcome.setAside, released: releasedChecks });
      return {
        status: "completed",
        delivered: { kind: "suites-reviewed", reviewed: outcome.reviewed },
        detail,
        outcome: null,
        sessionId,
        attempt: task.attempt,
      };
    }
    const named = [...new Set(outcome.problems.flatMap((problem) => problem.checkTaskIds))];
    const summary =
      `the review read the suites of ${outcome.reviewed.length} check task(s) with the vision and found ` +
      `${outcome.problems.length} problem(s) in the checks of ${named.join(", ")}${setAside}:\n` +
      outcome.problems.map((p) => `- [${p.kind}; ${p.checkTaskIds.join(", ")}] ${p.problem}`).join("\n") +
      released +
      advisory;
    this.deps.logger.info("quality.suite-review-problems", summary, { taskId: task.id, attempt: task.attempt, checkTasks: named, problems: outcome.problems.length });
    eventSink?.emit({ event: "suite_review_problems", taskId: task.id, attempt: task.attempt, checkTasks: named, problems: outcome.problems.length, released: releasedChecks });
    return {
      status: "suite_review_problems",
      problems: outcome.problems,
      detail: summary,
      outcome: null,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: { outcome: "blocked", summary, chain: wrapError("development", "reviewSuites", summary, { taskId: task.id, checkTasks: named }) },
    };
  }
}
