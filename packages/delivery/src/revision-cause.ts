import type { ProjectId } from "@ashara/shared";
import type { PlanningVision } from "./acl/engagement-acl.js";
import type { AbandonedTask, CorrectionRequest, ProjectAwaitingReplan, RevisionCause } from "./replan-port.js";
import { blockedReasonToRecord } from "./work-item-language/blocked-reason.js";
import type { StoredBlockedReason } from "./work-item-language/blocked-reason.js";

/** The cause a given-up task records: any but a plan revision's supersession. */
type GivenUpReason = Exclude<StoredBlockedReason, { readonly source: "superseded" }>;

/** The store listed a project awaiting a revision that neither a client correction nor a repair asks for. */
export class RevisionUnasked extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`project ${projectId}: listed as awaiting a plan revision, but no client correction and no given-up task asks for one`);
    this.name = "RevisionUnasked";
  }
}

/** An awaited repair names a task that is not an Abandoned task of the project given up for a recorded cause. */
export class RepairSubjectUnreadable extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly taskId: string,
    readonly detail: string,
  ) {
    super(`project ${projectId}: a plan repair is awaited for task ${taskId}, but ${detail}`);
    this.name = "RepairSubjectUnreadable";
  }
}

/** What a given-up task's blocked_reason recorded of why, for the planner; prefixed by the cause. */
function givenUpEvidence(reason: GivenUpReason): string {
  switch (reason.source) {
    case "failure_given_up": {
      const lastFailure = reason.lastFailure === undefined ? [] : [`Last failure: ${JSON.stringify(reason.lastFailure)}`];
      const detail = reason.detail === undefined ? [] : [reason.detail];
      return [`Its attempts were spent: ${reason.reason}`, ...detail, ...lastFailure].join("\n");
    }
    case "replan":
      return `Given up after a failed attempt: ${reason.replanContext.detail}`;
    case "api":
      return `Given up by an operator: ${JSON.stringify(blockedReasonToRecord(reason))}`;
    case "environment_unavailable":
      return `The machines it ran on kept failing (${reason.unavailable}): ${reason.reason}`;
    case "checks_stale":
    case "checks_rewrite_bound":
      return `Its checks no longer hold on the project's environment: ${reason.reason}`;
    case "check_disputed":
      return `Its implementer disputed check ${JSON.stringify(reason.checkName)} past what the team settles: ${reason.reason}`;
    case "suite_review_unresolved":
      return `The review of the plan's checks kept finding problems: ${reason.reason}`;
    case "environment_change_needed":
      return `It needs an environment change (${reason.paths.join(", ")}) the team could not make for it: ${reason.reason}`;
    case "dependency_unsatisfiable":
      return `It depends on work that can never complete: ${reason.reason}`;
    case "environment_undefined":
      return `The project's environment on main is not one its cells can be built from: ${reason.reason}`;
    case "owner_unresolved":
      return `No role of the team's roster could be assigned it (owner ${reason.ownerRoleId ?? "none"}): ${reason.reason}`;
    case "acceptance_failed":
      return (
        `Every task of the plan was done, but the acceptance run on main ` +
        `(${reason.mainCommit === null ? "main could not be read" : `commit ${reason.mainCommit}`}) of the ` +
        `environment's test and every completed task's checks did not pass, or could not be carried out:\n${reason.reason}`
      );
    case "orphan_unreconciled":
      return `Ashara's own machinery could not settle it after a restart (${reason.step}): ${reason.reason}`;
    case "work_budget_spent":
      return `It drew every model request its work budget holds (${reason.drawnRequests} of ${reason.budgetRequests}): ${reason.reason}`;
    case "context_window_exceeded":
      return (
        `A turn of its work did not fit the ${reason.windowTokens}-token context window of ${reason.provider}/${reason.model}` +
        `${reason.projectedInputTokens === null ? "" : ` (a projected input of ${reason.projectedInputTokens} tokens)`}, ` +
        `and no model graded for it has a larger one: ${reason.reason}`
      );
    case "no_wider_model":
      return (
        `An attempt of its work overflowed a ${reason.overflowedWindowTokens}-token context window, ` +
        `and no model graded for it now has a larger one: ${reason.reason}`
      );
    case "crash_loop":
      return `Ashara's process died while it was in progress at ${reason.boots} startups in a row, so it is not dispatched again: ${reason.reason}`;
    case "task_failed":
    case "orchestrator_error":
    case "merge_unrecorded":
    case "correction_pending":
      return reason.reason;
  }
}

/** The given-up tasks a repair answers, with what their blocked_reason recorded of why. */
function abandonedOf(project: ProjectAwaitingReplan): AbandonedTask[] {
  return project.repairsAwaited.map((id) => {
    const planned = project.items.find(({ item }) => item.id === id);
    if (planned === undefined) throw new RepairSubjectUnreadable(project.projectId, id, "it is not a work item of the project");
    const { item } = planned;
    const reason = item.blockedReason;
    if (item.status !== "Abandoned" || reason === undefined || reason.source === "superseded") {
      throw new RepairSubjectUnreadable(project.projectId, id, `it is ${item.status} with ${reason?.source ?? "no"} blocked reason, not given up`);
    }
    return {
      id,
      title: item.title,
      attempts: reason.source === "failure_given_up" ? (reason.attempts ?? item.dispatchCount) : item.dispatchCount,
      evidence: givenUpEvidence(reason),
    };
  });
}

/**
 * The client's corrections come first: their revision waits only for the work they touch, where a
 * repair's waits for every task. Every correction awaiting a revision is taken in by this one, each a
 * change on record; a repair still awaited is planned by the next.
 */
export function causeOf(project: ProjectAwaitingReplan): RevisionCause {
  const [first, ...rest] = project.correctionsAwaited;
  if (first !== undefined) return { kind: "client-change", changes: [first, ...rest] };
  if (project.repairsAwaited.length === 0) throw new RevisionUnasked(project.projectId);
  return { kind: "repair", abandoned: abandonedOf(project) };
}

/** Every key the corrections affect, each once, in the order first named. */
export function affectedKeys(changes: readonly CorrectionRequest[]): string[] {
  return [...new Set(changes.flatMap((change) => change.affected))];
}

/** What work now proceeds on after a correction: each item it affects as the vision now states it, or that it is withdrawn. */
export function decisionOf(change: CorrectionRequest, vision: PlanningVision): string {
  return change.affected
    .map((key) => {
      const item = vision.items.find((each) => each.id === key);
      return item === undefined ? `${key} is withdrawn.` : item.text;
    })
    .join("\n");
}
