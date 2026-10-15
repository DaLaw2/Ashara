import type { ProjectId, WorkItemId } from "@ashara/shared";
import type { CapabilityLevel, ResolvedModel } from "./acl/finance-acl.js";
import { RoleNotInRoster, RosterUnreadable, parseStoredRoster, roleInRoster } from "./acl/organization-acl.js";
import type { AgentStaffing, TaskDescriptor } from "./dispatch/dispatch-service.js";

type Staffing = Awaited<ReturnType<AgentStaffing["staff"]>>;

/**
 * A task reached dispatch with no capability level on its stored spec. Every producer sets one
 * (ADR-074 addendum 2 d70: the planner grades a decomposed task, and sets a fixed level on every
 * task it adds), so its absence is a row written before grading or by a producer that skipped it.
 * Dispatch fails rather than assuming a level the planner never chose.
 */
class TaskCapabilityUngraded extends Error {
  constructor(
    readonly taskId: WorkItemId,
    readonly origin: string | undefined,
  ) {
    super(
      `task ${taskId} (origin ${origin ?? "unrecorded"}) carries no capability level in its task_spec: ` +
        `no model can be chosen for it, so it is not dispatched`,
    );
    this.name = "TaskCapabilityUngraded";
  }
}

/** The capability an attempt is dispatched at: the task's stored grade, on every attempt. */
export function gradedCapability(task: TaskDescriptor): CapabilityLevel {
  const graded = task.taskSpec?.capability;
  if (graded === undefined) throw new TaskCapabilityUngraded(task.id, task.taskSpec?.origin);
  return graded;
}

/** The work item's stored owner: absent when the row is gone, null when it has no owner. */
type StoredOwner = { readonly kind: "absent" } | { readonly kind: "found"; readonly ownerRoleId: string | null };

interface StaffingDeps {
  readonly ownerOf: (taskId: WorkItemId) => Promise<StoredOwner>;
  /** The roster_roles rows of the project's latest revision, unparsed. */
  readonly latestRosterRows: (projectId: ProjectId) => Promise<unknown>;
  /** The project's latest roster revision; null when it has none. */
  readonly latestRosterRevision: (projectId: ProjectId) => Promise<number | null>;
  /** The attempt's model; throws when none can be resolved, which fails the dispatch. */
  readonly resolveModel: (task: TaskDescriptor) => ResolvedModel;
}

/**
 * Staffs each attempt with the work item's owner role, read from Organization's latest stored
 * roster (s-team-roster-m1): an item without an owner, or whose owner the roster does not hold
 * (or whose roster cannot be read), is owner-unresolved and blocks. No default role exists.
 */
export function createAgentStaffing(deps: StaffingDeps): AgentStaffing {
  return {
    async staff(task): Promise<Staffing> {
      // Read before the rows, so the revision recorded is never newer than the roster judged.
      const rosterRevision = await deps.latestRosterRevision(task.projectId);
      const owner = await deps.ownerOf(task.id);
      if (owner.kind === "absent") {
        return { kind: "owner-unresolved", ownerRoleId: null, rosterRevision, reason: "the work item row is gone" };
      }
      const { ownerRoleId } = owner;
      if (ownerRoleId === null) {
        return { kind: "owner-unresolved", ownerRoleId, rosterRevision, reason: "the work item has no owner role" };
      }
      const rows = await deps.latestRosterRows(task.projectId);
      try {
        const role = roleInRoster(parseStoredRoster(task.projectId, rows), ownerRoleId);
        return { kind: "staffed", staff: { role: { id: role.id, name: role.name }, model: deps.resolveModel(task) } };
      } catch (err) {
        if (!(err instanceof RosterUnreadable || err instanceof RoleNotInRoster)) throw err;
        return { kind: "owner-unresolved", ownerRoleId, rosterRevision, reason: err.message };
      }
    },
  };
}
