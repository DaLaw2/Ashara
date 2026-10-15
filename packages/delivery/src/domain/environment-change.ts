import { InvalidStatusTransition, canTransitionTo, createDomainEvent } from "@ashara/shared";
import type { WorkItem } from "./work-item.js";
import { createPendingWorkItem, giveUpWorkItem } from "./work-item.js";

/**
 * How many environment tasks Z0 opens for one implementation task (ADR-074 addendum 2 d66 b;
 * design call, overrulable). A request past it gives the implementation up and its plan is
 * repaired: the implementer and the platform role have gone round that often and nothing in the
 * team settles it.
 */
const ENVIRONMENT_CHANGE_BOUND = 2;

/** An implementer's finished work that changed environment recipe files, as Z0 refused it. */
interface EnvironmentChangeRequest {
  /** The recipe files the implementation's branch changed. */
  readonly paths: readonly string[];
  /** The implementer's own statement of what it needs (its finish summary). */
  readonly need: string;
  /** The branch's diff of those files; a cut is marked by its producer. */
  readonly diff: string;
  /** Z0's refusal, for the record. */
  readonly detail: string;
}

/** What the implementation's history and the project's roster say about a new environment task. */
interface EnvironmentChangeContext {
  /** Environment tasks already opened for this implementation task (its dependencies of that origin). */
  readonly opened: number;
  /** The roster role doing the project's environment work, or why there is none. */
  readonly owner: { readonly kind: "role"; readonly roleId: string } | { readonly kind: "none"; readonly why: string };
  /**
   * Whether the project's product scaffold has completed (d72 B2). Required: an environment task
   * opened before it (the scaffold itself asking) lands on a main with no product to build or test.
   */
  readonly product: "present" | "absent";
}

type EnvironmentChangeExit =
  /** `environment` is a new Pending environment task; the implementation waits on it at Pending. */
  | { readonly kind: "opened"; readonly environment: WorkItem }
  /** The implementation is given up with an environment_change_needed reason: past the bound. */
  | { readonly kind: "bound"; readonly bound: number }
  /** The implementation is given up with an environment_change_needed reason: no owner. */
  | { readonly kind: "unowned"; readonly why: string };

/** The environment task's goal and scope as the platform role's brief states them. */
function environmentTaskSpec(
  task: WorkItem,
  request: EnvironmentChangeRequest,
  ordinal: number,
  product: EnvironmentChangeContext["product"],
): NonNullable<WorkItem["taskSpec"]> {
  return {
    goal: `Change the project environment as the implementation task "${task.title}" (${task.id}) needs`,
    endState:
      `The environment's recipe provides what that task needs, its image builds and its probe passes, and its ` +
      `statement says what changed and why. This is environment change ${ordinal} requested for that task.`,
    scope: [
      `The implementer of task ${task.id} changed recipe files, which only environment work may change; nothing of ` +
        `its work was merged. Decide what of its request the recipe should provide and make that change: you may ` +
        `change it, make it differently, or make less than asked when the request is wrong for the project. Change ` +
        `recipe files only: whatever of the request is product (source, manifests, tests, data) is the implementer's ` +
        `to write, and an input the image build should read is named in the definition's inputs. Its task starts ` +
        `again from the project as you leave it.`,
      `The implementer's statement of what it needs:\n${request.need}`,
      `Its diff of the recipe (${request.paths.join(", ")}):\n${request.diff.trim() === "" ? "(empty)" : request.diff}`,
    ].join("\n\n"),
    deliverables: [`the recipe changed as the request needs, with build_environment reporting PASSED`],
    // A fixed level, Sprint 0's (ADR-074 addendum 2 d70): no planner sees this task, and changing the
    // recipe every later task builds on is environment work of the same kind.
    capability: "Strong",
    origin: "environment-change",
    checkedBy: "substrate",
    product,
  };
}

/**
 * The exit of an InProgress implementation task whose finished work changed environment recipe
 * files (ADR-074 addendum 2 d66 b, d72 B1). Not the task's failure: within the bound a new
 * environment task, owned by the role doing environment work, is opened with the implementer's
 * need and diff, and the implementation returns to Pending waiting on it; the caller persists the
 * new task, the implementation's dependency on it and the implementation in one transaction. Past
 * the bound, or with no role to own it, the implementation is given up and its plan repaired.
 */
export function requestEnvironmentChange(
  task: WorkItem,
  request: EnvironmentChangeRequest,
  context: EnvironmentChangeContext,
): EnvironmentChangeExit {
  if (task.status !== "InProgress") throw new InvalidStatusTransition(task.id, task.status, "Pending");
  if (context.opened >= ENVIRONMENT_CHANGE_BOUND) {
    giveUpWorkItem(task, {
      source: "environment_change_needed",
      paths: [...request.paths],
      reason:
        `the implementer needs a change to the environment recipe again, after ${context.opened} environment task(s) were ` +
        `opened for this task, the bound of ${ENVIRONMENT_CHANGE_BOUND}; no further one is opened. Its need:\n` +
        `${request.need}\n${request.detail}`,
    });
    return { kind: "bound", bound: ENVIRONMENT_CHANGE_BOUND };
  }
  if (context.owner.kind === "none") {
    giveUpWorkItem(task, {
      source: "environment_change_needed",
      paths: [...request.paths],
      reason: `the implementer needs a change to the environment recipe, but no environment task can be opened: ${context.owner.why}\n${request.detail}`,
    });
    return { kind: "unowned", why: context.owner.why };
  }
  if (!canTransitionTo(task.status, "Pending")) throw new InvalidStatusTransition(task.id, task.status, "Pending");

  const ordinal = context.opened + 1;
  const environment = createPendingWorkItem(
    "Task",
    // Unique per request: the gate counts a Completed item with the same parent and title as done.
    `Environment change ${ordinal} for task ${task.id}`,
    task.projectId,
    task.parentId,
    `Requested by implementation task ${task.id}: ${request.paths.join(", ")}`,
    environmentTaskSpec(task, request, ordinal, context.product),
  );
  environment.workKind = "environment";
  environment.ownerRoleId = context.owner.roleId;
  environment.events.push(
    createDomainEvent("work_item.created", "delivery", {
      work_item_id: environment.id,
      level: environment.level,
      origin: "environment-change",
      requested_by: task.id,
    }),
  );

  task.status = "Pending";
  task.blockedReason = undefined;
  task.updatedAt = new Date();
  task.events.push(
    createDomainEvent("work_item.awaiting_environment", "delivery", {
      work_item_id: task.id,
      level: task.level,
      environment_task_id: environment.id,
      environment_change: ordinal,
      paths: [...request.paths],
    }),
  );
  return { kind: "opened", environment };
}
